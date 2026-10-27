// Scrub secrets before anything is printed. The git token and the relay
// token must never appear in a log line.
import { closeSync, constants as fsConstants, createWriteStream, fchmodSync, fstatSync, ftruncateSync, lstatSync, openSync, writeSync } from "node:fs";
import { builtinModules } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { formatWithOptions } from "node:util";

// This file lives at relay/src. A stack frame under that tree is shown
// repo-relative. A vault path that only looks like relay/src is not.
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

const SLASH_ALLOW = new Set(["HTTP/1.1", "KB/s", "MB/s", "application/json", "text/plain"]);
const NOTE_EXTS = ["markdown", "mdx", "txt", "md"];
const SHIELD = "\uE000";
// After a full scrub, anything past this size is dropped. A secret that
// straddles the cut is masked first, so its head is not left behind.
export const REDACT_INPUT_CAP = 64 * 1024;
// How much of a listed secret is read with each chunk. The overlap is the
// whole pattern, so a match on the join is replaced before the next chunk.
const REDACT_CHUNK = 64 * 1024;
// How far a cut walks back to finish a token. A line with no break in this
// window keeps the character boundary instead of collapsing to the marker.
const CAP_BREAK_WINDOW = 256;
// A Node stack frame we may show. Only node:internal/... and a Node builtin
// module. The path is lowercase with no `..` and no note suffix.
const NODE_FRAME = /^node:[a-z0-9_./]+(?:\.js)?:\d+:\d+$/;
const NODE_BUILTINS = new Set(builtinModules.map((name) => name.startsWith("node:") ? name.slice(5) : name));

