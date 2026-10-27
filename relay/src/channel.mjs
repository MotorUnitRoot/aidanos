// Messages between the accept thread and the sync worker.
// Main gives out connection ids. Anything else is dropped.

export const PROTOCOL_VERSION = "1";
export const CLOSE_CODES = new Set([1000, 1008, 1009, 1011]);
export const PAUSE_BYTES = 8 * 1024 * 1024;
export const CLOSE_BYTES = 16 * 1024 * 1024;
export const GLOBAL_BYTES = 64 * 1024 * 1024;
export const PAUSE_LIMIT_MS = 60_000;
export const CRASH_WINDOW_MS = 10 * 60 * 1000;
export const DOC_CRASH_LIMIT = 2;
export const CRASH_LOOP_LIMIT = 5;
export const WORKER_PING_MS = 1000;
export const WORKER_SILENT_MS = 5000;
export const BACKOFF_START_MS = 1000;
export const BACKOFF_MAX_MS = 30_000;
export const WORKER_HEAP_MB = 512;
export const WORKER_OOM_HEAP_MB = 96;
export const HEALTH_OK = "ok";
export const HEALTH_WARMING = "warming";
export const HEALTH_SILENT = "worker silent";
export const HEALTH_CRASH_LOOP = "worker crash loop";
export const HEALTH_SYNC_DOWN = "sync down";
export const SLOT_BYTES = 512;
export const SLOT_ID_OFFSET = 16;
export const SLOT_ID_MAX = 400;
// Same cap as the accept thread's file log. The worker forwards each line
// to that log. This counts only bytes the parent has not taken yet.
export const LOG_FORWARD_CAP = 1024 * 1024;
const LOG_NOTICE_RESERVE = 96;

// Bytes of log lines posted to the parent and not yet acknowledged.
// A line that would push that total over the cap is dropped. One notice
// is forwarded once an acknowledgement leaves room for it.
export function createLogBudget(cap = LOG_FORWARD_CAP) {
  let pending = 0;
  let dropped = 0;
  let announced = false;
  const limit = Number(cap) > 0 ? Number(cap) : LOG_FORWARD_CAP;

  return {
    get pending() {
      return pending;
    },
    get dropped() {
      return dropped;
    },
    take(line) {
      const text = String(line ?? "");
      const size = Buffer.byteLength(text);
      if (size === 0) return null;
      const reserve = announced || dropped === 0 ? 0 : LOG_NOTICE_RESERVE;
      if (pending + size + reserve > limit) {
        dropped += 1;
        return null;
      }
      pending += size;
      return text;
    },
    unsent(line) {
      const size = Buffer.byteLength(String(line ?? ""));
      pending = Math.max(0, pending - size);
    },
    ack(bytes) {
      const size = Number(bytes);
      if (Number.isFinite(size) && size > 0) pending = Math.max(0, pending - size);
      if (announced || dropped === 0) return null;
      const text = dropped + " lines dropped";
      const notice = Buffer.byteLength(text);
      if (pending + notice > limit) return null;
      announced = true;
      pending += notice;
      return text;
    },
  };
}

export function createSlot() {
  return new SharedArrayBuffer(SLOT_BYTES);
}

export function createWake() {
  return new SharedArrayBuffer(4);
}

// The worker writes the document it is handling into this buffer before the
// work, because a postMessage can lose the race with the thread exiting.
export function writeSlot(slot, conn, docId) {
  if (!slot) return;
  const text = Buffer.from(String(docId || ""), "utf8").subarray(0, SLOT_ID_MAX);
  const bytes = new Uint8Array(slot);
  bytes.fill(0, SLOT_ID_OFFSET, SLOT_ID_OFFSET + SLOT_ID_MAX);
  if (text.length) bytes.set(text, SLOT_ID_OFFSET);
  const ints = new Int32Array(slot);
  Atomics.store(ints, 2, Number(conn) | 0);
  Atomics.store(ints, 1, text.length);
  Atomics.add(ints, 0, 1);
}

