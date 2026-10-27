// Times the index sync path step by step. A 14s "index reply" on the
// Apple runner was the wall clock from one inbound index frame to the
// next outbound one, so it mixed the index itself with whatever else
// held the thread. These lines separate those costs. Step fields are
// inclusive call time. `other` is wall time that no timed call covered.
import { performance } from "node:perf_hooks";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { isMainThread } from "node:worker_threads";
import { next as Automerge } from "@automerge/automerge/slim";
import { INDEX_ID } from "./ids.mjs";

const require = createRequire(import.meta.url);
const SLOW_MS = 20;
export const INDEX_TRACE_ENTRY_CAP = 10_000;
const LAG_LOG_MS = 200;
const LAG_COUNT_MS = 100;
const LAG_INTERVAL_MS = 100;
const STEP_NAMES = [
  "decode",
  "receive",
  "patches",
  "generate",
  "save",
  "saveSince",
  "diff",
  "loadIncremental",
  "encodeState",
  "decodeState",
  "storageLoad",
  "storageSave",
  "storageLoadRange",
  "storageRemove",
];
const METRIC_STEP = {
  "generate-sync-message": "generate",
  "receive-sync-message": "receive",
  "doc-compacted": "save",
  "doc-saved": "saveSince",
  "doc-loaded": "loadIncremental",
};

let write = () => {};
let threadName = "main";

function emit(line) {
  write(line + " thread=" + threadName);
}
let patching = null;
let timer = null;
let expectedTick = 0;
let currentDocId = "";
let window = null;
let active = null;
const recent = [];
const lastSaveBytes = new Map();
const watched = new WeakSet();
let storageBytes = null;

function byteLength(value) {
  if (value == null) return 0;
  if (typeof value.byteLength === "number") return value.byteLength;
  if (typeof value.length === "number") return value.length;
  return 0;
}

function keyDoc(key) {
  return Array.isArray(key) && key.length > 0 ? String(key[0]) : "";
}

function keyName(key) {
  return Array.isArray(key) ? key.map((part) => String(part)).join("/") : String(key ?? "");
}

function seconds(ms) {
  return (ms / 1000).toFixed(3) + "s";
}

function formatHeads(heads) {
  if (!heads || typeof heads[Symbol.iterator] !== "function") return "-";
  const parts = [];
  for (const head of heads) {
    if (typeof head === "string") parts.push(head);
    else if (head instanceof Uint8Array) parts.push(Buffer.from(head).toString("hex"));
    else parts.push(String(head));
  }
  if (parts.length === 0) return "-";
  const shown = parts.slice(0, 4);
  if (parts.length > 4) shown.push("+" + (parts.length - 4));
  return shown.join(",");
}

function keep(entry) {
  recent.push(entry);
  if (recent.length > 400) recent.shift();
  if (window) {
    window.entries.push(entry);
    const extra = window.entries.length - INDEX_TRACE_ENTRY_CAP;
    if (extra > 0) window.entries.splice(0, extra);
  }
  if (entry.ms >= SLOW_MS) {
    queueMicrotask(() => {
      if (entry.logged) return;
      entry.logged = true;
      emit("sync step " + entry.name + " doc=" + entry.docId + " " + entry.ms.toFixed(1) + "ms");
    });
  }
}

function timeCall(name, fn) {
  return function timed(...args) {
    const parent = active;
    const started = performance.now();
    const entry = {
      name,
      ms: 0,
      childMs: 0,
      docId: currentDocId || "?",
      start: started,
      at: 0,
      logged: false,
      bytes: 0,
    };
    active = entry;
    try {
      const result = fn.apply(this, args);
      if (name === "save" || name === "saveSince") entry.bytes = byteLength(result);
      return result;
    } finally {
      const ended = performance.now();
      entry.ms = ended - started;
      entry.at = ended;
      entry.docId = currentDocId || entry.docId || "?";
      active = parent;
      if (parent) parent.childMs += entry.ms;
      keep(entry);
    }
  };
}

function wrap(obj, key, name) {
  const orig = obj && obj[key];
  if (typeof orig !== "function" || orig.__indexTrace) return;
  const wrapped = timeCall(name, orig);
  wrapped.__indexTrace = true;
  obj[key] = wrapped;
}

