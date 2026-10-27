import crypto from "node:crypto";
import { closeSync, constants as fsConstants, fstatSync, openSync, readSync, realpathSync, unlinkSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import * as Automerge from "@automerge/automerge";
import {
  createExclusive,
  directoryBackend,
  openCheckedDirectory,
  openDirectoryHelper,
  renameEntry,
  statEntry,
  unlinkIfSame,
} from "../../editor/dirfd.mjs";
import { noteMirror } from "./index-trace.mjs";
import { logSafe } from "./redact.mjs";
import { prepareNoteFile, safeNotePath } from "./paths.mjs";

function yieldNow() {
  return new Promise((resolve) => setImmediate(resolve));
}

function noteText(doc) {
  if (!doc || doc.kind !== "note") return null;
  if (typeof doc.text === "string") return doc.text;
  if (doc.text == null) return "";
  return null;
}

function changes(before, after) {
  const oldText = String(before);
  const newText = String(after);
  let prefix = 0;
  const limit = Math.min(oldText.length, newText.length);
  while (prefix < limit && oldText[prefix] === newText[prefix]) prefix += 1;
  let suffix = 0;
  while (
    suffix < oldText.length - prefix &&
    suffix < newText.length - prefix &&
    oldText[oldText.length - 1 - suffix] === newText[newText.length - 1 - suffix]
  ) {
    suffix += 1;
  }
  const oldMid = oldText.slice(prefix, oldText.length - suffix);
  const newMid = newText.slice(prefix, newText.length - suffix);
  if (!oldMid && !newMid) return [];
  if (oldMid && newMid.includes(oldMid)) {
    const at = newMid.indexOf(oldMid);
    const edits = [];
    if (at > 0) edits.push({ start: prefix, delete: 0, insert: newMid.slice(0, at) });
    const tail = newMid.slice(at + oldMid.length);
    if (tail) edits.push({ start: prefix + oldMid.length, delete: 0, insert: tail });
    return edits;
  }
  if (newMid && oldMid.includes(newMid)) {
    const at = oldMid.indexOf(newMid);
    const edits = [];
    if (at > 0) edits.push({ start: prefix, delete: at, insert: "" });
    const tail = oldMid.length - (at + newMid.length);
    if (tail > 0) edits.push({ start: prefix + at + newMid.length, delete: tail, insert: "" });
    return edits;
  }
  return [{ start: prefix, delete: oldMid.length, insert: newMid }];
}

function mapEdit(edit, remotes) {
  let delta = 0;
  for (const remote of remotes) {
    if (remote.start + remote.delete < edit.start) delta += remote.insert.length - remote.delete;
  }
  return { start: edit.start + delta, delete: edit.delete, insert: edit.insert };
}

function sameEdit(left, right) {
  return left.start === right.start && left.delete === right.delete && left.insert === right.insert;
}

function applyEdits(text, edits) {
  let result = text;
  let shift = 0;
  for (const edit of edits) {
    const start = Math.max(0, Math.min(result.length, edit.start + shift));
    const del = Math.max(0, Math.min(edit.delete, result.length - start));
    result = result.slice(0, start) + edit.insert + result.slice(start + del);
    shift += edit.insert.length - del;
  }
  return result;
}

function spliceToward(doc, next) {
  const current = typeof doc.text === "string" ? doc.text : "";
  if (current === next) return;
  let prefix = 0;
  const limit = Math.min(current.length, next.length);
  while (prefix < limit && current[prefix] === next[prefix]) prefix += 1;
  let suffix = 0;
  while (
    suffix < current.length - prefix &&
    suffix < next.length - prefix &&
    current[current.length - 1 - suffix] === next[next.length - 1 - suffix]
  ) {
    suffix += 1;
  }
  const del = current.length - prefix - suffix;
  const insert = next.slice(prefix, next.length - suffix);
  Automerge.splice(doc, ["text"], prefix, del, insert);
}

function digest(text) {
  return crypto.createHash("sha256").update(String(text), "utf8").digest("hex");
}

// `.{note}.md.{pid}.tmp` beside the note. The pid is the relay's, so a later
// start can tell a crashed write from one this process still holds.
const NOTE_TEMP_BASENAME = /^\.(.+\.md)\.(\d+)\.tmp$/;
const RELAY_MARKER_HEADER = "aidanos-relay-folder v2";
const RELAY_MARKER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const NOTE_TEMP_MANIFEST = "note-temps";
export const MANIFEST_REFUSED_LINE = "note temp manifest refused";
export const MANIFEST_RESET_LINE = "note temp manifest reset";
const MANIFEST_CAP = 1024 * 1024;
const GROUP_OR_OTHER_WRITE = 0o022;
const STICKY = 0o1000;
const openNoteTemps = new Map();
let manifestChain = Promise.resolve();
const manifestRefusalLogged = new Set();
const manifestResetLogged = new Set();
// path.resolve(vault) -> realpath(vault). Filled once at claim. A save must
// not call realpath again: on macOS that stat walks /var -> /private/var
// and it blocks the process.
const vaultRoots = new Map();

export function rememberVaultRoot(vault) {
  if (!vault) return "";
  const key = path.resolve(vault);
  try {
    const real = realpathSync(key);
    vaultRoots.set(key, real);
    return real;
  } catch {
    vaultRoots.set(key, key);
    return key;
  }
}

function vaultRoot(vault) {
  const key = path.resolve(vault);
  if (vaultRoots.has(key)) return vaultRoots.get(key);
  return rememberVaultRoot(vault);
}

function noteTempPath(file, pid = process.pid) {
  return path.join(path.dirname(file), `.${path.basename(file)}.${pid}.tmp`);
}

function withManifest(work) {
  const run = manifestChain.then(work, work);
  manifestChain = run.then(() => {}, () => {});
  return run;
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 1) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !error || error.code !== "ESRCH";
  }
}

