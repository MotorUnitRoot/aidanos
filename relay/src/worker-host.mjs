// The worker does not receive the token or the socket.
// That is tidiness, not a wall: the worker shares this process's memory.
import { Worker } from "node:worker_threads";
import * as Automerge from "@automerge/automerge";
import {
  BACKOFF_MAX_MS,
  BACKOFF_START_MS,
  CRASH_LOOP_LIMIT,
  CRASH_WINDOW_MS,
  DOC_CRASH_LIMIT,
  HUNG_RESTART_MS,
  WORKER_HEAP_MB,
  WORKER_OOM_HEAP_MB,
  WORKER_RPC_MS,
  WORKER_RSS_BYTES,
  acceptWorkerMessage,
  createInflight,
  createSlot,
  createWake,
  frameToTransfer,
  readInflight,
  readSlot,
  resetWake,
  writeInflight,
  writeSlot,
  trimmedWorkerEnv,
  wakeWorker,
  workerExecArgv,
  workerTestHook,
} from "./channel.mjs";
import { stampLine } from "./redact.mjs";

function toUint8(binary) {
  if (binary instanceof Uint8Array) return binary;
  if (binary instanceof ArrayBuffer) return new Uint8Array(binary);
  if (ArrayBuffer.isView(binary)) return new Uint8Array(binary.buffer, binary.byteOffset, binary.byteLength);
  return new Uint8Array();
}

class DocProxy {
  constructor(repo, docId, doc) {
    this.documentId = docId;
    this._repo = repo;
    this._doc = doc;
    // A resolved non-thenable. Promise.resolve(this) would adopt this handle
    // and the find() promise would wait on itself.
    this._pending = Promise.resolve();
  }

  doc() {
    return this._doc;
  }

  change(callback, options = {}) {
    this._doc = Automerge.change(this._doc, options, callback);
    this._pending = this._repo._replace(this.documentId, this._doc);
    return this;
  }

  update(callback) {
    const next = callback(this._doc);
    if (next !== undefined) this._doc = next;
    this._pending = this._repo._replace(this.documentId, this._doc);
    return this;
  }

  _replaceFrom(binary) {
    if (!binary) return;
    this._doc = Automerge.load(toUint8(binary));
  }

  // Await waits until the worker has the bytes, then yields this handle.
  // `then` is hidden while resolving so the promise does not adopt this
  // object and wait on itself.
  then(onFulfilled, onRejected) {
    return this._pending.then(() => {
      const saved = this.then;
      Object.defineProperty(this, "then", { value: undefined, configurable: true });
      try {
        return typeof onFulfilled === "function" ? onFulfilled(this) : this;
      } finally {
        Object.defineProperty(this, "then", { value: saved, configurable: true, writable: true });
      }
    }, onRejected);
  }
}

class RepoProxy {
  constructor(host) {
    this._host = host;
    this._handles = new Map();
    this._inflight = new Set();
    this.storageSubsystem = {
      loadDoc: (id) => this._loadDoc(id),
      close: async () => {},
    };
    this.networkSubsystem = {
      disconnect() {},
    };
  }

  _track(promise) {
    const tracked = Promise.resolve(promise).then(
      (value) => value,
      (error) => {
        throw error;
      },
    );
    this._inflight.add(tracked);
    const done = () => {
      this._inflight.delete(tracked);
    };
    tracked.then(done, done);
    return tracked;
  }

  async _settle() {
    while (this._inflight.size) {
      await Promise.allSettled([...this._inflight]);
    }
  }

  _ensure(docId, doc) {
    let handle = this._handles.get(docId);
    if (!handle) {
      handle = new DocProxy(this, docId, doc);
      this._handles.set(docId, handle);
      return handle;
    }
    handle._doc = doc;
    return handle;
  }

  import(binary, args = {}) {
    const docId = args.docId;
    const bytes = toUint8(binary);
    const doc = Automerge.load(bytes);
    const handle = this._ensure(docId, doc);
    const copy = frameToTransfer(bytes);
    handle._pending = this._track(
      this._host.rpc("import", { docId, binary: copy }, copy ? [copy] : []).then(() => undefined),
    );
    return handle;
  }