const PROTO_METHODS = [
  "receiveSyncMessage",
  "generateSyncMessage",
  "applyAndReturnPatches",
  "save",
  "saveSince",
  "diff",
  "loadIncremental",
];
const API_METHODS = ["decodeSyncMessage", "encodeSyncState", "decodeSyncState"];

function tracedShape(loaded) {
  const proto = loaded && loaded.wasm && loaded.wasm.Automerge && loaded.wasm.Automerge.prototype;
  const api = loaded && loaded.ApiHandler;
  if (!proto || !api) throw new Error("missing automerge internals");
  for (const key of PROTO_METHODS) {
    if (typeof proto[key] !== "function") throw new Error("missing automerge internals");
  }
  for (const key of API_METHODS) {
    if (typeof api[key] !== "function") throw new Error("missing automerge internals");
  }
  return { proto, api };
}

function wrapLoaded(loaded) {
  const { proto, api } = tracedShape(loaded);
  wrap(proto, "receiveSyncMessage", "receive");
  wrap(proto, "generateSyncMessage", "generate");
  wrap(proto, "applyAndReturnPatches", "patches");
  wrap(proto, "save", "save");
  wrap(proto, "saveSince", "saveSince");
  wrap(proto, "diff", "diff");
  wrap(proto, "loadIncremental", "loadIncremental");
  wrap(api, "decodeSyncMessage", "decode");
  wrap(api, "encodeSyncState", "encodeState");
  wrap(api, "decodeSyncState", "decodeState");
}

// low_level.js is ESM. The wasm class is CJS. Both are already loaded by
// the time the relay starts; this only wraps the live functions. A missing
// or reshaped private file turns tracing off. It must not stop the relay.
async function loadAutomergeInternals() {
  const entry = import.meta.resolve("@automerge/automerge");
  const wasm = require(fileURLToPath(new URL("../wasm_bindgen_output/nodejs/automerge_wasm.cjs", entry)));
  const { ApiHandler } = await import(new URL("../low_level.js", entry).href);
  return { wasm, ApiHandler };
}

function patchAutomerge() {
  if (!patching) {
    patching = loadAutomergeInternals().then(wrapLoaded);
  }
  return patching;
}

function retarget(name, documentId) {
  if (!documentId) return;
  const now = performance.now();
  for (let i = recent.length - 1; i >= 0; i -= 1) {
    const entry = recent[i];
    if (now - entry.at > 50) break;
    if (entry.name !== name) continue;
    entry.docId = documentId;
    if ((name === "save" || name === "saveSince") && entry.bytes > 0) {
      lastSaveBytes.set(documentId, entry.bytes);
    }
    if (name === "receive") {
      for (let j = recent.length - 1; j >= 0; j -= 1) {
        const other = recent[j];
        if (other.at < entry.start - 5) break;
        // applyAndReturnPatches runs after the wasm receive returns, still
        // inside the same JS receiveSyncMessage, so it is not nested in the
        // wasm timer. A queued index reply can run while currentDocId is
        // still the previous note; the metrics event is the document id.
        const patchesOfThis = other.name === "patches" && other.start >= entry.start - 0.01 && other.start - entry.at <= 5;
        const justBefore = other.name === "decode" && other.at <= entry.start + 0.5 && entry.start - other.at <= 5 && entry.start - other.at >= -0.5;
        if (patchesOfThis || justBefore) other.docId = documentId;
      }
    }
    return;
  }
}

// One line per burst. A late tick used to print on every 100ms fire, and
// each print was a synchronous file write, so the log itself kept the
// loop late. Short gaps stay buffered until the loop recovers or a
// second has passed. A gap of a second or more is printed once, then
// further ticks in that burst only raise the next line's max.
export function emptyLateState() {
  return { max: 0, count: 0, since: 0 };
}