async function removeOwnedRegular(file) {
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  if (typeof uid !== "number") return;
  let st;
  try {
    st = await fs.lstat(file);
  } catch {
    return;
  }
  if (st.isSymbolicLink() || !st.isFile() || st.uid !== uid) return;
  try {
    await fs.unlink(file);
  } catch { /* already gone, or it changed under us */ }
}

// Temps this process has written and not yet renamed. Called when the save
// wait gives up, so the whole note does not stay in the vault under a dot name.
export async function discardOpenNoteTemps() {
  const pending = [...openNoteTemps.entries()];
  await Promise.all(pending.map(async ([file, meta]) => {
    await removeOwnedRegular(file);
    await dropManifestIfGone(file, meta);
  }));
}

function markerTextId(text) {
  if (typeof text !== "string") return "";
  const lines = text.split("\n");
  if (lines.length !== 3 || lines[2] !== "") return "";
  if (lines[0] !== RELAY_MARKER_HEADER || !RELAY_MARKER_ID.test(lines[1])) return "";
  return lines[1];
}

function outsideMarker(vault) {
  const resolved = path.resolve(vault);
  return path.join(path.dirname(resolved), "." + path.basename(resolved) + ".aidanos-relay-id");
}

function readRegularFile(file) {
  let fd;
  try {
    fd = openSync(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch {
    return null;
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.size > 1024 * 1024) return null;
    const buf = Buffer.alloc(st.size);
    let off = 0;
    while (off < buf.length) {
      const n = readSync(fd, buf, off, buf.length - off, off);
      if (n <= 0) break;
      off += n;
    }
    return buf.toString("utf8", 0, off);
  } finally {
    closeSync(fd);
  }
}

async function markersMatch(vault, stateDir) {
  if (!vault || !stateDir) return false;
  const vaultId = markerTextId(readRegularFile(path.join(vault, ".aidanos", "relay-folder")));
  const dataId = markerTextId(readRegularFile(path.join(stateDir, "relay-folder")));
  const outsideId = markerTextId(readRegularFile(outsideMarker(vault)));
  return Boolean(vaultId && vaultId === dataId && vaultId === outsideId);
}

function parseManifestLine(line) {
  if (typeof line !== "string" || !line || line.includes("\\") || line.includes("\0")) return null;
  if (line.startsWith("/") || path.win32.isAbsolute(line)) return null;
  const parts = line.split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..")) return null;
  for (let i = 0; i < parts.length - 1; i += 1) {
    if (parts[i].startsWith(".")) return null;
  }
  const match = NOTE_TEMP_BASENAME.exec(parts[parts.length - 1]);
  if (!match) return null;
  const pid = Number(match[2]);
  if (!Number.isSafeInteger(pid)) return null;
  return { rel: line, pid };
}

function unlinkSameFile(file, dev, ino, uid) {
  let fd;
  try {
    fd = openSync(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch {
    return false;
  }
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== dev || opened.ino !== ino || opened.uid !== uid) return false;
  } finally {
    closeSync(fd);
  }
  try {
    unlinkSync(file);
  } catch {
    return false;
  }
  return true;
}

async function unlinkOwnedTemp(vault, rel, uid) {
  const root = path.resolve(vault);
  let cursor = root;
  let rootSt;
  try {
    rootSt = await fs.lstat(cursor);
  } catch {
    return "keep";
  }
  if (rootSt.isSymbolicLink() || !rootSt.isDirectory()) return "keep";
  const parts = rel.split("/");
  for (let i = 0; i < parts.length; i += 1) {
    cursor = path.join(cursor, parts[i]);
    let st;
    try {
      st = await fs.lstat(cursor);
    } catch (error) {
      return error && error.code === "ENOENT" ? "drop" : "keep";
    }
    if (st.isSymbolicLink()) return "keep";
    if (i + 1 < parts.length) {
      if (!st.isDirectory()) return "keep";
      continue;
    }
    if (!st.isFile() || st.nlink !== 1 || st.uid !== uid) return "keep";
    return unlinkSameFile(cursor, st.dev, st.ino, uid) ? "drop" : "keep";
  }
  return "keep";
}

function manifestNoticeKey(stateDir) {
  return path.resolve(stateDir);
}

function logManifestNotice(stateDir, kind) {
  const seen = kind === "reset" ? manifestResetLogged : manifestRefusalLogged;
  const key = manifestNoticeKey(stateDir);
  if (seen.has(key)) return;
  seen.add(key);
  logSafe([], kind === "reset" ? MANIFEST_RESET_LINE : MANIFEST_REFUSED_LINE);
}

export function manifestNoticeLogged(stateDir) {
  const key = manifestNoticeKey(stateDir);
  return {
    refused: manifestRefusalLogged.has(key),
    reset: manifestResetLogged.has(key),
  };
}

// Same directory walk fatal.log uses before it opens the state folder.
// A symlink anywhere on the path is refused. Group or other write is
// allowed only on a sticky directory owned by root.
async function recordedStateDir(dir, uid) {
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
    rootStat = await fs.lstat(cursor);
  } catch {
    return null;
  }
  if (!check(rootStat)) return null;
  let recorded = rootStat;
  for (const part of parts) {
    cursor = path.join(cursor, part);
    let st;
    try {
      st = await fs.lstat(cursor);
    } catch {
      return null;
    }
    if (!check(st)) return null;
    recorded = st;
  }
  if (cursor !== abs) return null;
  return { dev: recorded.dev, ino: recorded.ino };
}

