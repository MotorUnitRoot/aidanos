// Sync worker. The accept thread keeps the sockets and the token.
// This thread owns the repo, the storage adapter, and the markdown mirror.
import path from "node:path";
import { performance } from "node:perf_hooks";
import { parentPort, workerData } from "node:worker_threads";
import { formatWithOptions } from "node:util";
import * as Automerge from "@automerge/automerge";
import { next as AutomergeNext } from "@automerge/automerge/slim";
import { Repo, NetworkAdapter } from "@automerge/automerge-repo";
import { decode, encode } from "@automerge/automerge-repo/helpers/cbor.js";
import { NodeFSStorageAdapter } from "@automerge/automerge-repo-storage-nodefs";
import { createLogBudget, frameToTransfer, writeInflight, writeSlot } from "./channel.mjs";
import { INDEX_ID } from "./ids.mjs";
import {
  beginFrame,
  beginIndexRequest,
  finishIndexReply,
  installIndexTrace,
  watchRepo,
  traceStorage,
} from "./index-trace.mjs";
import { createMirror, discardOpenNoteTemps, rememberVaultRoot, replaceNoteAtomic, saveNoteFile } from "./mirror.mjs";
import { logSafe, redact } from "./redact.mjs";
import { SafeStorage, refuseSymlinkedStorage, storageFolderFault, sweepDeadStorageTemps } from "./storage-safe.mjs";

function cpuSpin(ms) {
  const end = performance.now() + ms;
  let n = 0;
  while (performance.now() < end) n = (n + 1) % 1000003;
  return n;
}

const INDEX_TYPES = new Set(["request", "sync", "doc-unavailable"]);

function warmSyncEngine() {
  const local = AutomergeNext.init();
  const remote = AutomergeNext.init();
  let localState = AutomergeNext.initSyncState();
  let remoteState = AutomergeNext.initSyncState();
  const generated = AutomergeNext.generateSyncMessage(local, localState);
  localState = generated[0];
  const request = generated[1];
  if (!request) return;
  Automerge.decodeSyncMessage(request);
  const received = AutomergeNext.receiveSyncMessage(remote, remoteState, request);
  remoteState = received[1];
  const reply = AutomergeNext.generateSyncMessage(received[0], remoteState);
  if (reply[1]) AutomergeNext.receiveSyncMessage(local, localState, reply[1]);
  AutomergeNext.decodeSyncState(AutomergeNext.encodeSyncState(localState));
}

function post(message, transfer) {
  parentPort.postMessage(message, transfer || []);
}

function savedBinary(doc) {
  if (!doc) return null;
  const saved = Automerge.save(doc);
  return frameToTransfer(saved);
}

class ParentAdapter extends NetworkAdapter {
  constructor() {
    super();
    this.repo = null;
    this.byConn = new Map();
    this.byPeer = new Map();
    this.#ready = false;
    this.#readyPromise = new Promise((resolve) => {
      this.#readyResolver = resolve;
    });
  }

  #ready;
  #readyResolver;
  #readyPromise;

  isReady() {
    return this.#ready;
  }

  whenReady() {
    return this.#readyPromise;
  }

  connect(peerId, peerMetadata) {
    this.peerId = peerId;
    this.peerMetadata = peerMetadata;
    if (!this.#ready) {
      this.#ready = true;
      this.#readyResolver();
    }
  }

  disconnect() {
    this.emit("close");
  }

  send(message) {
    if (!message || message.targetId == null) return;
    const conn = this.byPeer.get(message.targetId);
    if (conn == null) return;
    let encoded;
    try {
      encoded = encode(message);
    } catch {
      return;
    }
    const copy = frameToTransfer(encoded);
    if (!copy) return;
    const docId = typeof message.documentId === "string" ? message.documentId : "";
    if (docId === INDEX_ID && INDEX_TYPES.has(message.type)) finishIndexReply();
    post({ v: 1, kind: "msg", conn, data: copy }, [copy]);
  }

  open(conn, peerId, metadata) {
    if (!peerId) return;
    const previous = this.byPeer.get(peerId);
    if (previous != null && previous !== conn) {
      this.emit("peer-disconnected", { peerId });
    }
    this.byConn.set(conn, peerId);
    this.byPeer.set(peerId, conn);
    this.emit("peer-candidate", { peerId, peerMetadata: metadata || null });
  }

  inbound(conn, data) {
    const peerId = this.byConn.get(conn);
    if (!peerId) return;
    let message;
    try {
      message = decode(Buffer.from(data));
    } catch {
      return;
    }
    if (!message || typeof message !== "object") return;
    if (message.senderId && message.senderId !== peerId) return;
    const docId = typeof message.documentId === "string" ? message.documentId : "";
    // A multi-megabyte flood is not decoded as an Automerge sync message here.
    // The repo catches a bad payload. Heads stay off this path.
    if (docId) beginFrame(docId);
    if (docId === INDEX_ID && INDEX_TYPES.has(message.type)) beginIndexRequest(this.repo);
    this.emit("message", message);
  }

  closeConn(conn) {
    const peerId = this.byConn.get(conn);
    if (!peerId) return;
    this.byConn.delete(conn);
    if (this.byPeer.get(peerId) === conn) {
      this.byPeer.delete(peerId);
      this.emit("peer-disconnected", { peerId });
    }
  }
}

