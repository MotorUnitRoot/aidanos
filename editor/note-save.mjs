// How a note file is saved.
//
// Inside a NotePlan folder the editor writes the same file in place.
// A swap-in (write a temp file, then rename it over the note) is not used
// there, even when a setting asks for it. Elsewhere, swap-in stays available
// and is the default unless the setting turns it off.

import fs from "node:fs/promises";
import path from "node:path";

export function isNotePlanFolder(filePath) {
  const parts = path.resolve(String(filePath || "")).split(path.sep).filter(Boolean);
  if (parts.length < 2) return false;
  const parents = parts.slice(0, -1);
  return parents.some((part) => part.toLowerCase() === "noteplan");
}

export function noteSaveStyle(filePath, swapInRequested = swapInSetting()) {
  if (isNotePlanFolder(filePath)) return "in-place";
  return swapInRequested ? "swap-in" : "in-place";
}

export function swapInSetting(env = process.env) {
  const raw = String(env.AIDANOS_SAVE_SWAP_IN || "").trim().toLowerCase();
  if (raw === "0" || raw === "false" || raw === "no") return false;
  if (raw === "1" || raw === "true" || raw === "yes") return true;
  return true;
}

export async function writeNoteText(filePath, text, options = {}) {
  const style = options.style || noteSaveStyle(filePath, options.swapInRequested);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const body = String(text ?? "");
  if (style === "in-place") {
    const handle = await fs.open(filePath, "w");
    try {
      await handle.writeFile(body, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    return "in-place";
  }
  const tmp = filePath + "." + process.pid + "." + Math.random().toString(16).slice(2) + ".tmp";
  try {
    await fs.writeFile(tmp, body, { encoding: "utf8", flag: "wx" });
    await fs.rename(tmp, filePath);
  } catch (error) {
    try { await fs.unlink(tmp); } catch {}
    throw error;
  }
  return "swap-in";
}