function manifestAt(dirfd, stateDir, name) {
  if (process.platform === "linux") return "/proc/self/fd/" + dirfd + "/" + name;
  return path.join(stateDir, name);
}

let asideSeq = 0;

function asideManifestName() {
  asideSeq += 1;
  const stamp = new Date().toISOString().replace(/[^0-9T]/g, "");
  return NOTE_TEMP_MANIFEST + "." + stamp + "." + process.pid + "." + asideSeq;
}

function parsedManifest(text) {
  const raw = String(text).split("\n");
  if (raw.length && raw[raw.length - 1] === "") raw.pop();
  const lines = [];
  for (const line of raw) {
    if (!parseManifestLine(line)) return null;
    lines.push(line);
  }
  return lines;
}

async function readHandleText(handle, size) {
  if (!size) return "";
  const buf = Buffer.alloc(size);
  let off = 0;
  while (off < buf.length) {
    const { bytesRead } = await handle.read(buf, off, buf.length - off, off);
    if (!bytesRead) break;
    off += bytesRead;
  }
  return buf.toString("utf8", 0, off);
}

async function closeQuiet(handle) {
  if (!handle) return;
  try {
    await handle.close();
  } catch { /* already closed */ }
}

async function syncDirectory(dirHandle) {
  await dirHandle.sync();
}

async function openStateDirectory(stateDir) {
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  const nofollow = fsConstants.O_NOFOLLOW;
  const directory = fsConstants.O_DIRECTORY;
  if (typeof nofollow !== "number" || typeof directory !== "number" || typeof uid !== "number") {
    logManifestNotice(stateDir, "refused");
    return null;
  }
  const recorded = await recordedStateDir(stateDir, uid);
  if (!recorded) {
    logManifestNotice(stateDir, "refused");
    return null;
  }
  let dirHandle;
  try {
    dirHandle = await fs.open(stateDir, fsConstants.O_RDONLY | directory | nofollow);
  } catch {
    logManifestNotice(stateDir, "refused");
    return null;
  }
  try {
    const openedDir = await dirHandle.stat();
    if (
      !openedDir.isDirectory() ||
      openedDir.isSymbolicLink() ||
      openedDir.dev !== recorded.dev ||
      openedDir.ino !== recorded.ino
    ) {
      logManifestNotice(stateDir, "refused");
      await dirHandle.close();
      return null;
    }
    return { dirHandle, uid };
  } catch {
    logManifestNotice(stateDir, "refused");
    await closeQuiet(dirHandle);
    return null;
  }
}