function cutAtBreak(text, cap) {
  const buf = Buffer.from(text);
  if (buf.length <= cap) return text;
  let end = cap;
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end -= 1;
  let head = buf.toString("utf8", 0, end);
  const floor = Math.max(0, head.length - CAP_BREAK_WINDOW);
  let cut = head.length;
  while (cut > floor && !isBreak(head.charCodeAt(cut - 1))) cut -= 1;
  if (cut > floor && cut < head.length) head = head.slice(0, cut);
  return head.replace(/\[+$/, "");
}

// One pass. The marker is a private-use character that the input no longer
// contains, so a frame is put back without scanning the line once per frame.
export function restoreShields(text, kept) {
  return String(text).replace(/\uE000([0-9a-f]+)\uE000/g, (_marker, hex) => {
    const value = kept[parseInt(hex, 16)];
    return value ?? "";
  });
}

// Replace needle in chunks. The unsent tail is one shorter than the needle,
// so a match that straddles two chunks is still whole when it is replaced.
function maskLiteral(text, needle, replacement) {
  if (!needle) return text;
  const n = needle.length;
  const step = Math.max(REDACT_CHUNK, n);
  let pending = "";
  let out = "";
  const take = (final) => {
    const hold = final ? 0 : n - 1;
    let commit = pending.length - hold;
    if (commit <= 0) return;
    let i = 0;
    let piece = "";
    while (i < commit) {
      const at = pending.indexOf(needle, i);
      if (at === -1 || at >= commit) {
        piece += pending.slice(i, commit);
        i = commit;
        break;
      }
      piece += pending.slice(i, at) + replacement;
      i = at + n;
      if (i > commit) commit = i;
    }
    out += piece;
    pending = pending.slice(commit);
  };
  for (let i = 0; i < text.length; i += step) {
    pending += text.slice(i, Math.min(text.length, i + step));
    take(false);
  }
  take(true);
  return out;
}

export function redact(text, secrets) {
  // Strip the shield marker before any scrubbing so a log line cannot forge
  // a kept frame. Mask the whole text, at every size, then cut. A listed
  // secret is replaced in chunks whose overlap is the whole pattern, so a
  // space or a line break on the 64 KB boundary cannot leave the head behind.
  let out = String(text ?? "").replace(/\uE000/g, "");
  const list = [];
  for (const secret of secrets || []) {
    const value = String(secret || "").trim();
    if (value && !list.includes(value)) list.push(value);
  }
  for (const secret of list) {
    out = maskLiteral(out, secret, "***");
    const encoded = encodeURIComponent(secret);
    if (encoded !== secret) out = maskLiteral(out, encoded, "***");
  }
  out = out.replace(/x-access-token:[^@\s]+/gi, "x-access-token:***");
  out = out.replace(/Bearer\s+\S+/gi, "Bearer ***");
  out = out.replace(/Authorization:\s*Basic\s+\S+/gi, "Authorization: Basic ***");
  out = out.replace(/AIDANOS_(?:RELAY|VAULT_GIT)_TOKEN=\S+/g, "AIDANOS_TOKEN=***");
  out = out.replace(/https?:\/\/[^\s]+/gi, "[url]");
  // Same scrub for stderr and fatal.log. A vault path or a note file name
  // must not land in either. Document ids have neither a slash nor a .md suffix.
  // Scrub runs before the cut so a path or a spaced note name that crosses
  // 8 KB is already [path] or [note], not a leftover prefix.
  const kept = [];
  out = scrubLocations(out, kept);
  out = out.replace(/file:\/\/\S+/gi, "[url]");
  out = restoreShields(out, kept);
  out = cutAtBreak(out, REDACT_INPUT_CAP);
  return capLocations(out);
}

// One log line, then the marker. The cut is applied to text that is already
// scrubbed, and the last partial token is dropped so the marker does not
// keep the start of a path.
export const LOG_LINE_CAP = 8 * 1024;

function shield(kept, text) {
  const token = SHIELD + kept.length.toString(16) + SHIELD;
  kept.push(text);
  return token;
}

// Token boundaries. A slash stays inside the token so /a/b and a/b are one path.
function isBreak(code) {
  return code <= 32 || code === 34 || code === 39 || code === 40 || code === 41
    || code === 58 || code === 60 || code === 61 || code === 62 || code === 91
    || code === 93 || code === 96;
}

function isDigit(code) {
  return code >= 48 && code <= 57;
}

function isRatio(token) {
  let slash = -1;
  for (let i = 0; i < token.length; i += 1) {
    const code = token.charCodeAt(i);
    if (code === 47) {
      if (slash !== -1 || i === 0 || i + 1 === token.length) return false;
      slash = i;
      continue;
    }
    if (!isDigit(code)) return false;
  }
  return slash !== -1;
}

// :line:col after a path. Returns the index just past the column, or 0.
function stackTail(line, i) {
  const n = line.length;
  if (i >= n || line.charCodeAt(i) !== 58) return 0;
  let j = i + 1;
  if (j >= n || !isDigit(line.charCodeAt(j))) return 0;
  while (j < n && isDigit(line.charCodeAt(j))) j += 1;
  if (j >= n || line.charCodeAt(j) !== 58) return 0;
  j += 1;
  if (j >= n || !isDigit(line.charCodeAt(j))) return 0;
  while (j < n && isDigit(line.charCodeAt(j))) j += 1;
  return j;
}

function repoFrame(absPath) {
  if (!absPath || absPath.includes("\0")) return "";
  const abs = path.resolve(absPath);
  const root = REPO_ROOT.endsWith(path.sep) ? REPO_ROOT : REPO_ROOT + path.sep;
  if (!abs.startsWith(root)) return "";
  const rel = path.relative(REPO_ROOT, abs).split(path.sep).join("/");
  if (!rel.startsWith("relay/") || rel.split("/").includes("..") || rel.split("/").includes("")) return "";
  return rel;
}

function fileUrlFrame(url) {
  const lower = url.slice(0, 7).toLowerCase();
  if (lower !== "file://") return "";
  let body = url.slice(7);
  const tailAt = body.lastIndexOf(":");
  if (tailAt <= 0) return "";
  const lineAt = body.lastIndexOf(":", tailAt - 1);
  if (lineAt <= 0) return "";
  const tail = stackTail(body, lineAt);
  if (tail !== body.length) return "";
  const abs = body.slice(0, lineAt);
  const shown = repoFrame(abs);
  if (!shown) return "";
  return shown + body.slice(lineAt);
}

function capScrubbed(line) {
  const buf = Buffer.from(line);
  if (buf.length <= LOG_LINE_CAP) return line;
  let end = LOG_LINE_CAP;
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end -= 1;
  let head = buf.toString("utf8", 0, end);
  if (end < buf.length) {
    const floor = Math.max(0, head.length - CAP_BREAK_WINDOW);
    let cut = head.length;
    while (cut > floor && !isBreak(head.charCodeAt(cut - 1))) cut -= 1;
    // A break in the last 256 bytes ends the line on that token, which drops
    // a partial path. No break: keep the character-boundary cut, about 8 KB.
    if (cut > floor) head = head.slice(0, cut);
  }
  // '[' is a break, so a cut inside [[path]] keeps the brackets and the
  // marker would read [[truncated]. Drop every leftover bracket.
  head = head.replace(/\[+$/, "");
  return head + "[truncated]";
}

function nodeFrameEnd(line, i) {
  if (!line.startsWith("node:", i)) return 0;
  let j = i + 5;
  let end = 0;
  const n = line.length;
  while (j < n) {
    const code = line.charCodeAt(j);
    if (code === 58) {
      const tail = stackTail(line, j);
      if (!tail) return 0;
      end = tail;
      break;
    }
    if (isBreak(code)) return 0;
    j += 1;
  }
  if (!end) return 0;
  const frame = line.slice(i, end);
  if (!nodeBuiltinFrame(frame)) return 0;
  return end;
}

function nodeBuiltinFrame(frame) {
  if (!NODE_FRAME.test(frame) || frame.includes("..")) return false;
  const pathPart = frame.slice(5).replace(/(?:\.js)?:\d+:\d+$/, "");
  if (pathPart !== pathPart.toLowerCase()) return false;
  for (const ext of NOTE_EXTS) {
    if (pathPart.endsWith("." + ext) || pathPart.includes("." + ext + "/")) return false;
  }
  if (pathPart === "internal" || pathPart.startsWith("internal/")) return true;
  return NODE_BUILTINS.has(pathPart);
}

// One forward pass. Each character is copied or skipped once, so a line of
// '(a/' or 'a/a/a/' cannot blow up the way a nested quantifier did.
function scrubPaths(line, kept) {
  const n = line.length;
  const parts = [];
  let i = 0;
  while (i < n) {
    const start = i;
    while (i < n && isBreak(line.charCodeAt(i))) i += 1;
    if (i > start) parts.push(line.slice(start, i));
    if (i >= n) break;
    if (line.startsWith("file://", i)) {
      let j = i + 7;
      while (j < n && line.charCodeAt(j) > 32 && line.charCodeAt(j) !== 41) j += 1;
      const url = line.slice(i, j);
      const shown = fileUrlFrame(url);
      parts.push(shown ? shield(kept, shown) : url);
      i = j;
      continue;
    }
    const nodeEnd = nodeFrameEnd(line, i);
    if (nodeEnd) {
      parts.push(shield(kept, line.slice(i, nodeEnd)));
      i = nodeEnd;
      continue;
    }
    if (driveAt(line, i)) {
      const tokenStart = i;
      i += 2;
      while (i < n && !isBreak(line.charCodeAt(i))) i += 1;
      parts.push(line.slice(tokenStart, i).length ? "[path]" : "");
      continue;
    }
    const tokenStart = i;
    let slash = false;
    let encoded = false;
    while (i < n && !isBreak(line.charCodeAt(i))) {
      const code = line.charCodeAt(i);
      if (code === 47 || code === 92) slash = true;
      if (code === 37 && i + 2 < n && line.charCodeAt(i + 1) === 50) {
        const hex = line.charCodeAt(i + 2);
        if (hex === 70 || hex === 102) encoded = true;
      }
      i += 1;
    }
    const token = line.slice(tokenStart, i);
    const tail = stackTail(line, i);
    if (tail && (token.startsWith("/") || token.startsWith("\\"))) {
      const shown = repoFrame(token);
      if (shown) {
        parts.push(shield(kept, shown + line.slice(i, tail)));
        i = tail;
        continue;
      }
    }
    if (SLASH_ALLOW.has(token) || isRatio(token)) {
      parts.push(token);
      continue;
    }
    parts.push(slash || encoded ? "[path]" : token);
  }
  return parts.join("");
}

function driveAt(line, i) {
  if (i + 2 >= line.length) return false;
  const code = line.charCodeAt(i);
  const letter = (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
  if (!letter || line.charCodeAt(i + 1) !== 58) return false;
  const sep = line.charCodeAt(i + 2);
  return sep === 92 || sep === 47;
}

function matchNoteExt(line, i) {
  if (i >= line.length || line.charCodeAt(i) !== 46) return 0;
  for (const ext of NOTE_EXTS) {
    const after = i + 1 + ext.length;
    if (after > line.length) continue;
    let ok = true;
    for (let k = 0; k < ext.length; k += 1) {
      let code = line.charCodeAt(i + 1 + k);
      if (code >= 65 && code <= 90) code += 32;
      if (code !== ext.charCodeAt(k)) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;
    if (after < line.length) {
      const code = line.charCodeAt(after);
      const word = (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || code === 95;
      if (word) continue;
    }
    return after;
  }
  return 0;
}

// A note name may contain spaces. The left edge is the line start, a quote,
// a colon, or a slash. Walking stops at a span already claimed, so the pass
// stays linear. .md, .txt, .markdown, and .mdx match in either case.
function scrubNotes(line) {
  const n = line.length;
  const drop = new Uint8Array(n);
  let i = 0;
  while (i < n) {
    const ext = matchNoteExt(line, i);
    if (!ext) {
      i += 1;
      continue;
    }
    let start = i;
    while (start > 0 && !drop[start - 1]) {
      const c = line.charCodeAt(start - 1);
      if (c === 39 || c === 34 || c === 96 || c === 58 || c === 47 || c === 10) break;
      start -= 1;
    }
    for (let k = start; k < ext; k += 1) drop[k] = 1;
    i = ext;
  }
  const parts = [];
  let k = 0;
  while (k < n) {
    if (!drop[k]) {
      const start = k;
      while (k < n && !drop[k]) k += 1;
      parts.push(line.slice(start, k));
      continue;
    }
    while (k < n && drop[k]) k += 1;
    parts.push("[note]");
  }
  return parts.join("");
}

function scrubLine(line, kept) {
  return scrubNotes(scrubPaths(line, kept));
}

function scrubLocations(text, kept) {
  const lines = String(text).split("\n");
  for (let i = 0; i < lines.length; i += 1) lines[i] = scrubLine(lines[i], kept);
  return lines.join("\n");
}

function capLocations(text) {
  const lines = String(text).split("\n");
  for (let i = 0; i < lines.length; i += 1) lines[i] = capScrubbed(lines[i]);
  return lines.join("\n");
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
  if (typeof uid !== "number") return null;
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
    return null;
  }
  if (!check(rootStat)) return null;
  // The leaf's dev+ino is the one the open must match. A later lstat can
  // name a different directory than the one this walk accepted.
  let recorded = rootStat;
  for (const part of parts) {
    cursor = path.join(cursor, part);
    let st;
    try {
      st = lstatSync(cursor);
    } catch {
      return null;
    }
    if (!check(st)) return null;
    recorded = st;
  }
  if (cursor !== abs) return null;
  return { dev: recorded.dev, ino: recorded.ino };
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
  const recorded = stateDirAllowed(fatalFallbackDir, uid);
  if (!recorded) return refuseFatalFallback(stderrFd, bytes);
  let dirfd = -1;
  let fd = -1;
  try {
    dirfd = openSync(fatalFallbackDir, fsConstants.O_RDONLY | directory | nofollow);
    const openedDir = fstatSync(dirfd);
    if (
      !openedDir.isDirectory() ||
      openedDir.isSymbolicLink() ||
      openedDir.dev !== recorded.dev ||
      openedDir.ino !== recorded.ino
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
