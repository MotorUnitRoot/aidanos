// How a note file is saved.
//
// A NotePlan vault is recognized from the real path: a path part that starts
// with "iCloud~co~noteplan~" or "co.noteplan.", in any letter case. That
// covers iCloud, the Containers path, and the Setapp variants. A folder that
// is merely named NotePlan is not one. AIDANOS_VAULT_KIND=noteplan forces
// the same in-place save.
//
// Inside that vault the editor writes the same file in place. A caller cannot
// choose swap-in there. Elsewhere, swap-in stays the default unless the
// setting turns it off.
//
// An in-place save never follows a link, a hard link, or any file that is
// not a regular file. It opens a new note with O_CREAT|O_EXCL. After the
// open, and before the first new byte, the opened file is compared with the
// file recorded inside the vault and the caller rechecks the parent
// directories. If that check fails on a file this call just created, that
// file is removed once its dev+ino still matches the descriptor, so a
// swapped parent does not leave an empty file outside the vault.
//
// The previous bytes are then written to a recovery file in the same folder,
// created with O_EXCL. If the new write or the truncate fails, those bytes
// are written back over the same file. The recovery file is removed after a
// successful save or a successful restore. If the restore itself fails, the
// recovery file stays and its vault-relative name is logged. Writing the new
// bytes and truncating afterwards does not by itself keep the previous text.
// The swap-in path still writes a temp file and renames it, and beforeRename
// runs after that temp file is ready and before the rename.