async function quarantineManifest(dirHandle, stateDir) {
  const dirfd = dirHandle.fd;
  const aside = asideManifestName();
  await fs.rename(
    manifestAt(dirfd, stateDir, NOTE_TEMP_MANIFEST),
    manifestAt(dirfd, stateDir, aside),
  );
  await syncDirectory(dirHandle);
  logManifestNotice(stateDir, "reset");
}

// Read note-temps through the state directory descriptor. A hard link or a
// symlink is refused before any rename or chmod, so a note that shares the
// inode is left byte for byte. An oversized or unparseable file is renamed
// aside and the directory is fsynced.
async function readManifest(dirHandle, stateDir, uid) {
  const filePath = manifestAt(dirHandle.fd, stateDir, NOTE_TEMP_MANIFEST);
  let handle;
  try {
    handle = await fs.open(filePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch (error) {
    if (error && error.code === "ENOENT") return { missing: true, lines: [] };
    logManifestNotice(stateDir, "refused");
    return { refused: true, lines: [] };
  }
  try {
    const st = await handle.stat();
    if (!st.isFile() || st.isSymbolicLink() || st.uid !== uid || st.nlink !== 1) {
      logManifestNotice(stateDir, "refused");
      return { refused: true, lines: [] };
    }
    if (st.size > MANIFEST_CAP) {
      await handle.close();
      handle = null;
      await quarantineManifest(dirHandle, stateDir);
      return { reset: true, lines: [] };
    }
    const parsed = parsedManifest(await readHandleText(handle, st.size));
    if (parsed == null) {
      await handle.close();
      handle = null;
      await quarantineManifest(dirHandle, stateDir);
      return { reset: true, lines: [] };
    }
    return { lines: parsed };
  } finally {
    await closeQuiet(handle);
  }
}

// A new file, created O_EXCL at 0600, fsynced, then renamed over note-temps.
// The state directory is fsynced after that rename. The old file is never
// truncated in place.
async function publishManifest(dirHandle, stateDir, uid, lines) {
  const dirfd = dirHandle.fd;
  asideSeq += 1;
  const tmpName = NOTE_TEMP_MANIFEST + ".new." + process.pid + "." + asideSeq;
  const tmpPath = manifestAt(dirfd, stateDir, tmpName);
  const flags = fsConstants.O_RDWR | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW;
  const handle = await fs.open(tmpPath, flags, 0o600);
  try {
    const st = await handle.stat();
    if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1 || st.uid !== uid) {
      const error = new Error("manifest temp refused");
      error.code = "EPERM";
      throw error;
    }
    await handle.chmod(0o600);
    const body = lines.length ? lines.join("\n") + "\n" : "";
    if (body) await writeAllAt(handle, body);
    await handle.sync();
  } catch (error) {
    await closeQuiet(handle);
    try { await fs.unlink(tmpPath); } catch { /* the next open reports it */ }
    throw error;
  }
  await handle.close();
  await fs.rename(tmpPath, manifestAt(dirfd, stateDir, NOTE_TEMP_MANIFEST));
  await syncDirectory(dirHandle);
}

async function writeAllAt(handle, text) {
  const buf = Buffer.from(text);
  let off = 0;
  while (off < buf.length) {
    const { bytesWritten } = await handle.write(buf, off, buf.length - off, off);
    if (!bytesWritten) break;
    off += bytesWritten;
  }
  if (off !== buf.length) {
    const error = new Error("manifest write was short");
    error.code = "EIO";
    throw error;
  }
}

function sameLines(left, right) {
  if (left.length !== right.length) return false;
  for (let i = 0; i < left.length; i += 1) {
    if (left[i] !== right[i]) return false;
  }
  return true;
}

// One rewrite for this batch, two fsyncs: the new manifest file, then the
// state directory after the rename. A refusal writes nothing. The save
// still stores the note.
async function updateManifest(stateDir, create, mutate) {
  await fs.mkdir(stateDir, { recursive: true, mode: 0o700 });
  await withManifest(async () => {
    const opened = await openStateDirectory(stateDir);
    if (!opened) return;
    try {
      const current = await readManifest(opened.dirHandle, stateDir, opened.uid);
      if (current.refused) return;
      if (current.missing && !create) return;
      const next = await mutate(current.lines);
      if (!next) return;
      if (!current.reset && !current.missing && sameLines(next, current.lines)) return;
      await publishManifest(opened.dirHandle, stateDir, opened.uid, next);
    } catch {
      logManifestNotice(stateDir, "refused");
    } finally {
      await closeQuiet(opened.dirHandle);
    }
  });
}

// Only paths this relay recorded, and only after the folder markers match.
// Anything else — a home directory, a dot folder, a symlink, a path with `..` —
// stays where it is. There is no directory walk.
export async function sweepStaleNoteTemps(vault, stateDir) {
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  if (typeof uid !== "number") return;
  if (!(await markersMatch(vault, stateDir))) return;
  await updateManifest(stateDir, false, async (lines) => {
    const kept = [];
    for (const line of lines) {
      const parsed = parseManifestLine(line);
      if (!parsed || pidAlive(parsed.pid)) {
        kept.push(line);
        continue;
      }
      const action = await unlinkOwnedTemp(vault, parsed.rel, uid);
      if (action !== "drop") kept.push(line);
    }
    return kept;
  });
}

function relativeInside(root, file) {
  const rel = path.relative(root, file);
  if (!rel || rel === ".." || rel.startsWith(".." + path.sep) || path.isAbsolute(rel)) return "";
  return rel.split(path.sep).join("/");
}

// The note file is under realpath(vault). On macOS that can be /private/var
// while the configured vault is /var, and path.relative then looks like ../.
// The real path is the one remembered at claim, not a stat on this save.
function tempRelative(vault, file) {
  const abs = path.resolve(file);
  let posix = relativeInside(path.resolve(vault), abs);
  if (!posix) posix = relativeInside(vaultRoot(vault), abs);
  if (!posix || !parseManifestLine(posix)) {
    const error = new Error("note temp is outside the vault");
    error.code = "EINVAL";
    throw error;
  }
  return posix;
}

async function appendManifest(stateDir, rels) {
  const lines = (Array.isArray(rels) ? rels : [rels]).filter(Boolean);
  if (!lines.length || !stateDir) return;
  await updateManifest(stateDir, true, async (existing) => existing.concat(lines));
}

async function dropManifest(stateDir, rels) {
  if (!stateDir) return;
  const drop = new Set(Array.isArray(rels) ? rels : [rels]);
  await updateManifest(stateDir, false, async (existing) => existing.filter((line) => !drop.has(line)));
}

async function dropManifestIfGone(file, meta) {
  if (!meta || !meta.rel || !meta.stateDir) return;
  try {
    await fs.lstat(file);
    return;
  } catch (error) {
    if (!error || error.code !== "ENOENT") return;
  }
  await dropManifest(meta.stateDir, meta.rel);
}

function pathError(code) {
  const error = new Error("bad path");
  error.code = code || "BAD_PATH";
  return error;
}

async function closeQuietDir(handle) {
  if (!handle) return;
  try { await handle.close(); } catch { /* already closed */ }
}

// Temp in the checked folder, fsync, then renameat on that folder's descriptor.
// A crash before the rename leaves the previous note and a sibling temp.
// The manifest line is fsynced before the temp exists.
export async function replaceNoteAtomic(file, text, options = {}) {
  const vault = options.vault || "";
  const stateDir = options.stateDir || "";
  const tmp = options.tmp || noteTempPath(file);
  let rel = options.rel || "";
  if (!rel && options.recordManifest !== false && vault && stateDir) {
    rel = tempRelative(vault, tmp);
  }
  const record = options.recordManifest !== false && Boolean(stateDir && rel);
  if (record) await appendManifest(stateDir, [rel]);
  const meta = { rel, stateDir };
  openNoteTemps.set(tmp, meta);
  const backend = directoryBackend();
  const tool = await openDirectoryHelper();
  let dir = null;
  let created = null;
  try {
    const dirPath = path.dirname(file);
    const listed = await fs.lstat(dirPath);
    if (listed.isSymbolicLink() || !listed.isDirectory()) throw pathError("BAD_PATH");
    dir = await openCheckedDirectory(dirPath, { dev: listed.dev, ino: listed.ino });
    const destName = path.basename(file);
    const tmpName = path.basename(tmp);
    let destInfo = null;
    try {
      destInfo = await fs.lstat(file);
    } catch (error) {
      if (!error || error.code !== "ENOENT") throw error;
    }
    if (destInfo) {
      if (destInfo.isSymbolicLink()) throw pathError("ELOOP");
      if (!destInfo.isFile() || destInfo.nlink !== 1) throw pathError("BAD_PATH");
    }
    const listedEntry = await statEntry(dir, destName, backend, tool);
    if (listedEntry && (listedEntry.symlink || !listedEntry.regular)) throw pathError("ELOOP");
    const payload = Buffer.from(String(text), "utf8");
    if (options.crashMidWrite) {
      const count = Math.min(8, Math.max(1, payload.length));
      created = await createExclusive(dir, tmpName, payload.subarray(0, count), backend, { tool });
      process.kill(process.pid, "SIGKILL");
      await new Promise(() => {});
    }
    created = await createExclusive(dir, tmpName, payload, backend, { tool });
    if (typeof options.beforeRename === "function") await options.beforeRename();
    await renameEntry(dir, tmpName, destName, backend, tool);
    created = null;
    await dir.sync();
  } catch (error) {
    if (created && dir) {
      try { await unlinkIfSame(dir, path.basename(tmp), created, backend, tool); } catch { /* the sweep removes a temp we could not unlink */ }
    }
    throw error;
  } finally {
    await closeQuietDir(dir);
    if (tool && tool.handle) await closeQuietDir(tool.handle);
    openNoteTemps.delete(tmp);
    if (rel && stateDir) {
      try {
        await fs.lstat(tmp);
      } catch (error) {
        if (error && error.code === "ENOENT") await dropManifest(stateDir, [rel]);
      }
    }
  }
}

function siblingError(code) {
  const error = new Error(code === "RECOVER" ? "recovery sibling" : "outside edit unchecked");
  error.code = code;
  return error;
}

// null when the note may be written. An error when a temp or .recover file
// is sitting next to it, or the directory cannot be listed. A failed check
// refuses the write: skipping the check and writing the note drops the edit.
async function noteSiblingFault(file) {
  const dir = path.dirname(file);
  const base = path.basename(file);
  let names;
  try {
    names = await fs.readdir(dir);
  } catch (error) {
    if (error && error.code === "ENOENT") return null;
    return error && error.code ? error : siblingError("EREAD");
  }
  for (const name of names) {
    if (name.startsWith("." + base + ".") && name.endsWith(".tmp")) return siblingError("RECOVER");
    if (name.startsWith(base + ".") && name.endsWith(".recover")) return siblingError("RECOVER");
  }
  return null;
}

// Write each note beside its final name, then rename it into place through
// the checked directory. A reader sees the previous file or the whole new
// file. Every temp path in this batch is recorded before any of those temps
// exist. That record is two fsyncs: the new manifest file, then the state
// directory after the rename onto note-temps.
export async function saveNoteBatch(entries, options = {}) {
  const vault = options.vault || "";
  const stateDir = options.stateDir || "";
  const prepared = [];
  const errors = [];
  for (const entry of entries) {
    const tmp = noteTempPath(entry.file);
    try {
      const rel = vault && stateDir ? tempRelative(vault, tmp) : "";
      prepared.push({
        file: entry.file,
        text: entry.text,
        beforeRename: entry.beforeRename,
        tmp,
        rel,
        docId: entry.docId,
      });
    } catch (error) {
      errors.push({ error, file: entry.file });
    }
  }
  if (stateDir && prepared.some((entry) => entry.rel)) {
    await appendManifest(stateDir, prepared.map((entry) => entry.rel));
  }
  if (typeof options.afterManifest === "function") await options.afterManifest(prepared);
  for (const entry of prepared) {
    await yieldNow();
    let release = () => {};
    if (typeof options.around === "function") {
      const out = options.around(entry);
      if (typeof out === "function") release = out;
    }
    try {
      await replaceNoteAtomic(entry.file, entry.text, {
        vault,
        stateDir,
        tmp: entry.tmp,
        rel: entry.rel,
        recordManifest: false,
        beforeRename: entry.beforeRename,
      });
    } catch (error) {
      errors.push({ error, file: entry.file });
    } finally {
      release();
    }
  }
  return errors;
}

export async function saveNoteFile(file, text, beforeRename, options = {}) {
  const errors = await saveNoteBatch([{ file, text, beforeRename }], options);
  if (errors.length) throw errors[0].error;
}

// A note name in these lines is what a later scrub would have to guess at.
// The id is already a token, or a short hash when it is not.
export function logToken(value) {
  const text = String(value ?? "");
  if (/^[A-Za-z0-9]{6,80}$/.test(text)) return text;
  return crypto.createHash("sha256").update(text).digest("hex").slice(0, 12);
}

export function logCode(error) {
  const code = error && error.code ? String(error.code) : "";
  if (/^[A-Za-z0-9_]+$/.test(code)) return code;
  return "ERROR";
}

export function foldInFailureLine(docId, error) {
  return "fold-in failed for " + logToken(docId) + " " + logCode(error);
}

export function mirrorNoteFailureLine(docId, error) {
  return "mirror failed for " + logToken(docId) + " " + logCode(error);
}

export function mirrorFailureLine(error) {
  return "mirror failed: " + logCode(error);
}

export function createMirror({
  repo,
  vault,
  debounceMs = 400,
  secrets = [],
  track = (work) => work(),
  stateDir = "",
  hold = null,
}) {
  function held(docId) {
    if (typeof hold !== "function" || !docId) return () => {};
    const release = hold(docId);
    return typeof release === "function" ? release : () => {};
  }
  const lastWritten = new Map();
  const incorporated = new Map();
  let records = null;
  let timer = null;
  let chain = Promise.resolve();
  let queued = 0;
  const recordFile = path.join(vault, ".aidanos", "written.json");

  async function hashes() {
    if (records) return records;
    try {
      const parsed = JSON.parse(await fs.readFile(recordFile, "utf8"));
      records = parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      records = {};
    }
    return records;
  }

  async function saveHashes() {
    const body = JSON.stringify(records || {});
    await fs.mkdir(path.dirname(recordFile), { recursive: true });
    await replaceNoteAtomic(recordFile, body, { vault, recordManifest: false });
  }

  async function indexPaths() {
    const paths = {};
    for (const handle of Object.values(repo.handles)) {
      await yieldNow();
      let doc;
      try {
        doc = handle.doc();
      } catch {
        continue;
      }
      if (!doc || doc.kind !== "index" || !doc.paths || typeof doc.paths !== "object") continue;
      for (const [notePath, docId] of Object.entries(doc.paths)) {
        if (typeof docId === "string" && safeNotePath(notePath)) paths[notePath] = docId;
      }
    }
    return paths;
  }

  function blockNote(blocked, notePath, docId, error) {
    blocked.set(notePath, { docId, error });
    logSafe(secrets, foldInFailureLine(docId, error));
  }

  async function foldOutside() {
    const blocked = new Map();
    const known = await hashes();
    const paths = await indexPaths();
    for (const [notePath, docId] of Object.entries(paths)) {
      await yieldNow();
      const handle = repo.handles[docId];
      if (!handle) continue;
      const file = await prepareNoteFile(vault, notePath);
      if (!file) continue;
      const sibling = await noteSiblingFault(file);
      if (sibling) {
        blockNote(blocked, notePath, docId, sibling);
        continue;
      }
      let fileText;
      try {
        fileText = await fs.readFile(file, "utf8");
      } catch (error) {
        if (error && error.code === "ENOENT") continue;
        blockNote(blocked, notePath, docId, error && error.code ? error : siblingError("EREAD"));
        continue;
      }
      const fileHash = digest(fileText);
      if (incorporated.get(notePath) === fileHash) continue;
      if (known[notePath] === fileHash) {
        lastWritten.set(notePath, fileText);
        incorporated.set(notePath, fileHash);
        continue;
      }
      if (lastWritten.get(notePath) === fileText) {
        incorporated.set(notePath, fileHash);
        continue;
      }
      let current;
      try {
        current = noteText(handle.doc());
      } catch {
        continue;
      }
      if (current == null || current === fileText) {
        lastWritten.set(notePath, fileText);
        known[notePath] = fileHash;
        incorporated.set(notePath, fileHash);
        continue;
      }
      try {
        // The file is compared with the last text this relay wrote. Only that
        // difference is applied, so a device edit that arrived in the same
        // moment stays in the history instead of being replaced by the file.
        const baseline = lastWritten.has(notePath) ? lastWritten.get(notePath) : current;
        const docEdits = changes(baseline, current);
        const fileEdits = changes(baseline, fileText).filter(
          (edit) => !docEdits.some((other) => sameEdit(edit, other)),
        );
        const merged = applyEdits(current, fileEdits.map((edit) => mapEdit(edit, docEdits)));
        if (merged !== current) {
          handle.change((doc) => {
            if (typeof doc.text !== "string") doc.text = "";
            spliceToward(doc, merged);
          });
        }
        lastWritten.set(notePath, merged);
        incorporated.set(notePath, fileHash);
      } catch (error) {
        blockNote(blocked, notePath, docId, error && error.code ? error : siblingError("EREAD"));
      }
      await yieldNow();
    }
    return blocked;
  }

  async function writeNotes(blocked) {
    const known = await hashes();
    const paths = await indexPaths();
    let changed = false;
    const batch = [];
    for (const [notePath, docId] of Object.entries(paths)) {
      await yieldNow();
      const handle = repo.handles[docId];
      if (!handle) continue;
      let text;
      try {
        text = noteText(handle.doc());
      } catch {
        continue;
      }
      if (text == null) continue;
      const file = await prepareNoteFile(vault, notePath);
      if (blocked && blocked.has(notePath)) {
        await yieldNow();
        continue;
      }
      if (!file) {
        const candidate = path.join(vault, ...notePath.split("/"));
        try {
          const info = await fs.lstat(candidate);
          if (info.isSymbolicLink()) {
            const error = new Error("symlink");
            error.code = "ELOOP";
            logSafe(secrets, mirrorNoteFailureLine(docId, error));
          }
        } catch {
          // A missing file is not a refusal. The path itself was unsafe.
        }
        await yieldNow();
        continue;
      }
      const sibling = await noteSiblingFault(file);
      if (sibling) {
        logSafe(secrets, mirrorNoteFailureLine(docId, sibling));
        await yieldNow();
        continue;
      }
      let existing = null;
      try {
        existing = await fs.readFile(file, "utf8");
      } catch (error) {
        if (!error || error.code !== "ENOENT") {
          logSafe(secrets, mirrorNoteFailureLine(docId, error && error.code ? error : siblingError("EREAD")));
          await yieldNow();
          continue;
        }
        existing = null;
      }
      if (existing === text) {
        lastWritten.set(notePath, text);
        if (known[notePath] !== digest(text)) {
          known[notePath] = digest(text);
          changed = true;
        }
        await yieldNow();
        continue;
      }
      batch.push({ file, text, notePath, docId });
    }
    if (batch.length) {
      batch.sort((a, b) => (a.notePath < b.notePath ? -1 : a.notePath > b.notePath ? 1 : 0));
      let errors;
      try {
        errors = await saveNoteBatch(batch, {
          vault,
          stateDir,
          around(entry) {
            return held(entry.docId);
          },
        });
      } catch (error) {
        errors = batch.map((entry) => ({ error, file: entry.file }));
      }
      const failed = new Set(errors.map((item) => item.file));
      for (const item of errors) {
        const entry = batch.find((row) => row.file === item.file);
        logSafe(secrets, mirrorNoteFailureLine(entry ? entry.docId : "", item.error));
      }
      for (const entry of batch) {
        if (failed.has(entry.file)) continue;
        lastWritten.set(entry.notePath, entry.text);
        known[entry.notePath] = digest(entry.text);
        changed = true;
      }
    }
    if (changed) await saveHashes();
  }

  async function syncDisk() {
    chain = chain.then(() => track(async () => {
      const started = performance.now();
      try {
        const blocked = await foldOutside();
        await writeNotes(blocked);
      } finally {
        noteMirror(performance.now() - started);
      }
    })).catch((error) => {
      logSafe(secrets, mirrorFailureLine(error));
    });
    return chain;
  }

  function enqueueSync() {
    queued += 1;
    const run = syncDisk();
    run.finally(() => {
      queued -= 1;
    });
    return run;
  }

  function schedule() {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      if (queued < 1) enqueueSync();
    }, debounceMs);
    if (timer.unref) timer.unref();
  }

  // The interval must start the pass itself. Calling schedule() from it
  // resets the debounce on every tick, and an idle worker never writes.
  const poll = setInterval(() => {
    if (queued >= 1) return;
    enqueueSync();
  }, Math.max(debounceMs, 200));
  if (poll.unref) poll.unref();

  return {
    schedule,
    async now() {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      await enqueueSync();
    },
    // Wait for a write that has already started. Does not start another one.
    async idle() {
      await chain;
    },
    stop() {
      clearInterval(poll);
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}
