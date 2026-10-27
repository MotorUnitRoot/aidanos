import crypto from "node:crypto";
import { closeSync, constants as fsConstants, fstatSync, fsyncSync, openSync, readSync, realpathSync, unlinkSync, writeSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import * as Automerge from "@automerge/automerge";
import { writeNoteText } from "../../editor/note-save.mjs";
import { noteMirror } from "./index-trace.mjs";
import { logSafe } from "./redact.mjs";
import { prepareNoteFile, safeNotePath } from "./paths.mjs";

function yieldNow() {
  return new Promise((resolve) => setImmediate(resolve));
}

function plainDoc(doc) {
  try {
    return JSON.parse(JSON.stringify(doc));
  } catch {
    return null;
  }
}

function noteText(doc) {
  const plain = plainDoc(doc);
  if (!plain || plain.kind !== "note") return null;
  if (typeof plain.text === "string") return plain.text;
  if (plain.text == null) return "";
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
const openNoteTemps = new Map();
let manifestChain = Promise.resolve();

function noteTempPath(file, pid = process.pid) {
  return path.join(path.dirname(file), `.${path.basename(file)}.${pid}.tmp`);
}

function withManifest(work) {
  const run = manifestChain.then(work, work);
  manifestChain = run.then(() => {}, () => {});
  return run;
}

function manifestFile(stateDir) {
  return path.join(stateDir, NOTE_TEMP_MANIFEST);
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
    if (!opened.isFile() || opened.dev !== dev || opened.ino !== ino || opened.uid !== uid) return false;
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
    if (!st.isFile() || st.uid !== uid) return "keep";
    return unlinkSameFile(cursor, st.dev, st.ino, uid) ? "drop" : "keep";
  }
  return "keep";
}

function rewriteManifest(stateDir, lines) {
  const file = manifestFile(stateDir);
  const body = lines.length ? lines.join("\n") + "\n" : "";
  const fd = openSync(file, fsConstants.O_WRONLY | fsConstants.O_TRUNC | fsConstants.O_NOFOLLOW);
  try {
    writeSync(fd, body);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

// Only paths this relay recorded, and only after the folder markers match.
// Anything else — a home directory, a dot folder, a symlink, a path with `..` —
// stays where it is. There is no directory walk.
export async function sweepStaleNoteTemps(vault, stateDir) {
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  if (typeof uid !== "number") return;
  if (!(await markersMatch(vault, stateDir))) return;
  await withManifest(async () => {
    const text = readRegularFile(manifestFile(stateDir));
    if (text == null) return;
    const lines = text.split("\n").filter((line) => line.length > 0);
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
    if (kept.length === lines.length && kept.every((line, index) => line === lines[index])) return;
    try {
      rewriteManifest(stateDir, kept);
    } catch { /* a replaced manifest is left alone */ }
  });
}

function relativeInside(root, file) {
  const rel = path.relative(root, file);
  if (!rel || rel === ".." || rel.startsWith(".." + path.sep) || path.isAbsolute(rel)) return "";
  return rel.split(path.sep).join("/");
}

// The note file is under realpath(vault). On macOS that can be /private/var
// while the configured vault is /var, and path.relative then looks like ../.
function tempRelative(vault, file) {
  const abs = path.resolve(file);
  let posix = relativeInside(path.resolve(vault), abs);
  if (!posix) {
    try {
      posix = relativeInside(realpathSync(vault), abs);
    } catch {
      posix = "";
    }
  }
  if (!posix || !parseManifestLine(posix)) {
    const error = new Error("note temp is outside the vault");
    error.code = "EINVAL";
    throw error;
  }
  return posix;
}

async function appendManifest(stateDir, rel) {
  await fs.mkdir(stateDir, { recursive: true });
  await withManifest(async () => {
    const fd = openSync(
      manifestFile(stateDir),
      fsConstants.O_APPEND | fsConstants.O_CREAT | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW,
      0o600,
    );
    try {
      writeSync(fd, rel + "\n");
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  });
}

async function dropManifest(stateDir, rel) {
  await withManifest(async () => {
    const text = readRegularFile(manifestFile(stateDir));
    if (text == null) return;
    const lines = text.split("\n").filter((line) => line.length > 0 && line !== rel);
    try {
      rewriteManifest(stateDir, lines);
    } catch { /* the entry stays until a later sweep can read the manifest */ }
  });
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

// Write the note beside its final name, then rename it into place. A reader
// sees the previous file or the whole new file. The temp's path is recorded
// and fsynced before the temp exists.
export async function saveNoteFile(file, text, beforeRename, options = {}) {
  const tmp = noteTempPath(file);
  const vault = options.vault || "";
  const stateDir = options.stateDir || "";
  let rel = "";
  if (vault && stateDir) {
    rel = tempRelative(vault, tmp);
    await appendManifest(stateDir, rel);
  }
  const meta = { rel, stateDir };
  openNoteTemps.set(tmp, meta);
  try {
    await fs.writeFile(tmp, text);
    if (typeof beforeRename === "function") await beforeRename();
    await fs.rename(tmp, file);
  } finally {
    openNoteTemps.delete(tmp);
    await dropManifestIfGone(tmp, meta);
  }
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

export function createMirror({ repo, vault, debounceMs = 400, secrets = [], track = (work) => work() }) {
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
    await writeNoteText(recordFile, body, { swapInRequested: false, vaultRoot: vault });
  }

  function indexPaths() {
    const paths = {};
    for (const handle of Object.values(repo.handles)) {
      let doc;
      try {
        doc = handle.doc();
      } catch {
        continue;
      }
      const plain = plainDoc(doc);
      if (!plain || plain.kind !== "index" || !plain.paths || typeof plain.paths !== "object") continue;
      for (const [notePath, docId] of Object.entries(plain.paths)) {
        if (typeof docId === "string" && safeNotePath(notePath)) paths[notePath] = docId;
      }
    }
    return paths;
  }

  async function foldOutside() {
    const known = await hashes();
    const paths = indexPaths();
    for (const [notePath, docId] of Object.entries(paths)) {
      await yieldNow();
      const handle = repo.handles[docId];
      if (!handle) continue;
      const file = await prepareNoteFile(vault, notePath);
      if (!file) continue;
      let fileText;
      try {
        fileText = await fs.readFile(file, "utf8");
      } catch {
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
        logSafe(secrets, foldInFailureLine(docId, error));
      }
      await yieldNow();
    }
  }

  async function writeNotes() {
    const known = await hashes();
    const paths = indexPaths();
    let changed = false;
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
      if (!file) {
        const candidate = path.join(vault, ...notePath.split("/"));
        try {
          const info = await fs.lstat(candidate);
          if (info.isSymbolicLink()) logSafe(secrets, "mirror write refused", notePath);
        } catch {
          // A missing file is not a refusal. The path itself was unsafe.
        }
        await yieldNow();
        continue;
      }
      let existing = null;
      try {
        existing = await fs.readFile(file, "utf8");
      } catch {
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
      try {
        await writeNoteText(file, text, { swapInRequested: false, vaultRoot: vault });
      } catch {
        logSafe(secrets, "mirror write refused", notePath);
        await yieldNow();
        continue;
      }
      lastWritten.set(notePath, text);
      known[notePath] = digest(text);
      changed = true;
      await yieldNow();
    }
    if (changed) await saveHashes();
  }

  async function syncDisk() {
    chain = chain.then(() => track(async () => {
      const started = performance.now();
      try {
        await foldOutside();
        await writeNotes();
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
