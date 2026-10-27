// Keep a vault git repo from listing recovery files. The pattern lives in
// .git/info/exclude so it applies even when the vault's .gitignore is shared.

import fs from "node:fs/promises";
import path from "node:path";

export function isRecoverPath(rel) {
  const name = String(rel || "").replace(/\\/g, "/").split("/").filter(Boolean).pop() || "";
  return name.endsWith(".recover");
}

export async function ensureRecoverExcluded(vault) {
  const gitLink = path.join(vault, ".git");
  let st;
  try {
    st = await fs.lstat(gitLink);
  } catch {
    return;
  }
  if (st.isSymbolicLink()) return;
  let gitDir = gitLink;
  if (st.isFile()) {
    const text = await fs.readFile(gitLink, "utf8");
    const match = /^gitdir:\s*(.*)$/m.exec(text);
    if (!match) return;
    gitDir = path.resolve(vault, match[1].trim());
    let listed;
    try {
      listed = await fs.lstat(gitDir);
    } catch {
      return;
    }
    if (listed.isSymbolicLink() || !listed.isDirectory()) return;
  } else if (!st.isDirectory()) {
    return;
  }
  const info = path.join(gitDir, "info");
  const exclude = path.join(info, "exclude");
  let text = "";
  try {
    text = await fs.readFile(exclude, "utf8");
  } catch (e) {
    if (e.code !== "ENOENT") return;
  }
  if (text.split(/\r?\n/).some((line) => line.trim() === "*.recover")) return;
  await fs.mkdir(info, { recursive: true });
  const prefix = text.length > 0 && !text.endsWith("\n") ? text + "\n" : text;
  await fs.writeFile(exclude, prefix + "*.recover\n");
}
