// Scrub secrets before anything is printed. The git token and the relay
// token must never appear in a log line.
import { closeSync, constants as fsConstants, createWriteStream, fchmodSync, fstatSync, ftruncateSync, lstatSync, openSync, writeSync } from "node:fs";
import path from "node:path";
import { formatWithOptions } from "node:util";

export function redact(text, secrets) {
  let out = String(text ?? "");
  const list = [];
  for (const secret of secrets || []) {
    const value = String(secret || "").trim();
    if (value && !list.includes(value)) list.push(value);
  }
  for (const secret of list) {
    out = out.split(secret).join("***");
    const encoded = encodeURIComponent(secret);
    if (encoded !== secret) out = out.split(encoded).join("***");
  }
  out = out.replace(/x-access-token:[^@\s]+/gi, "x-access-token:***");
  out = out.replace(/Bearer\s+\S+/gi, "Bearer ***");
  out = out.replace(/Authorization:\s*Basic\s+\S+/gi, "Authorization: Basic ***");
  out = out.replace(/AIDANOS_(?:RELAY|VAULT_GIT)_TOKEN=\S+/g, "AIDANOS_TOKEN=***");
  out = out.replace(/https?:\/\/[^\s]+/gi, "[url]");
  out = out.replace(/file:\/\/[^\s]+/gi, "[url]");
  // Same scrub for stderr and fatal.log. A vault path or a note file name
  // must not land in either. Document ids have neither a slash nor a .md suffix.
  out = out.replace(/(^|[\s"'`(])(?:\/|~\/)[^\s"'`)]+/g, "$1[path]");
  out = out.replace(/(^|[\s"'`(])[^\s"'`)]+\/[^\s"'`)]+\.md\b/g, "$1[path]");
  out = out.replace(/(^|[\s"'`(=:])[^\s"'`)/]+\.md\b/g, "$1[note]");
  return out;
}

export function stampLine(line, now = new Date()) {
  return now.toISOString() + " " + String(line);
}

function formatParts(secrets, parts) {
  const line = parts
    .map((part) => {
      if (part instanceof Error) return part.stack || part.message || "error";
      return String(part);
    })
    .join(" ");
  return redact(line, secrets);
}

export function logSafe(secrets, ...parts) {
  console.error(stampLine(formatParts(secrets, parts)));
}

// A startup refusal calls process.exit on the next line. The async file
// log drops that line, and any line still queued ahead of it, when the
// process ends. writeSync lands them before the exit. A full non-blocking
// pipe answers EAGAIN; that must not throw past the exit.
let fileLogFd = null;
let fileLogStream = null;
// Bytes accepted by console.error whose write callback has not run.
// A finished write drops its buffer here, so a later flush cannot write
// that line again. Held bytes stay under the same cap as the stream.
let fileLogPending = [];
let fileLogPendingBytes = 0;
let takeDropNotice = () => "";
// Last resort for a fatal line when stderr stays full. The relay sets this
// to its own state directory before it can exit.
let fatalFallbackDir = null;
const fatalWait = new Int32Array(new SharedArrayBuffer(4));

function isAgain(error) {
  return !!error && (error.code === "EAGAIN" || error.code === "EWOULDBLOCK");
}

function chunkBytes(item) {
  if (!item || item.chunk == null) return Buffer.alloc(0);
  if (Buffer.isBuffer(item.chunk)) return item.chunk;
  return Buffer.from(String(item.chunk), item.encoding || "utf8");
}

function rememberPending(bytes) {
  fileLogPending.push(bytes);
  fileLogPendingBytes += bytes.length;
}

function forgetPending(bytes) {
  const index = fileLogPending.indexOf(bytes);
  if (index === -1) return;
  fileLogPending.splice(index, 1);
  fileLogPendingBytes -= bytes.length;
  if (fileLogPendingBytes < 0) fileLogPendingBytes = 0;
}

function setPending(buffers) {
  fileLogPending = buffers;
  fileLogPendingBytes = 0;
  for (const bytes of buffers) fileLogPendingBytes += bytes.length;
}

function heldLogBytes(stream) {
  const queued = stream && typeof stream.writableLength === "number" ? stream.writableLength : 0;
  return Math.max(fileLogPendingBytes, queued);
}

function writeSyncSome(fd, buffer) {
  try {
    const wrote = writeSync(fd, buffer, 0, buffer.length);
    return wrote > 0 ? wrote : 0;
  } catch (error) {
    if (isAgain(error)) return -1;
    throw error;
  }
}

function writeBounded(fd, parts, maxBytes, asStreamItem) {
  const kept = [];
  const done = [];
  let length = 0;
  let budget = Number(maxBytes) > 0 ? Number(maxBytes) : FILE_LOG_CAP;
  let stopped = false;
  for (const item of parts) {
    const bytes = Buffer.isBuffer(item) ? item : chunkBytes(item);
    if (stopped || budget <= 0) {
      kept.push(asStreamItem ? item : bytes);
      length += bytes.length;
      continue;
    }
    const slice = bytes.length > budget ? bytes.subarray(0, budget) : bytes;
    const wrote = slice.length === 0 ? 0 : writeSyncSome(fd, slice);
    if (wrote < 0) {
      stopped = true;
      kept.push(asStreamItem ? item : bytes);
      length += bytes.length;
      continue;
    }
    budget -= wrote;
    if (wrote < bytes.length) {
      stopped = true;
      const rest = bytes.subarray(wrote);
      kept.push(asStreamItem ? { chunk: rest, encoding: "buffer", callback: item.callback } : rest);
      length += rest.length;
      continue;
    }
    if (asStreamItem && typeof item.callback === "function") done.push(item.callback);
  }
  for (const callback of done) {
    try { callback(); } catch { /* a queued callback must not block the exit */ }
  }
  return { kept, length };
}

// Write the lines still sitting in the async stream, up to the cap.
// Stop when the pipe is full. Clearing the queue keeps the stream from
// writing those bytes again on the next turn.
// Node keeps those lines in stream._writableState.buffered. That array
// is not a public API. When it is missing, only the bytes whose write
// callback has not run are written. A line that already drained is not
// in that list, so this path does not write it a second time.
export function flushFileLog(maxBytes = FILE_LOG_CAP) {
  const stream = fileLogStream;
  const fd = fileLogFd == null ? process.stderr.fd : fileLogFd;
  if (typeof fd !== "number" || fd < 0) return;
  const state = stream && stream._writableState;
  if (!state || !Array.isArray(state.buffered)) {
    const drained = writeBounded(fd, fileLogPending, maxBytes, false);
    setPending(drained.kept);
    return;
  }
  const drained = writeBounded(fd, state.buffered, maxBytes, true);
  state.buffered = drained.kept;
  state.length = drained.length;
  if (typeof state.bufferedIndex === "number") state.bufferedIndex = 0;
  setPending(drained.kept.map((item) => chunkBytes(item)));
}

// Keep the next console.error in the queue. An idle stream would otherwise
// hand that line to an async write, where flush can no longer see it.
export function pauseFileLog() {
  const stream = fileLogStream;
  if (!stream || typeof stream.cork !== "function" || stream.destroyed) return;
  try {
    stream.cork();
  } catch { /* the flush still runs */ }
}

// One window for every fatal line in this exit, notice included.
export const FATAL_RETRY_MS = 100;
export const FATAL_FALLBACK_NAME = "fatal.log";

export function setFatalFallbackDir(dir) {
  fatalFallbackDir = dir ? path.resolve(String(dir)) : null;
}

function waitForPipe(ms) {
  if (ms > 0) Atomics.wait(fatalWait, 0, 0, ms);
}

const GROUP_OR_OTHER_WRITE = 0o022;
const STICKY = 0o1000;
const FATAL_RESTART_LINE = "fatal log restarted\n";

// Every directory on the state path, not only the last component. A symlink
// is refused even when root owns it. Other owner rules match the helper walk:
// root or this user, and group or other write only on a sticky root directory.
function stateDirAllowed(dir, uid) {
  if (typeof uid !== "number") return false;
  const abs = path.resolve(dir);
  const parts = abs.split(path.sep).filter(Boolean);
  let cursor = path.parse(abs).root;
  const check = (st) => {
    if (!st || st.isSymbolicLink() || !st.isDirectory()) return false;
    const writable = (st.mode & GROUP_OR_OTHER_WRITE) !== 0;
    const stickyRoot = (st.mode & STICKY) !== 0 && st.uid === 0;
    if (writable && !stickyRoot) return false;
    if (st.uid !== 0 && st.uid !== uid) return false;
    return true;
  };
  let rootStat;
  try {
    rootStat = lstatSync(cursor);
  } catch {
    return false;
  }
  if (!check(rootStat)) return false;
  for (const part of parts) {
    cursor = path.join(cursor, part);
    let st;
    try {
      st = lstatSync(cursor);
    } catch {
      return false;
    }
    if (!check(st)) return false;
  }
  return cursor === abs;
}

function refuseFatalFallback(stderrFd, bytes) {
  try {
    if (typeof stderrFd === "number" && stderrFd >= 0 && bytes && bytes.length > 0) writeSync(stderrFd, bytes);
  } catch { /* one attempt, then the exit continues */ }
  return false;
}

function fatalPayload(size, bytes) {
  const incoming = Buffer.isBuffer(bytes) ? bytes : Buffer.from(String(bytes));
  if (size + incoming.length <= FILE_LOG_CAP) return { restart: false, bytes: incoming };
  const marker = Buffer.from(FATAL_RESTART_LINE);
  const room = FILE_LOG_CAP - marker.length;
  if (room <= 0) return null;
  const body = incoming.length > room ? incoming.subarray(incoming.length - room) : incoming;
  return { restart: true, bytes: Buffer.concat([marker, body]) };
}

// A full pipe refuses the write with EAGAIN. Retry until the window is
// gone, then append the unread bytes to a fixed file. The state directory
// is opened as a descriptor and walked first: no symlink anywhere on its
// path. The file is opened O_NOFOLLOW|O_APPEND|O_CREAT, then fstat must
// show a regular file, one link, and our uid before any fchmod or write.
// Past 1 MiB the file is truncated and restarted with a marker. A refusal
// skips the file and tries stderr once.
function appendFatalFallback(bytes, stderrFd) {
  if (!fatalFallbackDir || !bytes || bytes.length === 0) return false;
  const nofollow = fsConstants.O_NOFOLLOW;
  const directory = fsConstants.O_DIRECTORY;
  if (typeof nofollow !== "number" || typeof directory !== "number") return refuseFatalFallback(stderrFd, bytes);
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  if (!stateDirAllowed(fatalFallbackDir, uid)) return refuseFatalFallback(stderrFd, bytes);
  let dirfd = -1;
  let fd = -1;
  try {
    dirfd = openSync(fatalFallbackDir, fsConstants.O_RDONLY | directory | nofollow);
    const openedDir = fstatSync(dirfd);
    const listedDir = lstatSync(fatalFallbackDir);
    if (
      !openedDir.isDirectory() ||
      openedDir.isSymbolicLink() ||
      openedDir.dev !== listedDir.dev ||
      openedDir.ino !== listedDir.ino
    ) {
      return refuseFatalFallback(stderrFd, bytes);
    }
    const filePath = process.platform === "linux"
      ? "/proc/self/fd/" + dirfd + "/" + FATAL_FALLBACK_NAME
      : path.join(fatalFallbackDir, FATAL_FALLBACK_NAME);
    fd = openSync(
      filePath,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_APPEND | nofollow,
      0o600,
    );
    const st = fstatSync(fd);
    if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1 || st.uid !== uid) {
      return refuseFatalFallback(stderrFd, bytes);
    }
    const payload = fatalPayload(st.size, bytes);
    if (!payload) return refuseFatalFallback(stderrFd, bytes);
    fchmodSync(fd, 0o600);
    if (payload.restart) ftruncateSync(fd, 0);
    writeSync(fd, payload.bytes);
    return true;
  } catch {
    return refuseFatalFallback(stderrFd, bytes);
  } finally {
    if (fd >= 0) {
      try { closeSync(fd); } catch { /* the exit still runs */ }
    }
    if (dirfd >= 0) {
      try { closeSync(dirfd); } catch { /* the exit still runs */ }
    }
  }
}

function writeFatalLine(fd, line, deadline) {
  if (!line) return;
  const bytes = Buffer.isBuffer(line) ? line : Buffer.from(String(line));
  let offset = 0;
  while (offset < bytes.length) {
    try {
      const wrote = writeSync(fd, bytes, offset, bytes.length - offset);
      if (wrote > 0) {
        offset += wrote;
        continue;
      }
    } catch (error) {
      if (!isAgain(error)) throw error;
    }
    const left = deadline - Date.now();
    if (left <= 0) {
      appendFatalFallback(bytes.subarray(offset), fd);
      return;
    }
    waitForPipe(Math.min(5, left));
  }
}

export function logFatal(secrets, ...parts) {
  pauseFileLog();
  const notice = takeDropNotice();
  try {
    flushFileLog();
  } catch (error) {
    if (!isAgain(error)) throw error;
  }
  const fd = fileLogFd == null ? process.stderr.fd : fileLogFd;
  const deadline = Date.now() + FATAL_RETRY_MS;
  writeFatalLine(fd, notice, deadline);
  writeFatalLine(fd, stampLine(formatParts(secrets, parts)) + "\n", deadline);
}

// Node writes a regular file with writeSync. On the Apple runner those
// writes were the multi-second event-loop gaps: the lag line went out
// through console.error, the write blocked, and the next tick logged a
// longer gap. An async stream on the same fd keeps the bytes in that
// file and returns before the kernel finishes.
// A stalled pipe used to keep every line. One run queued 303 MB in 3s.
// Past this cap, further lines are dropped and one notice is written.
export const FILE_LOG_CAP = 1024 * 1024;
const DROP_NOTICE_RESERVE = 96;

export function installFileLog(fd = process.stderr.fd, options = {}) {
  const cap = Number(options.cap) > 0 ? Number(options.cap) : FILE_LOG_CAP;
  const previous = console.error;
  const previousFd = fileLogFd;
  const previousStream = fileLogStream;
  const previousPending = fileLogPending;
  const previousPendingBytes = fileLogPendingBytes;
  const previousNotice = takeDropNotice;
  const previousFallback = fatalFallbackDir;
  fileLogFd = fd;
  setPending([]);
  if (options.fallbackDir) fatalFallbackDir = path.resolve(String(options.fallbackDir));
  const highWaterMark = Math.min(16 * 1024, Math.max(1024, Math.floor(cap / 2)));
  const stream = createWriteStream("", { fd, autoClose: false, highWaterMark });
  stream.on("error", () => {});
  fileLogStream = stream;
  let dropped = 0;
  let announced = false;

  function noticeText() {
    return stampLine(dropped + " lines dropped") + "\n";
  }

  function announce() {
    if (announced || dropped === 0) return;
    const text = noticeText();
    const bytes = Buffer.from(text);
    if (heldLogBytes(stream) + bytes.length > cap) return;
    announced = true;
    rememberPending(bytes);
    stream.write(text, () => forgetPending(bytes));
  }

  // A fatal exit cannot wait for drain. The notice is written after the
  // queued lines and before the fatal line, even when the cap is full.
  takeDropNotice = () => {
    if (announced || dropped === 0) return "";
    announced = true;
    return noticeText();
  };

  stream.on("drain", announce);
  const end = stream.end;
  stream.end = function endAndNote(...args) {
    announce();
    return end.apply(stream, args);
  };

  console.error = (...args) => {
    const text = formatWithOptions({ colors: false }, ...args) + "\n";
    const size = Buffer.byteLength(text);
    const reserve = announced ? 0 : DROP_NOTICE_RESERVE;
    if (heldLogBytes(stream) + size + reserve > cap) {
      dropped += 1;
      return;
    }
    const bytes = Buffer.from(text);
    rememberPending(bytes);
    stream.write(text, () => forgetPending(bytes));
  };

  return {
    stream,
    get dropped() {
      return dropped;
    },
    get held() {
      return fileLogPendingBytes;
    },
    restore() {
      console.error = previous;
      fileLogFd = previousFd;
      fileLogStream = previousStream;
      fileLogPending = previousPending;
      fileLogPendingBytes = previousPendingBytes;
      takeDropNotice = previousNotice;
      fatalFallbackDir = previousFallback;
    },
  };
}