export function readSlot(slot) {
  if (!slot) return { seq: 0, conn: -1, docId: "" };
  const ints = new Int32Array(slot);
  const seq = Atomics.load(ints, 0);
  const length = Atomics.load(ints, 1);
  const conn = Atomics.load(ints, 2);
  if (!Number.isInteger(length) || length <= 0 || length > SLOT_ID_MAX) {
    return { seq, conn, docId: "" };
  }
  const docId = Buffer.from(new Uint8Array(slot, SLOT_ID_OFFSET, length)).toString("utf8");
  return { seq, conn, docId };
}

export function resetWake(wake) {
  if (!wake) return;
  Atomics.store(new Int32Array(wake), 0, 0);
}

export function wakeWorker(wake) {
  if (!wake) return;
  const ints = new Int32Array(wake);
  Atomics.store(ints, 0, 1);
  Atomics.notify(ints, 0, 1);
}

const CONTROL = new Set([
  "pong",
  "ready",
  "log",
  "ack",
  "rpc",
  "echo",
  "holding",
  "startup-error",
  "save",
]);

// ws reuses a pooled Buffer. Transferring its underlying ArrayBuffer detaches
// the pool and corrupts the next frame. Copy into a fresh exact-size buffer
// first, then transfer that copy.
export function frameToTransfer(data) {
  let view = null;
  if (Buffer.isBuffer(data)) view = data;
  else if (data instanceof ArrayBuffer) view = new Uint8Array(data);
  else if (ArrayBuffer.isView(data)) view = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  else if (typeof data === "string") view = Buffer.from(data);
  if (!view) return null;
  const copy = new ArrayBuffer(view.byteLength);
  new Uint8Array(copy).set(view);
  return copy;
}

export function acceptWorkerMessage(msg, isOpen) {
  if (!msg || msg.v !== 1 || typeof msg.kind !== "string") return "drop";
  if (msg.kind === "msg" || msg.kind === "close") {
    if (!Number.isInteger(msg.conn) || msg.conn < 0) return "drop";
    if (typeof isOpen !== "function" || !isOpen(msg.conn)) return "drop";
    if (msg.kind === "close" && !CLOSE_CODES.has(msg.code)) return "drop";
    if (msg.kind === "msg" && !(msg.data instanceof ArrayBuffer)) return "drop";
    return "socket";
  }
  if (CONTROL.has(msg.kind)) return "control";
  return "drop";
}

export function trimmedWorkerEnv(env = process.env) {
  const out = {};
  for (const [key, value] of Object.entries(env || {})) {
    if (key.startsWith("AIDANOS_")) continue;
    if (typeof value === "string") out[key] = value;
  }
  return out;
}

export function workerExecArgv(env = process.env, execArgv = process.execArgv) {
  const ci = env && (env.CI === "true" || env.CI === "1");
  if (!ci) return [];
  const out = [];
  const args = Array.isArray(execArgv) ? execArgv : [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--cpu-prof") out.push(arg);
    else if (arg === "--cpu-prof-dir") {
      out.push(arg);
      if (typeof args[i + 1] === "string") out.push(args[(i += 1)]);
    } else if (typeof arg === "string" && (arg.startsWith("--cpu-prof-dir=") || arg.startsWith("--cpu-prof-name"))) {
      out.push(arg);
    }
  }
  return out;
}

export function workerTestHook(options, env = process.env) {
  if (!env || env.NODE_ENV !== "test" || !options) return null;
  const hook = {};
  const busy = Number(options.testBusyMs);
  if (Number.isFinite(busy) && busy > 0) hook.busyMs = busy;
  if (options.testCrash === true) hook.crash = true;
  if (options.testOom === true) hook.oom = true;
  if (options.testCrashOnBoot === true) hook.crashOnBoot = true;
  if (options.testEcho === true) hook.echo = true;
  if (options.testBadChannel === true) hook.badChannel = true;
  return Object.keys(hook).length ? hook : null;
}