export function nextLoopLateLine(state, late, now) {
  if (late < LAG_LOG_MS) {
    if (state.count === 0) return null;
    const line = formatLate(state);
    state.max = 0;
    state.count = 0;
    state.since = 0;
    return line;
  }
  if (state.count === 0) state.since = now;
  state.count += 1;
  if (late > state.max) state.max = late;
  const overASecond = state.max >= 1000;
  const windowFull = now - state.since >= 1000;
  if (!overASecond && !windowFull) return null;
  const line = formatLate(state);
  state.max = 0;
  state.count = 0;
  state.since = now;
  return line;
}

function formatLate(state) {
  const count = state.count > 1 ? " x" + state.count : "";
  return "event loop late " + state.max.toFixed(0) + "ms" + count;
}

function startLagTimer() {
  if (timer) return;
  expectedTick = performance.now() + LAG_INTERVAL_MS;
  const lateState = emptyLateState();
  timer = setInterval(() => {
    const now = performance.now();
    const late = now - expectedTick;
    expectedTick = now + LAG_INTERVAL_MS;
    if (window && late >= LAG_COUNT_MS) window.blocked += late;
    const line = nextLoopLateLine(lateState, late, now);
    if (line) emit(line);
  }, LAG_INTERVAL_MS);
  if (timer.unref) timer.unref();
}

export async function installIndexTrace(log, options = {}) {
  if (typeof log === "function") write = log;
  if (options.thread === "worker" || options.thread === "main") threadName = options.thread;
  else threadName = isMainThread ? "main" : "worker";
  startLagTimer();
  const custom = typeof options.load === "function";
  try {
    if (custom) {
      wrapLoaded(await options.load());
      return;
    }
    await patchAutomerge();
  } catch {
    // One line. Sync keeps running with the timers still in place and
    // without the private Automerge wrappers. A test load must not
    // disable the real wrappers for the rest of the process.
    write("index trace off");
    if (!custom) patching = Promise.resolve();
  }
}

export function beginFrame(docId) {
  if (typeof docId === "string" && docId) currentDocId = docId;
}

export function watchRepo(repo) {
  if (!repo || watched.has(repo) || typeof repo.on !== "function") return;
  watched.add(repo);
  repo.on("doc-metrics", (event) => {
    if (!event) return;
    const name = METRIC_STEP[event.type];
    if (!name) return;
    retarget(name, event.documentId);
  });
}

export function traceStorage(inner) {
  const sizes = new Map();
  storageBytes = sizes;
  async function timed(name, docId, fn) {
    const started = performance.now();
    try {
      return await fn();
    } finally {
      keep({
        name,
        ms: performance.now() - started,
        childMs: 0,
        docId: docId || "?",
        start: started,
        at: performance.now(),
        logged: false,
        bytes: 0,
      });
    }
  }
  const api = {
    load(key) {
      return timed("storageLoad", keyDoc(key), async () => {
        const data = await inner.load(key);
        if (data) sizes.set(keyName(key), byteLength(data));
        return data;
      });
    },
    save(key, data) {
      return timed("storageSave", keyDoc(key), async () => {
        sizes.set(keyName(key), byteLength(data));
        return inner.save(key, data);
      });
    },
    remove(key) {
      return timed("storageRemove", keyDoc(key), async () => {
        sizes.delete(keyName(key));
        return inner.remove(key);
      });
    },
    loadRange(prefix) {
      return timed("storageLoadRange", keyDoc(prefix), async () => {
        const chunks = await inner.loadRange(prefix);
        if (Array.isArray(chunks)) {
          for (const chunk of chunks) {
            if (!chunk || !chunk.key || chunk.data == null) continue;
            sizes.set(keyName(chunk.key), byteLength(chunk.data));
          }
        }
        return chunks;
      });
    },
    removeRange(prefix) {
      return timed("storageRemove", keyDoc(prefix), async () => {
        const prefixName = keyName(prefix);
        for (const name of [...sizes.keys()]) {
          if (name === prefixName || name.startsWith(prefixName + "/")) sizes.delete(name);
        }
        return inner.removeRange(prefix);
      });
    },
    bytesFor(docId) {
      const prefix = String(docId) + "/";
      let total = 0;
      for (const [name, size] of sizes) {
        if (name.startsWith(prefix)) total += size;
      }
      return total;
    },
  };
  if (typeof inner.close === "function") {
    api.close = (...args) => inner.close(...args);
  }
  return api;
}