  async find(id) {
    await this._settle();
    const result = await this._host.rpc("find", { docId: id });
    const binary = result && result.binary;
    if (!binary) throw new Error("failed");
    return this._ensure(id, Automerge.load(toUint8(binary)));
  }

  async flush() {
    await this._settle();
    await this._host.rpc("flush", {});
  }

  async _loadDoc(id) {
    await this._settle();
    const result = await this._host.rpc("loadDoc", { docId: id });
    if (!result || !result.binary) return null;
    return Automerge.load(toUint8(result.binary));
  }

  _replace(docId, doc) {
    const copy = frameToTransfer(Automerge.save(doc));
    return this._track(this._host.rpc("replace", { docId, binary: copy }, copy ? [copy] : []));
  }

  async _refresh(ids) {
    const result = await this._host.rpc("mirrorNow", { ids });
    const docs = result && Array.isArray(result.docs) ? result.docs : [];
    for (const item of docs) {
      const handle = this._handles.get(item.id);
      if (handle) handle._replaceFrom(item.binary);
    }
  }
}

export function createWorkerHost(options = {}) {
  const onLog = typeof options.onLog === "function" ? options.onLog : () => {};
  const onDown = typeof options.onDown === "function" ? options.onDown : () => {};
  const onSocket = typeof options.onSocket === "function" ? options.onSocket : () => {};
  const hook = workerTestHook(options.test || null);
  const slot = createSlot();
  const wake = createWake();
  const inflightBuf = createInflight();
  const repo = new RepoProxy(null);
  const echoes = [];
  const refused = new Set();
  const docCrashes = new Map();
  const crashes = [];
  const rpcs = new Map();
  let nextRpc = 0;
  let worker = null;
  let port = null;
  let stopping = false;
  let sawReady = false;
  let restarting = false;
  let backoff = BACKOFF_START_MS;
  let restartTimer = null;
  let pingTimer = null;
  let tempsResolve = null;
  let readyResolve = null;
  let rssAtSpawn = process.memoryUsage().rss;
  let heartbeatStop = false;
  let rssTripped = false;
  let readyReject = null;
  let readyPromise = null;
  const host = {
    peerId: options.peerId || "aidanos-relay",
    peerMetadata: null,
    warm: false,
    lastPong: 0,
    crashLoop: false,
    holding: false,
    refused,
    echoes,
    repo: null,
    mirror: null,
  };
  repo._host = host;

  function say(line) {
    onLog(stampLine(line));
  }

  function failRpcs() {
    for (const pending of rpcs.values()) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(new Error("failed"));
    }
    rpcs.clear();
  }

  function armReady() {
    readyPromise = new Promise((resolve, reject) => {
      readyResolve = resolve;
      readyReject = reject;
    });
  }

  function markReady() {
    const resolve = readyResolve;
    readyResolve = null;
    readyReject = null;
    if (resolve) resolve();
  }

  function markFailed(error) {
    const reject = readyReject;
    readyResolve = null;
    readyReject = null;
    if (reject) reject(error instanceof Error ? error : new Error("startup failed"));
  }

  function spawn() {
    if (stopping || host.crashLoop) return;
    writeSlot(slot, -1, "");
    writeInflight(inflightBuf, []);
    resetWake(wake);
    restarting = false;
    heartbeatStop = false;
    rssAtSpawn = process.memoryUsage().rss;
    const workerUrl = new URL("./worker.mjs", import.meta.url);
    const child = new Worker(workerUrl, {
      eval: false,
      env: trimmedWorkerEnv(),
      execArgv: workerExecArgv(),
      resourceLimits: {
        // maxOldGenerationSizeMb covers the V8 old space only. WebAssembly
        // and ArrayBuffer memory sit outside it. The ping loop stops the
        // worker when process RSS passes WORKER_RSS_BYTES.
        maxOldGenerationSizeMb: hook && hook.oom ? WORKER_OOM_HEAP_MB : WORKER_HEAP_MB,
      },
      workerData: {
        vault: options.vault,
        dataDir: options.dataDir,
        peerId: options.peerId || "aidanos-relay",
        mirrorDebounceMs: options.mirrorDebounceMs,
        test: hook,
        slot,
        wake,
        inflight: inflightBuf,
      },
    });
    worker = child;
    port = child;
    host.warm = false;
    child.on("message", (msg) => onMessage(msg, child));
    child.on("error", () => onExit(child, 1));
    child.on("exit", (code) => onExit(child, code));
  }

  function onMessage(msg, child) {
    const kind = acceptWorkerMessage(msg, (conn) => options.isOpen ? options.isOpen(conn) : true);
    if (kind === "drop") return;
    if (kind === "socket") {
      onSocket(msg);
      return;
    }
    if (msg.kind === "log") {
      const line = typeof msg.line === "string" ? msg.line : "";
      try {
        if (line) onLog(line);
      } finally {
        // The worker counts this line until we have taken it. The file log
        // on this thread holds its own unwritten bytes, capped at 1 MiB.
        if (line && child) {
          try { child.postMessage({ v: 1, kind: "log-ack", bytes: Buffer.byteLength(line) }); }
          catch { /* the worker is already gone */ }
        }
      }
      return;
    }
    if (msg.kind === "pong") {
      host.lastPong = Date.now();
      backoff = BACKOFF_START_MS;
      return;
    }
    if (msg.kind === "ready") {
      host.warm = true;
      host.lastPong = Date.now();
      if (typeof msg.peerId === "string" && msg.peerId) host.peerId = msg.peerId;
      if (msg.peerMetadata && typeof msg.peerMetadata === "object") host.peerMetadata = msg.peerMetadata;
      if (Number.isFinite(msg.warmMs)) host.warmMs = msg.warmMs;
      sawReady = true;
      markReady();
      return;
    }
    if (msg.kind === "startup-error") {
      host.warm = false;
      markFailed(new Error("startup failed"));
      return;
    }
    if (msg.kind === "rpc") {
      const pending = rpcs.get(msg.id);
      if (!pending) return;
      rpcs.delete(msg.id);
      if (msg.ok) pending.resolve(msg.result);
      else pending.reject(new Error("failed"));
      return;
    }
    if (msg.kind === "echo") {
      if (msg.data instanceof ArrayBuffer) echoes.push(Buffer.from(msg.data));
      return;
    }
    if (msg.kind === "holding") {
      host.holding = msg.done !== true;
      return;
    }
    if (msg.kind === "temps-discarded") {
      const resolve = tempsResolve;
      tempsResolve = null;
      if (resolve) resolve();
      return;
    }
    if (msg.kind === "save") {
      if (child === worker && typeof options.onSave === "function") options.onSave(msg);
      return;
    }
    if (msg.kind === "ack") onSocket(msg);
  }

  function noteCrash() {
    const now = Date.now();
    const recent = crashes.filter((at) => now - at < CRASH_WINDOW_MS);
    recent.push(now);
    crashes.length = 0;
    crashes.push(...recent);
    const ids = new Set(readInflight(inflightBuf));
    const info = readSlot(slot);
    if (info.docId) ids.add(info.docId);
    let poisoned = false;
    for (const docId of ids) {
      const list = (docCrashes.get(docId) || []).filter((at) => now - at < CRASH_WINDOW_MS);
      list.push(now);
      docCrashes.set(docId, list);
      if (list.length >= DOC_CRASH_LIMIT && !refused.has(docId)) {
        refused.add(docId);
        poisoned = true;
      }
    }
    if (poisoned) say("poison document");
    return crashes.length >= CRASH_LOOP_LIMIT;
  }

  function onExit(child, code) {
    if (child !== worker) return;
    try {
      if (typeof options.onSave === "function") options.onSave({ phase: "reset" });
    } catch { /* a stuck save must not block the exit */ }
    if (restarting) return;
    restarting = true;
    worker = null;
    port = null;
    host.warm = false;
    host.holding = false;
    failRpcs();
    if (stopping) return;
    // A clean exit still counts when this host did not ask the worker to leave.
    if (code === 0 && host.crashLoop) return;
    const loop = noteCrash();
    if (!sawReady) {
      markFailed(new Error("startup failed"));
      if (loop) {
        host.crashLoop = true;
        say("worker crash loop");
      }
      return;
    }
    if (loop) {
      host.crashLoop = true;
      say("worker crash loop");
      onDown();
      return;
    }
    onDown();
    const wait = backoff;
    backoff = Math.min(backoff * 2, BACKOFF_MAX_MS);
    const status = Number.isInteger(code) ? code : 1;
    say("worker exited code=" + status + ", restart in " + wait + "ms");
    restartTimer = setTimeout(() => {
      restartTimer = null;
      if (!stopping && !host.crashLoop) spawn();
    }, wait);
    if (restartTimer.unref) restartTimer.unref();
  }

  function startPing() {
    if (pingTimer) return;
    pingTimer = setInterval(() => {
      if (!port || stopping) return;
      const rssLimit = hook && Number.isFinite(hook.rssHeadroom)
        ? rssAtSpawn + hook.rssHeadroom
        : WORKER_RSS_BYTES;
      if (!rssTripped && process.memoryUsage().rss > rssLimit) {
        rssTripped = true;
        say("worker rss");
        try { port.terminate(); } catch { /* the worker is already gone */ }
        return;
      }
      if (!heartbeatStop && sawReady && host.lastPong && Date.now() - host.lastPong > HUNG_RESTART_MS) {
        heartbeatStop = true;
        say("worker heartbeat");
        try { port.terminate(); } catch { /* the worker is already gone */ }
        return;
      }
      try {
        port.postMessage({ v: 1, kind: "ping" });
      } catch {
        // The worker is already gone.
      }
    }, 1000);
    if (pingTimer.unref) pingTimer.unref();
  }

  host.repo = repo;
  host.mirror = {
    stop() {
      host.rpc("stop", {}).catch(() => {});
    },
    async idle() {
      try {
        await host.rpc("idle", {});
      } catch {
        // The worker is already gone.
      }
    },
    async finishSaves() {
      wakeWorker(wake);
      await host.rpc("finishSaves", {});
    },
    discardTemps() {
      if (!port || stopping) return Promise.resolve();
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          tempsResolve = null;
          resolve();
        }, 1000);
        tempsResolve = () => {
          clearTimeout(timer);
          resolve();
        };
        try {
          port.postMessage({ v: 1, kind: "discard-temps" });
        } catch {
          clearTimeout(timer);
          tempsResolve = null;
          resolve();
        }
      });
    },
    async now() {
      await repo._settle();
      await repo._refresh([...repo._handles.keys()]);
    },
  };
  host.rpc = function rpc(method, fields, transfer) {
    if (!port || stopping) return Promise.reject(new Error("failed"));
    const id = (nextRpc += 1);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!rpcs.has(id)) return;
        rpcs.delete(id);
        reject(new Error("failed"));
      }, WORKER_RPC_MS);
      if (timer.unref) timer.unref();
      rpcs.set(id, {
        timer,
        resolve(value) {
          clearTimeout(timer);
          resolve(value);
        },
        reject(error) {
          clearTimeout(timer);
          reject(error);
        },
      });
      try {
        port.postMessage({ v: 1, kind: "rpc", id, method, ...fields }, transfer || []);
      } catch (error) {
        clearTimeout(timer);
        rpcs.delete(id);
        reject(error);
      }
    });
  };
  host.wake = function wakeNow() {
    wakeWorker(wake);
  };
  host.post = function post(message, transfer) {
    if (!port || stopping) return;
    try {
      port.postMessage(message, transfer || []);
    } catch {
      // The worker is already gone.
    }
  };
  host.start = function start() {
    sawReady = false;
    stopping = false;
    host.crashLoop = false;
    armReady();
    spawn();
    startPing();
    return readyPromise;
  };
  host.stop = async function stop() {
    stopping = true;
    host.holding = false;
    if (restartTimer) clearTimeout(restartTimer);
    restartTimer = null;
    wakeWorker(wake);
    const child = worker;
    if (!child) return;
    try {
      child.postMessage({ v: 1, kind: "shutdown" });
    } catch {
      // Already gone.
    }
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        try { child.terminate(); } catch { /* already gone */ }
        resolve();
      }, 2000);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  };
  return host;
}