import { constants as fsConstants, realpathSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

const NOTEPLAN_PREFIXES = ["icloud~co~noteplan~", "co.noteplan."];

function resolvedPath(filePath) {
  let cursor = path.resolve(String(filePath || ""));
  const pending = [];
  for (;;) {
    try {
      const real = realpathSync(cursor);
      return pending.length ? path.join(real, ...pending) : real;
    } catch (e) {
      if (e.code !== "ENOENT" && e.code !== "ENOTDIR") break;
      const parent = path.dirname(cursor);
      if (parent === cursor) break;
      pending.unshift(path.basename(cursor));
      cursor = parent;
    }
  }
  return path.resolve(String(filePath || ""));
}

export function isNotePlanFolder(filePath) {
  const parts = resolvedPath(filePath).split(path.sep).filter(Boolean);
  return parts.some((part) => {
    const name = part.toLowerCase();
    return NOTEPLAN_PREFIXES.some((prefix) => name.startsWith(prefix));
  });
}

export function notePlanKind(env = process.env) {
  return String(env.AIDANOS_VAULT_KIND || "").trim().toLowerCase() === "noteplan";
}

export function noteSaveStyle(filePath, swapInRequested = swapInSetting(), env = process.env) {
  if (isNotePlanFolder(filePath) || notePlanKind(env)) return "in-place";
  return swapInRequested ? "swap-in" : "in-place";
}

export function swapInSetting(env = process.env) {
  const raw = String(env.AIDANOS_SAVE_SWAP_IN || "").trim().toLowerCase();
  if (raw === "0" || raw === "false" || raw === "no") return false;
  if (raw === "1" || raw === "true" || raw === "yes") return true;
  return true;
}

function badPath() {
  const error = new Error("bad path");
  error.code = "BAD_PATH";
  return error;
}

function mismatchedFile() {
  const error = new Error("parent changed");
  error.code = "RACE";
  return error;
}

function isRegularFile(stats) {
  return !!stats && (stats.mode & fsConstants.S_IFMT) === fsConstants.S_IFREG;
}

function environment(options) {
  if (!options.env) return process.env;
  return { ...process.env, ...options.env };
}

async function lstatOrMissing(filePath) {
  try {
    return await fs.lstat(filePath);
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw e;
  }
}

async function readOpened(handle, size) {
  const previous = Buffer.alloc(size);
  let got = 0;
  while (got < size) {
    const result = await handle.read(previous, got, size - got, got);
    if (!result.bytesRead) break;
    got += result.bytesRead;
  }
  if (got !== size) {
    const error = new Error("write failed");
    error.code = "EIO";
    throw error;
  }
  return previous;
}

async function writeOpened(handle, payload) {
  let written = 0;
  while (written < payload.length) {
    const result = await handle.write(payload, written, payload.length - written, written);
    if (!result.bytesWritten) {
      const error = new Error("write failed");
      error.code = "EIO";
      throw error;
    }
    written += result.bytesWritten;
  }
}

async function restoreOpened(handle, previous) {
  await writeOpened(handle, previous);
  await handle.truncate(previous.length);
}

async function removeSameFile(filePath, id) {
  if (!id) return;
  let listed;
  try {
    listed = await fs.lstat(filePath);
  } catch (e) {
    if (e.code === "ENOENT") return;
    throw e;
  }
  if (listed.isSymbolicLink() || listed.dev !== id.dev || listed.ino !== id.ino) return;
  await fs.unlink(filePath);
}

async function removeCreatedNote(filePath, handle) {
  const opened = await handle.stat();
  await removeSameFile(filePath, opened);
}

function recoveryRelativeName(recoveryPath, vaultRoot) {
  if (!vaultRoot) return path.basename(recoveryPath);
  const rel = path.relative(path.resolve(String(vaultRoot)), recoveryPath);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return path.basename(recoveryPath);
  return rel.split(path.sep).join("/");
}

function logRestoreFailure(recoveryPath, options) {
  const name = recoveryRelativeName(recoveryPath, options && options.vaultRoot);
  console.error("restore failed: " + name);
}

async function writeRecoveryFile(notePath, previous) {
  const recoveryPath = path.join(
    path.dirname(notePath),
    path.basename(notePath) + "." + process.pid + "." + Math.random().toString(16).slice(2) + ".recover",
  );
  const flags = fsConstants.O_WRONLY
    | fsConstants.O_CREAT
    | fsConstants.O_EXCL
    | fsConstants.O_NOFOLLOW
    | fsConstants.O_NONBLOCK;
  let handle;
  try {
    handle = await fs.open(recoveryPath, flags, 0o644);
  } catch (e) {
    if (e.code === "ELOOP" || e.code === "EEXIST" || e.code === "ENXIO") throw badPath();
    throw e;
  }
  let id = null;
  try {
    const opened = await handle.stat();
    id = { dev: opened.dev, ino: opened.ino };
    await writeOpened(handle, previous);
    await handle.sync();
    return { path: recoveryPath, dev: id.dev, ino: id.ino };
  } catch (error) {
    await handle.close();
    handle = null;
    try { await removeSameFile(recoveryPath, id); } catch { /* the note is still unchanged */ }
    throw error;
  } finally {
    if (handle) await handle.close();
  }
}

async function writeInPlace(filePath, body, options) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const before = await lstatOrMissing(filePath);
  if (before && before.isSymbolicLink()) throw badPath();
  if (before && !isRegularFile(before)) throw badPath();
  if (typeof options.beforeOpen === "function") await options.beforeOpen(filePath);
  // O_RDWR so the previous bytes can be read back and restored. A file the
  // caller already saw inside the vault is never created here: the open has
  // to land on that inode, not on a new file reached through a swapped parent.
  const creating = options.expectFile ? false : !before;
  const flags = fsConstants.O_RDWR
    | fsConstants.O_NOFOLLOW
    | fsConstants.O_NONBLOCK
    | (creating ? (fsConstants.O_CREAT | fsConstants.O_EXCL) : 0);
  let handle;
  try {
    handle = await fs.open(filePath, flags, 0o644);
  } catch (e) {
    if (e.code === "ELOOP" || e.code === "EEXIST" || e.code === "ENXIO") throw badPath();
    throw e;
  }
  try {
    const opened = await handle.stat();
    if (before) {
      if (opened.dev !== before.dev || opened.ino !== before.ino) throw badPath();
    }
    if (!isRegularFile(opened) || opened.nlink > 1) throw badPath();
    let raced = false;
    if (options.expectFile && (opened.dev !== options.expectFile.dev || opened.ino !== options.expectFile.ino)) {
      raced = true;
    }
    try {
      if (typeof options.afterOpen === "function") await options.afterOpen(opened);
      if (raced) throw mismatchedFile();
    } catch (error) {
      if (creating) await removeCreatedNote(filePath, handle);
      throw error;
    }
    const previous = before ? await readOpened(handle, opened.size) : Buffer.alloc(0);
    const recovery = await writeRecoveryFile(filePath, previous);
    const payload = Buffer.from(body, "utf8");
    try {
      if (typeof options.failWrite === "function") await options.failWrite();
      if (Number.isInteger(options.failAfterBytes)) {
        const count = Math.max(0, Math.min(options.failAfterBytes, payload.length));
        if (count > 0) await writeOpened(handle, payload.subarray(0, count));
        const error = new Error("write failed");
        error.code = "EIO";
        throw error;
      }
      await writeOpened(handle, payload);
      await handle.truncate(payload.length);
    } catch (error) {
      try {
        if (typeof options.failRestore === "function") await options.failRestore();
        await restoreOpened(handle, previous);
        await removeSameFile(recovery.path, recovery);
      } catch {
        logRestoreFailure(recovery.path, options);
        throw error;
      }
      throw error;
    }
    await handle.sync();
    await removeSameFile(recovery.path, recovery);
  } finally {
    await handle.close();
  }
}

async function writeSwapIn(filePath, body, options) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const before = await lstatOrMissing(filePath);
  if (before && before.isSymbolicLink()) throw badPath();
  const tmp = filePath + "." + process.pid + "." + Math.random().toString(16).slice(2) + ".tmp";
  try {
    await fs.writeFile(tmp, body, { encoding: "utf8", flag: "wx" });
    if (typeof options.beforeRename === "function") await options.beforeRename();
    const again = await lstatOrMissing(filePath);
    if (again && again.isSymbolicLink()) throw badPath();
    await fs.rename(tmp, filePath);
  } catch (error) {
    try { await fs.unlink(tmp); } catch {}
    throw error;
  }
}

export async function writeNoteText(filePath, text, options = {}) {
  const env = environment(options);
  const requested = options.swapInRequested != null ? options.swapInRequested : swapInSetting(env);
  const style = noteSaveStyle(filePath, requested, env);
  const body = String(text ?? "");
  if (style === "in-place") {
    await writeInPlace(filePath, body, options);
    return "in-place";
  }
  await writeSwapIn(filePath, body, options);
  return "swap-in";
}
