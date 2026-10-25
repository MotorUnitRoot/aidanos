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
// An in-place save never follows a link. The swap-in path still writes a
// temp file and renames it, and beforeRename runs after that temp file is
// ready and before the rename.

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

async function lstatOrMissing(filePath) {
  try {
    return await fs.lstat(filePath);
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw e;
  }
}

async function writeInPlace(filePath, body, options) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const before = await lstatOrMissing(filePath);
  if (before && before.isSymbolicLink()) throw badPath();
  if (typeof options.beforeOpen === "function") await options.beforeOpen(filePath);
  const flags = fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW | (before ? 0 : fsConstants.O_CREAT);
  let handle;
  try {
    handle = await fs.open(filePath, flags, 0o666);
  } catch (e) {
    if (e.code === "ELOOP" || e.code === "EEXIST") throw badPath();
    throw e;
  }
  try {
    const opened = await handle.stat();
    if (before) {
      if (opened.dev !== before.dev || opened.ino !== before.ino) throw badPath();
    } else if (!opened.isFile()) {
      throw badPath();
    }
    await handle.truncate(0);
    await handle.write(body, 0, "utf8");
    await handle.sync();
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
  const env = options.env || process.env;
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
