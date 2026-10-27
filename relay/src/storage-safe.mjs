import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { ancestorFault } from "../../editor/dirfd.mjs";

const TEMP_FLAGS =
  fsConstants.O_CREAT |
  fsConstants.O_EXCL |
  fsConstants.O_WRONLY |
  (fsConstants.O_NOFOLLOW || 0);
const DIR_FLAGS = fsConstants.O_RDONLY | (fsConstants.O_DIRECTORY || 0) | (fsConstants.O_NOFOLLOW || 0);
const RELAY_TMP = ".relay-tmp";
const TEMP_NAME = /^\.tmp-(\d+)-[0-9a-f]+$/;

function refused() {
  const error = new Error("storage path refused");
  error.code = "ELOOP";
  return error;
}

export function storageFolderFault(dir) {
  return ancestorFault(dir) || "";
}

async function isSymlink(candidate) {
  try {
    const info = await fs.lstat(candidate);
    return info.isSymbolicLink();
  } catch (error) {
    if (error && error.code === "ENOENT") return false;
    throw error;
  }
}

export async function refuseSymlinkedStorage(dir) {
  try {
    const info = await fs.lstat(dir);
    if (info.isSymbolicLink() || !info.isDirectory()) throw refused();
  } catch (error) {
    if (error && error.code === "ENOENT") return;
    throw error;
  }
}

function escapesRoot(relative) {
  return path.isAbsolute(relative) || relative.split(path.sep).includes("..");
}

// allowRoot is for the storage folder itself. A file path that is the folder
// is refused. An empty relative path is that folder, not an escape.
async function assertInside(root, filePath, allowRoot) {
  const base = path.resolve(root);
  const target = path.resolve(filePath);
  const relative = path.relative(base, target);
  if (relative === "") {
    if (!allowRoot) throw refused();
  } else if (escapesRoot(relative)) {
    throw refused();
  }
  let current = base;
  const rootInfo = await fs.lstat(current);
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) throw refused();
  if (relative === "") return;
  const parts = relative.split(path.sep).filter(Boolean);
  for (let i = 0; i < parts.length; i += 1) {
    current = path.join(current, parts[i]);
    let info;
    try {
      info = await fs.lstat(current);
    } catch (error) {
      if (error && error.code === "ENOENT") return;
      throw error;
    }
    if (info.isSymbolicLink()) throw refused();
  }
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

function isStorageTempPath(filePath) {
  return path.resolve(filePath).split(path.sep).some((part) => part === RELAY_TMP || part.startsWith(".tmp-"));
}

function logSkippedSymlink() {
  console.error("skipped symlinked chunk");
}

export async function ensureRelayTmp(root) {
  const dir = path.join(root, RELAY_TMP);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const info = await fs.lstat(dir);
  if (info.isSymbolicLink() || !info.isDirectory()) throw refused();
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  if (typeof uid === "number" && info.uid !== uid) throw refused();
  await fs.chmod(dir, 0o700);
  if (storageFolderFault(dir)) throw refused();
  return dir;
}

// Dead-pid temps under the storage folder only. Symlinks are not followed.
// A live pid is left alone; load still skips every `.tmp-` name.
export async function sweepDeadStorageTemps(root) {
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  if (typeof uid !== "number") return;
  await sweepTempDir(path.resolve(root), uid, 0);
}

async function sweepTempDir(dir, uid, depth) {
  if (depth > 6) return;
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await sweepTempDir(full, uid, depth + 1);
      continue;
    }
    if (!entry.isFile()) continue;
    const match = TEMP_NAME.exec(entry.name);
    if (!match) continue;
    const pid = Number(match[1]);
    if (!Number.isSafeInteger(pid) || pidAlive(pid)) continue;
    let st;
    try {
      st = await fs.lstat(full);
    } catch {
      continue;
    }
    if (st.isSymbolicLink() || !st.isFile() || st.nlink !== 1 || st.uid !== uid) continue;
    try { await fs.unlink(full); } catch { /* already gone, or it changed under us */ }
  }
}