async function preloadStoredNotes(repo) {
  const storage = repo.storageSubsystem;
  if (!storage || typeof storage.loadDoc !== "function") return;
  const index = await storage.loadDoc(INDEX_ID);
  if (!index) return;
  await repo.find(INDEX_ID);
  const paths = index.paths && typeof index.paths === "object" ? index.paths : {};
  for (const id of Object.values(paths)) {
    if (typeof id !== "string" || !id) continue;
    const stored = await storage.loadDoc(id);
    if (!stored) continue;
    await repo.find(id);
  }
}

function bytesOf(binary) {
  if (!binary) return null;
  if (binary instanceof Uint8Array) return binary;
  if (binary instanceof ArrayBuffer) return new Uint8Array(binary);
  if (ArrayBuffer.isView(binary)) return new Uint8Array(binary.buffer, binary.byteOffset, binary.byteLength);
  return null;
}

async function run() {
  const data = workerData || {};
  const test = process.env.NODE_ENV === "test" && data.test ? data.test : null;
  const slot = data.slot;
  let busyUsed = false;
  let oomUsed = false;
  let badUsed = false;
  const queue = [];
  let draining = false;
  let stopped = false;
  let readyForWork = false;
  // Attach this before anything is posted. The parent can send as soon as it
  // sees "ready", and a message that arrives earlier must not be dropped.
  const logBudget = createLogBudget();
  parentPort.on("message", (msg) => {
    if (msg && msg.kind === "ping") {
      if (!(test && test.hang && readyForWork)) post({ v: 1, kind: "pong" });
      return;
    }
    // Acknowledgements have to land while sync work is queued. Otherwise a
    // busy worker would keep counting lines the parent has already taken.
    if (msg && msg.kind === "log-ack") {
      const notice = logBudget.ack(msg.bytes);
      if (notice) {
        try {
          post({ v: 1, kind: "log", line: notice });
        } catch {
          logBudget.unsent(notice);
        }
      }
      return;
    }
    // A timed-out save wait has to drop temps this thread still holds, even
    // while a save is awaiting. Queuing this behind that save would miss it.
    if (msg && msg.kind === "discard-temps") {
      discardOpenNoteTemps().then(
        () => post({ v: 1, kind: "temps-discarded" }),
        () => post({ v: 1, kind: "temps-discarded" }),
      );
      return;
    }
    queue.push(msg);
    if (readyForWork) drain();
  });
  console.error = (...args) => {
    // Same scrubber and 8 KB line cap as the accept thread, before the line
    // is counted against the unacked-byte budget.
    const line = redact(formatWithOptions({ colors: false }, ...args), []);
    const accepted = logBudget.take(line);
    if (!accepted) return;
    try {
      post({ v: 1, kind: "log", line: accepted });
    } catch {
      logBudget.unsent(accepted);
    }
  };
  if (test && typeof test.logLine === "string") console.error(test.logLine);
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("AIDANOS_") || /TOKEN|SECRET|PASSWORD|CREDENTIAL|_KEY/i.test(key)) {
      logSafe([], "worker saw secret env");
      break;
    }
  }
  await installIndexTrace((line) => logSafe([], line), { thread: "worker" });
  // The accept thread remembered this path at claim. This isolate has its own
  // copy, so record it once here. A later save must not call realpath again.
  if (data.vault) rememberVaultRoot(data.vault);
  try {
    await refuseSymlinkedStorage(data.dataDir);
    const fault = storageFolderFault(data.dataDir);
    if (fault) throw new Error("storage folder failed the owner walk");
    await sweepDeadStorageTemps(data.dataDir);
  } catch {
    post({ v: 1, kind: "startup-error", reason: "startup failed" });
    process.exit(1);
  }
  const warmStarted = performance.now();
  warmSyncEngine();
  const warmMs = performance.now() - warmStarted;
  const inflightBuf = data.inflight;
  const inflight = new Map();
  let exiting = false;
  function die() {
    exiting = true;
    process.exit(1);
  }
  function publishInflight() {
    writeInflight(inflightBuf, [...inflight.keys()]);
    try {
      post({ v: 1, kind: "inflight", docs: [...inflight.keys()] });
    } catch {
      // The parent reads the shared buffer if this post loses the race.
    }
  }
  function enter(docId) {
    if (!docId) return;
    inflight.set(docId, (inflight.get(docId) || 0) + 1);
    publishInflight();
  }
  function leave(docId) {
    if (exiting || !docId) return;
    const next = (inflight.get(docId) || 1) - 1;
    if (next <= 0) inflight.delete(docId);
    else inflight.set(docId, next);
    publishInflight();
  }
  let saveSeq = 1;
  let armSaveHold = false;
  let crashSaveUsed = false;
  let crashBusySaveUsed = false;
  let crashDelayUsed = false;
  let crashBusyRequestUsed = false;
  const saveTasks = new Set();
  function trackSave(work) {
    const id = saveSeq;
    saveSeq += 1;
    post({ v: 1, kind: "save", id, phase: "start" });
    const run = Promise.resolve().then(async () => {
      if (armSaveHold && test && test.saveHoldMs) {
        await new Promise((resolve) => setTimeout(resolve, test.saveHoldMs));
      }
      return work();
    }).finally(() => {
      post({ v: 1, kind: "save", id, phase: "end" });
    });
    saveTasks.add(run);
    // The caller owns run's rejection. This extra finally is only bookkeeping,
    // and a mirror or storage failure must not become an unhandled rejection
    // that exits the worker.
    run.finally(() => saveTasks.delete(run)).catch(() => {});
    return run;
  }
  const inner = new NodeFSStorageAdapter(data.dataDir);
  const storage = traceStorage(new SafeStorage(data.dataDir, inner));
  for (const method of ["save", "remove", "removeRange"]) {
    const raw = storage[method].bind(storage);
    storage[method] = (...args) => {
      const key = args[0];
      const docId = Array.isArray(key) && key.length ? String(key[0]) : "";
      enter(docId);
      if (method === "save" && test && readyForWork && crashDocMatches(docId)) {
        if (test.crashSave && !crashSaveUsed) {
          crashSaveUsed = true;
          die();
        }
        if (test.crashBusy === "save" && !crashBusySaveUsed) {
          crashBusySaveUsed = true;
          cpuSpin(40);
          die();
        }
      }
      return trackSave(() => raw(...args)).finally(() => leave(docId));
    };
  }
  const adapter = new ParentAdapter();
  const repo = new Repo({
    storage,
    network: [adapter],
    sharePolicy: async () => true,
    peerId: data.peerId || "aidanos-relay",
  });
  adapter.repo = repo;
  watchRepo(repo);
  bindRepoMessages(repo);
  const debounce = Number(data.mirrorDebounceMs);
  const mirror = createMirror({
    repo,
    vault: data.vault,
    debounceMs: Number.isFinite(debounce) && debounce >= 0 ? debounce : 400,
    secrets: [],
    track: trackSave,
    stateDir: data.dataDir,
    hold(docId) {
      enter(docId);
      return () => leave(docId);
    },
  });
  await preloadStoredNotes(repo);
  await mirror.now();
  armSaveHold = true;
  const peerMetadata = await repo.networkSubsystem.peerMetadata;
  if (!adapter.peerId) throw new Error("The sync engine was not ready.");
  post({
    v: 1,
    kind: "ready",
    peerId: adapter.peerId,
    peerMetadata: peerMetadata || null,
    warmMs,
  });
  readyForWork = true;
  drain();
  if (test && test.wasmOom) {
    const chunks = [];
    const big = Automerge.from({ kind: "note", text: "m".repeat(1024 * 1024) });
    chunks.push(Automerge.save(big));
    for (let i = 0; i < 24; i += 1) chunks.push(Buffer.alloc(4 * 1024 * 1024));
    globalThis.__arrayHold = chunks;
  }
  if (test && test.crashMidWrite) {
    setTimeout(() => {
      const noteFile = path.join(String(data.vault), "notes", "keep.md");
      replaceNoteAtomic(noteFile, "torn-partial-" + "x".repeat(400), {
        vault: data.vault,
        stateDir: data.dataDir,
        crashMidWrite: true,
      }).catch(() => {});
    }, 300);
  }
  if (test && test.holdNoteMs) {
    const noteFile = path.join(String(data.vault), "held-note.md");
    const body = "whole-note-line\n".repeat(256);
    trackSave(() => saveNoteFile(noteFile, body, () => new Promise((resolve) => {
      setTimeout(resolve, test.holdNoteMs);
    }), { vault: data.vault, stateDir: data.dataDir }));
  }
  if (test && test.crashOnBoot) {
    setTimeout(() => process.exit(1), 40);
  }

  async function rpc(msg) {
    const method = msg.method;
    if (method === "import") {
      const bytes = bytesOf(msg.binary);
      if (!bytes || !msg.docId) throw new Error("failed");
      repo.import(bytes, { docId: msg.docId });
      return { result: { ok: true }, transfer: [] };
    }
    if (method === "find") {
      const handle = await repo.find(msg.docId);
      const binary = savedBinary(handle.doc());
      if (!binary) throw new Error("failed");
      return { result: { binary }, transfer: [binary] };
    }
    if (method === "flush") {
      await repo.flush();
      return { result: { ok: true }, transfer: [] };
    }
    if (method === "loadDoc") {
      const loaded = await repo.storageSubsystem.loadDoc(msg.docId);
      if (!loaded) return { result: { binary: null }, transfer: [] };
      const binary = savedBinary(loaded);
      return { result: { binary }, transfer: binary ? [binary] : [] };
    }
    if (method === "replace") {
      const bytes = bytesOf(msg.binary);
      if (!bytes || !msg.docId) throw new Error("failed");
      const incoming = Automerge.load(bytes);
      const handle = repo.handles[msg.docId];
      if (!handle) repo.import(Automerge.save(incoming), { docId: msg.docId });
      else handle.update((doc) => Automerge.merge(doc, incoming));
      return { result: { ok: true }, transfer: [] };
    }
    if (method === "mirrorNow") {
      await mirror.now();
      const docs = [];
      const transfer = [];
      const ids = Array.isArray(msg.ids) ? msg.ids : [];
      for (const id of ids) {
        const handle = repo.handles[id];
        if (!handle) continue;
        let binary = null;
        try {
          binary = savedBinary(handle.doc());
        } catch {
          binary = null;
        }
        if (!binary) continue;
        docs.push({ id, binary });
        transfer.push(binary);
      }
      return { result: { docs }, transfer };
    }
    if (method === "idle") {
      await mirror.idle();
      return { result: { ok: true }, transfer: [] };
    }
    if (method === "stop") {
      mirror.stop();
      return { result: { ok: true }, transfer: [] };
    }
    if (method === "finishSaves") {
      mirror.stop();
      await mirror.idle();
      await Promise.all([...saveTasks]);
      return { result: { ok: true }, transfer: [] };
    }
    throw new Error("failed");
  }

  function crashDocMatches(docId) {
    if (!test || !test.crashDoc) return true;
    return docId === test.crashDoc;
  }

  function holdBusy() {
    if (!test || !test.busyMs || busyUsed) return false;
    busyUsed = true;
    post({ v: 1, kind: "holding" });
    cpuSpin(test.busyMs);
    post({ v: 1, kind: "holding", done: true });
    return true;
  }

  function bindRepoMessages(repoToBind) {
    const net = repoToBind.networkSubsystem;
    if (!net || typeof net.listeners !== "function" || typeof net.removeAllListeners !== "function") return;
    const fns = net.listeners("message").slice();
    net.removeAllListeners("message");
    for (const fn of fns) {
      net.on("message", (msg) => {
        const docId = msg && typeof msg.documentId === "string" ? msg.documentId : "";
        enter(docId);
        const run = (async () => {
          if (test && test.crashDelay && docId && crashDocMatches(docId) && !crashDelayUsed) {
            crashDelayUsed = true;
            if (test.crashDelay === "immediate") await new Promise((resolve) => setImmediate(resolve));
            else await new Promise((resolve) => setTimeout(resolve, 40));
            die();
          }
          return fn(msg);
        })();
        return Promise.resolve(run).finally(() => leave(docId));
      });
    }
  }

  function runOom() {
    if (!test || !test.oom || oomUsed) return;
    oomUsed = true;
    const junk = [];
    try {
      for (;;) {
        const block = [];
        for (let i = 0; i < 64; i += 1) block.push({ n: i, text: "x".repeat(4096) });
        junk.push(block);
      }
    } catch {
      process.exit(1);
    }
  }

  async function handle(msg) {
    if (!msg || msg.v !== 1) return;
    if (msg.kind === "shutdown") {
      stopped = true;
      mirror.stop();
      try {
        await mirror.idle();
      } catch {
        // The mirror already stopped.
      }
      try {
        await repo.flush();
      } catch {
        // The folder may already be gone.
      }
      process.exit(0);
    }
    if (msg.kind === "rpc") {
      try {
        const answered = await rpc(msg);
        post({ v: 1, kind: "rpc", id: msg.id, ok: true, result: answered.result }, answered.transfer);
      } catch {
        post({ v: 1, kind: "rpc", id: msg.id, ok: false, error: "failed" });
      }
      return;
    }
    if (msg.kind === "open") {
      adapter.open(msg.conn, msg.peerId, msg.peerMetadata);
      return;
    }
    if (msg.kind === "close") {
      adapter.closeConn(msg.conn);
      return;
    }
    if (msg.kind === "msg") {
      const docId = documentIdOf(msg.data);
      enter(docId);
      writeSlot(slot, msg.conn, docId);
      if (test && test.badChannel && !badUsed) {
        badUsed = true;
        const stray = frameToTransfer(msg.data);
        if (stray) post({ v: 1, kind: "msg", conn: 987654321, data: stray }, [stray]);
        post({ v: 1, kind: "close", conn: msg.conn, code: 1003 });
        post({ v: 1, kind: "not-a-kind" });
      }
      if (test && test.echo && msg.data instanceof ArrayBuffer) {
        const copy = frameToTransfer(msg.data);
        if (copy) post({ v: 1, kind: "echo", conn: msg.conn, data: copy }, [copy]);
      }
      // Leave the slot in place when the thread is about to die. A finally
      // that cleared it would hide the document from the parent.
      let keepSlot = false;
      try {
        if (test && test.crash && docId && crashDocMatches(docId)) {
          keepSlot = true;
          die();
        }
        if (test && test.crashBusy === "request" && docId && crashDocMatches(docId) && !crashBusyRequestUsed) {
          crashBusyRequestUsed = true;
          keepSlot = true;
          cpuSpin(40);
          die();
        }
        if (docId) holdBusy();
        if (docId) runOom();
        adapter.inbound(msg.conn, msg.data);
      } finally {
        if (!keepSlot) {
          const size = msg.data instanceof ArrayBuffer ? msg.data.byteLength : 0;
          post({ v: 1, kind: "ack", conn: msg.conn, bytes: size });
          writeSlot(slot, msg.conn, "");
          leave(docId);
        }
      }
    }
  }

  async function drain() {
    if (draining) return;
    draining = true;
    try {
      while (queue.length && !stopped) {
        const next = queue.shift();
        await handle(next);
        await new Promise((resolve) => setImmediate(resolve));
      }
    } finally {
      draining = false;
      if (queue.length && !stopped) drain();
    }
  }

}

function documentIdOf(data) {
  if (!(data instanceof ArrayBuffer)) return "";
  try {
    const message = decode(Buffer.from(data));
    if (!message || typeof message !== "object") return "";
    return typeof message.documentId === "string" ? message.documentId : "";
  } catch {
    return "";
  }
}

process.on("uncaughtException", () => {
  try {
    logSafe([], "worker fatal");
  } catch {
    // The parent may already be gone.
  }
  process.exit(1);
});

if (parentPort) {
  run().catch(() => {
    try {
      post({ v: 1, kind: "startup-error", reason: "startup failed" });
    } catch {
      // The parent may already be gone.
    }
    process.exit(1);
  });
}
