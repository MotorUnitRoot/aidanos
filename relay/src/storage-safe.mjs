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

async function syncDirectory(dir) {
  const handle = await fs.open(dir, DIR_FLAGS);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

// Temp file is created with O_EXCL and mode 0600 inside the storage folder.
// The file and its folder are fsynced before the rename, so a crash keeps
// the previous bytes.
export async function writeStorageBytes(root, filePath, bytes) {
  const file = path.resolve(filePath);
  const dir = path.dirname(file);
  await assertInside(root, file, false);
  await fs.mkdir(dir, { recursive: true });
  await assertInside(root, dir, true);
  const tmp = path.join(
    dir,
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

  loadRange(prefix) {
    return this.inner.loadRange(prefix);
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