async function syncDirectory(dir) {
  const handle = await fs.open(dir, DIR_FLAGS);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

// Temp file is created with O_EXCL and mode 0600 under <root>/.relay-tmp,
// then renamed into the snapshot folder on the same filesystem. The file
// and both folders are fsynced, so a crash keeps the previous bytes and
// loadRange never sees the temp as a chunk.
export async function writeStorageBytes(root, filePath, bytes) {
  const file = path.resolve(filePath);
  const dir = path.dirname(file);
  await assertInside(root, file, false);
  await fs.mkdir(dir, { recursive: true });
  await assertInside(root, dir, true);
  const tmpDir = await ensureRelayTmp(root);
  const tmp = path.join(
    tmpDir,
    ".tmp-" + process.pid + "-" + Math.random().toString(16).slice(2),
  );
  const payload = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  const handle = await fs.open(tmp, TEMP_FLAGS, 0o600);
  try {
    await handle.writeFile(payload);
    await handle.sync();
  } catch (error) {
    await handle.close();
    try { await fs.unlink(tmp); } catch { /* the temp file is already gone */ }
    throw error;
  }
  await handle.close();
  const mode = (await fs.stat(tmp)).mode & 0o777;
  if (mode !== 0o600) {
    try { await fs.unlink(tmp); } catch { /* the temp file is already gone */ }
    const error = new Error("storage temp mode refused");
    error.code = "EPERM";
    throw error;
  }
  if (await isSymlink(file)) {
    try { await fs.unlink(tmp); } catch { /* the temp file is already gone */ }
    throw refused();
  }
  await syncDirectory(tmpDir);
  await syncDirectory(dir);
  await fs.rename(tmp, file);
  await syncDirectory(dir);
}

function cacheKey(key) {
  return path.join(...key);
}

export class SafeStorage {
  constructor(dir, inner) {
    this.dir = dir;
    this.inner = inner;
    const rawLoad = inner.load.bind(inner);
    inner.load = async (key) => {
      const filePath = inner.getFilePath(key);
      if (isStorageTempPath(filePath)) return undefined;
      try {
        const info = await fs.lstat(filePath);
        if (info.isSymbolicLink()) {
          logSkippedSymlink();
          return undefined;
        }
      } catch (error) {
        if (!error || error.code !== "ENOENT") throw error;
      }
      try {
        await assertInside(dir, filePath);
      } catch (error) {
        if (error && error.code === "ELOOP") return undefined;
        throw error;
      }
      return rawLoad(key);
    };
  }

  load(key) {
    return this.inner.load(key);
  }

  async save(key, data) {
    const filePath = this.inner.getFilePath(key);
    await writeStorageBytes(this.dir, filePath, data);
    this.inner.cache[cacheKey(key)] = data;
    await new Promise((resolve) => setImmediate(resolve));
  }

  async remove(key) {
    const filePath = this.inner.getFilePath(key);
    try {
      const info = await fs.lstat(filePath);
      if (info.isSymbolicLink()) {
        delete this.inner.cache[cacheKey(key)];
        return;
      }
    } catch (error) {
      if (!error || error.code !== "ENOENT") throw error;
    }
    await this.inner.remove(key);
  }

  async loadRange(prefix) {
    const chunks = await this.inner.loadRange(prefix);
    if (!Array.isArray(chunks)) return chunks;
    return chunks.filter((chunk) => {
      if (!chunk || chunk.data == null) return false;
      if (!Array.isArray(chunk.key)) return true;
      return !chunk.key.some((part) => {
        const name = String(part);
        return name === RELAY_TMP || name.startsWith(".tmp-");
      });
    });
  }

  async removeRange(prefix) {
    const dirPath = this.inner.getFilePath(prefix);
    try {
      const info = await fs.lstat(dirPath);
      if (info.isSymbolicLink()) return;
    } catch (error) {
      if (!error || error.code !== "ENOENT") throw error;
    }
    await this.inner.removeRange(prefix);
  }
}
