import fs from "node:fs/promises";
import path from "node:path";

// A note path is a relative .md path. Hidden names, "..", and absolute paths are refused.
export function safeNotePath(notePath) {
  const raw = String(notePath ?? "");
  if (!raw || raw.startsWith("/") || raw.startsWith("\\") || raw.includes("\\") || raw.includes("\0")) {
    return null;
  }
  if (!raw.endsWith(".md")) return null;
  const parts = raw.split("/");
  if (!parts.length) return null;
  for (const part of parts) {
    if (!part || part === "." || part === ".." || part.startsWith(".")) return null;
  }
  return parts.join("/");
}

async function isSymlink(candidate) {
  try {
    const stat = await fs.lstat(candidate);
    return stat.isSymbolicLink();
  } catch (error) {
    if (error && error.code === "ENOENT") return false;
    throw error;
  }
}

// knownRoot is the vault path recorded once at claim. A save must not call
// realpath. On macOS that walk follows /var to /private/var and stalls the
// worker, so the note never lands in the vault. Each path component is
// lstat'd and a symlink is refused, which is the escape check realpath was
// doing on every write.
export async function prepareNoteFile(vault, notePath, knownRoot = "") {
  const safe = safeNotePath(notePath);
  if (!safe) return null;
  const root = knownRoot || path.resolve(vault);
  const parts = safe.split("/");
  let current = root;
  for (let index = 0; index < parts.length - 1; index += 1) {
    current = path.join(current, parts[index]);
    let stat;
    try {
      stat = await fs.lstat(current);
    } catch (error) {
      if (!error || error.code !== "ENOENT") return null;
      await fs.mkdir(current);
      continue;
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) return null;
  }
  if (current !== root && !current.startsWith(root + path.sep)) return null;
  const file = path.join(current, parts[parts.length - 1]);
  if (await isSymlink(file)) return null;
  return file;
}