function storedBytes(docId) {
  if (!storageBytes) return 0;
  const prefix = String(docId) + "/";
  let total = 0;
  for (const [name, size] of storageBytes) {
    if (name.startsWith(prefix)) total += size;
  }
  return total;
}

export function indexFacts(repo) {
  const bytes = Math.max(storedBytes(INDEX_ID), lastSaveBytes.get(INDEX_ID) || 0);
  const handle = repo && repo.handles ? repo.handles[INDEX_ID] : null;
  if (!handle) return { bytes, changes: 0, ops: 0, heads: "-", state: "missing" };
  let doc = null;
  try {
    doc = typeof handle.doc === "function" ? handle.doc() : null;
  } catch {
    doc = null;
  }
  if (!doc) return { bytes, changes: 0, ops: 0, heads: "-", state: "loading" };
  try {
    const stats = Automerge.stats(doc);
    return {
      bytes,
      changes: Number(stats && stats.numChanges) || 0,
      ops: Number(stats && stats.numOps) || 0,
      heads: formatHeads(Automerge.getHeads(doc)),
      state: "ready",
    };
  } catch {
    return { bytes, changes: 0, ops: 0, heads: "-", state: "loading" };
  }
}

function factsText(facts) {
  return (
    "bytes=" + facts.bytes +
    " changes=" + facts.changes +
    " ops=" + facts.ops +
    " heads=" + (facts.heads || "-") +
    " state=" + facts.state
  );
}

export function beginIndexRequest(repo) {
  if (window) finishIndex("unfinished");
  const facts = indexFacts(repo);
  window = { start: performance.now(), entries: [], blocked: 0, facts };
  emit("index doc " + factsText(facts));
}

function sumName(entries, name, docId) {
  let n = 0;
  let ms = 0;
  for (const entry of entries) {
    if (entry.name !== name) continue;
    if (docId != null && entry.docId !== docId) continue;
    n += 1;
    ms += entry.ms;
  }
  return { n, ms };
}

function field(stat) {
  return stat.n + "x/" + stat.ms.toFixed(1) + "ms";
}

export function finishIndex(kind) {
  if (!window) return;
  const open = window;
  window = null;
  const wall = performance.now() - open.start;
  let exclusive = 0;
  let otherDocN = 0;
  let otherDocMs = 0;
  for (const entry of open.entries) {
    const slice = Math.max(0, entry.ms - (entry.childMs || 0));
    exclusive += slice;
    if (entry.docId !== INDEX_ID && entry.name !== "mirror" && entry.name !== "git") {
      otherDocN += 1;
      otherDocMs += slice;
    }
  }
  const other = Math.max(0, wall - exclusive);
  const parts = [kind === "unfinished" ? "index steps unfinished" : "index steps", factsText(open.facts), "wall=" + seconds(wall)];
  for (const name of STEP_NAMES) parts.push(name + "=" + field(sumName(open.entries, name, INDEX_ID)));
  parts.push("mirror=" + field(sumName(open.entries, "mirror", null)));
  parts.push("git=" + field(sumName(open.entries, "git", null)));
  parts.push("otherdoc=" + otherDocN + "x/" + otherDocMs.toFixed(1) + "ms");
  parts.push("other=" + seconds(other));
  parts.push("blocked=" + seconds(open.blocked));
  emit(parts.join(" "));
}

export function finishIndexReply() {
  finishIndex("done");
}

function noteWork(name, ms, docId, slowLine) {
  const elapsed = Number(ms) || 0;
  keep({
    name,
    ms: elapsed,
    childMs: 0,
    docId,
    start: performance.now() - elapsed,
    at: performance.now(),
    logged: true,
    bytes: 0,
  });
  if (elapsed >= SLOW_MS) emit(slowLine + " " + elapsed.toFixed(1) + "ms");
}

export function noteMirror(ms) {
  noteWork("mirror", ms, "mirror", "mirror pass in");
}

export function noteGitWork(ms) {
  noteWork("git", ms, "git", "git backup in");
}
