// Open, stat, and unlink one name on a directory descriptor that was already
// checked. Node has no openat or unlinkat. On Linux, /proc/self/fd/<dirfd>/name
// is that operation. On macOS a small helper calls openat, fstatat, and
// unlinkat on the inherited descriptor.
//
// A pure Node walk is weaker than that helper. O_NOFOLLOW applies only to the
// last component, so opening vault/notes/file follows a parent that was
// swapped for a symlink and can create the file outside the checked folder.
// Seeing the mismatch afterwards is already too late. Linux keeps the proc
// backend, which is openat. Every other platform runs the pinned helper.
// Linux executes the verified descriptor through /proc/self/fd. macOS will
// not execute /dev/fd, so it executes the path that was just checked. The
// directory is owned by this user and is not group or world writable.

import { spawn } from "node:child_process";
import { createHash, timingSafeEqual } from "node:crypto";
import fsSync, { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DIR_FLAGS = fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW;
const CREATE_FLAGS = fsConstants.O_WRONLY
  | fsConstants.O_CREAT
  | fsConstants.O_EXCL
  | fsConstants.O_NOFOLLOW
  | fsConstants.O_NONBLOCK;
const READ_FLAGS = fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW;
const GROUP_OR_OTHER_WRITE = 0o022;

// Content pin for the helper shipped in editor/bin. editor/check-dirfd.sh
// rebuilds that file from dirfd-tool.c and fails unless this SHA-256 matches.
// A rebuilt binary does not run until this constant is updated.
const HELPER_SHA256 = {
  "linux-x64": "78bbeec3aa73aeb0526f8cbe0f17ca20d0eeee1c4dd859e0299960b6964da92d",
  "darwin-arm64": "44d21f908defa2a055e7fcfbafdcd4caf4c7bb7d7ebf0eed9ce8015f4b686342",
};

function badPath() {
  const error = new Error("bad path");
  error.code = "BAD_PATH";
  return error;
}

function helperUnavailable(reason) {
  const error = new Error("directory helper unavailable");
  error.code = "DIRFD";
  if (reason) error.reason = reason;
  return error;
}

function plainName(name) {
  const text = String(name || "");
  if (!text || text === "." || text === ".." || text.includes("/") || text.includes("\\") || text.includes("\0")) {
    throw badPath();
  }
  return text;
}

function helperKey() {
  const osName = process.platform === "linux" ? "linux" : process.platform === "darwin" ? "darwin" : "";
  const arch = process.arch === "x64" || process.arch === "arm64" ? process.arch : "";
  if (!osName || !arch) return "";
  return osName + "-" + arch;
}

export function directoryBackend(env = process.env) {
  const requested = env && env.AIDANOS_DIRFD_BACKEND;
  if (requested === "helper" || requested === "proc") return requested;
  return process.platform === "linux" ? "proc" : "helper";
}

function helperFile(env = process.env) {
  if (env && env.AIDANOS_DIRFD_TOOL) return path.resolve(String(env.AIDANOS_DIRFD_TOOL));
  const key = helperKey();
  if (!key) return "";
  return fileURLToPath(new URL("./bin/dirfd-tool-" + key, import.meta.url));
}

function sameBytes(actual, expectedHex) {
  if (!/^[0-9a-f]{64}$/.test(expectedHex || "")) return false;
  const expected = Buffer.from(expectedHex, "hex");
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}

async function hashFd(handle) {
  const hash = createHash("sha256");
  const buf = Buffer.alloc(64 * 1024);
  let pos = 0;
  for (;;) {
    const { bytesRead } = await handle.read(buf, 0, buf.length, pos);
    if (!bytesRead) break;
    hash.update(buf.subarray(0, bytesRead));
    pos += bytesRead;
  }
  return hash.digest();
}

function ownedAndPrivate(st, uid) {
  return !!st && st.uid === uid && (st.mode & GROUP_OR_OTHER_WRITE) === 0;
}

// Check the helper again on every call. Nothing here is cached: a rejected
// check must not make the next save fail without looking.
async function openTrustedHelper(env = process.env) {
  if (typeof process.getuid !== "function") throw helperUnavailable("uid");
  const uid = process.getuid();
  const key = helperKey();
  const pin = key ? HELPER_SHA256[key] : "";
  const filePath = helperFile(env);
  if (!pin || !filePath) throw helperUnavailable("pin");
  const base = path.basename(filePath);
  if (!base || base === "." || base === ".." || base.includes("/") || base.includes("\\")) throw helperUnavailable("pin");
  const parentPath = path.dirname(filePath);
  let listed;
  let parentListed;
  try {
    listed = await fs.lstat(filePath);
    parentListed = await fs.lstat(parentPath);
  } catch {
    throw helperUnavailable("stat");
  }
  if (listed.isSymbolicLink() || parentListed.isSymbolicLink() || !parentListed.isDirectory()) throw helperUnavailable("symlink");
  if (!ownedAndPrivate(parentListed, uid)) throw helperUnavailable("owner");

  let parent;
  try {
    parent = await fs.open(parentPath, DIR_FLAGS);
  } catch {
    throw helperUnavailable("open");
  }
  let file;
  try {
    const parentStat = await parent.stat();
    if (!parentStat.isDirectory() || parentStat.dev !== parentListed.dev || parentStat.ino !== parentListed.ino) {
      throw helperUnavailable("race");
    }
    if (!ownedAndPrivate(parentStat, uid)) throw helperUnavailable("owner");
    const openedPath = process.platform === "linux"
      ? "/proc/self/fd/" + parent.fd + "/" + base
      : filePath;
    try {
      file = await fs.open(openedPath, READ_FLAGS);
    } catch {
      throw helperUnavailable("open");
    }
    const st = await file.stat();
    if (!st.isFile()) throw helperUnavailable("type");
    if (!ownedAndPrivate(st, uid)) throw helperUnavailable("owner");
    const digest = await hashFd(file);
    if (!sameBytes(digest, pin)) throw helperUnavailable("hash");
    const again = await file.stat();
    const parentAgain = await parent.stat();
    if (again.dev !== st.dev || again.ino !== st.ino) throw helperUnavailable("race");
    if (!ownedAndPrivate(again, uid) || !ownedAndPrivate(parentAgain, uid)) throw helperUnavailable("owner");
    if (parentAgain.dev !== parentStat.dev || parentAgain.ino !== parentStat.ino) throw helperUnavailable("race");
    return { handle: file, path: filePath };
  } catch (error) {
    if (file) await file.close();
    if (error && error.code === "DIRFD") throw error;
    throw helperUnavailable("open");
  } finally {
    await parent.close();
  }
}

function sameInode(listed, opened) {
  return !!listed && !!opened && listed.dev === opened.dev && listed.ino === opened.ino && listed.isFile() && !listed.isSymbolicLink();
}

function callHelper(dirHandle, args, body) {
  return openTrustedHelper().then((tool) => new Promise((resolve, reject) => {
    // macOS will not execute /dev/fd. Recheck the path, then execute that path.
    // Linux executes the descriptor that was hashed, through /proc/self/fd.
    let execPath = "/proc/self/fd/4";
    if (process.platform === "darwin") {
      let listed;
      let opened;
      try {
        listed = fsSync.lstatSync(tool.path);
        opened = fsSync.fstatSync(tool.handle.fd);
      } catch {
        listed = null;
      }
      if (!sameInode(listed, opened) || !ownedAndPrivate(listed, process.getuid())) {
        Promise.resolve(tool.handle.close()).then(() => reject(helperUnavailable("race")), () => reject(helperUnavailable("race")));
        return;
      }
      execPath = tool.path;
    }
    let settled = false;
    function finish(fn) {
      if (settled) return;
      settled = true;
      Promise.resolve(tool.handle.close()).then(fn, fn);
    }
    let child;
    try {
      child = spawn(execPath, args, {
        stdio: ["pipe", "pipe", "pipe", dirHandle.fd, tool.handle.fd],
        env: {},
      });
    } catch {
      finish(() => reject(helperUnavailable("spawn")));
      return;
    }
    const out = [];
    const err = [];
    child.stdout.on("data", (chunk) => out.push(chunk));
    child.stderr.on("data", (chunk) => err.push(chunk));
    child.stdin.on("error", () => {});
    child.on("error", () => finish(() => reject(helperUnavailable("spawn"))));
    child.on("close", (code) => {
      finish(() => {
        if (code === 0) {
          resolve(Buffer.concat(out).toString("utf8"));
          return;
        }
        const name = Buffer.concat(err).toString("utf8").trim().split("\n").filter(Boolean).pop() || "EIO";
        if (name === "EEXIST" || name === "ELOOP") {
          reject(badPath());
          return;
        }
        const failed = new Error(name);
        failed.code = name;
        reject(failed);
      });
    });
    if (body && body.length) child.stdin.write(body);
    child.stdin.end();
  }));
}

function parseIdentity(text) {
  const line = String(text || "").trim().split("\n")[0] || "";
  if (line === "missing") return null;
  const parts = line.split(" ");
  if (parts.length !== 3) {
    const error = new Error("EIO");
    error.code = "EIO";
    throw error;
  }
  return {
    symlink: parts[0] === "lnk",
    regular: parts[0] === "reg",
    dev: parts[1],
    ino: parts[2],
  };
}

async function createWithHelper(dirHandle, name, payload, options) {
  const args = ["creat", plainName(name)];
  if (options && Number.isInteger(options.failAfterBytes) && options.failAfterBytes >= 0) {
    args.push(String(options.failAfterBytes));
  }
  const id = parseIdentity(await callHelper(dirHandle, args, payload));
  if (!id || !id.regular) throw badPath();
  return { dev: id.dev, ino: id.ino };
}

async function statWithHelper(dirHandle, name) {
  const id = parseIdentity(await callHelper(dirHandle, ["stat", plainName(name)]));
  if (!id) return null;
  return { dev: id.dev, ino: id.ino, symlink: id.symlink, regular: id.regular };
}

async function unlinkWithHelper(dirHandle, name, id) {
  if (!id) return false;
  const text = await callHelper(dirHandle, ["unlink", plainName(name), String(id.dev), String(id.ino)]);
  return String(text || "").trim().split("\n")[0] === "ok";
}

async function createWithProc(dirHandle, name, payload, options) {
  let handle;
  try {
    handle = await fs.open(procEntry(dirHandle.fd, name), CREATE_FLAGS, 0o644);
  } catch (e) {
    if (e.code === "ELOOP" || e.code === "EEXIST" || e.code === "ENXIO") throw badPath();
    throw e;
  }
  let id = null;
  try {
    const opened = await handle.stat();
    id = { dev: opened.dev, ino: opened.ino };
    if (options && Number.isInteger(options.failAfterBytes)) {
      const count = Math.max(0, Math.min(options.failAfterBytes, payload.length));
      if (count > 0) await writeAll(handle, payload.subarray(0, count));
      const error = new Error("EIO");
      error.code = "EIO";
      throw error;
    }
    if (payload.length) await writeAll(handle, payload);
    await handle.sync();
    return id;
  } catch (error) {
    await handle.close();
    handle = null;
    try { await unlinkWithProc(dirHandle, name, id); } catch { /* the note is still unchanged */ }
    throw error;
  } finally {
    if (handle) await handle.close();
  }
}

async function statWithProc(dirHandle, name) {
  try {
    const st = await fs.lstat(procEntry(dirHandle.fd, name));
    return { dev: st.dev, ino: st.ino, symlink: st.isSymbolicLink(), regular: st.isFile() };
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw e;
  }
}

async function unlinkWithProc(dirHandle, name, id) {
  if (!id) return false;
  const listed = await statWithProc(dirHandle, name);
  if (!listed || listed.symlink || listed.dev !== id.dev || listed.ino !== id.ino) return false;
  await fs.unlink(procEntry(dirHandle.fd, name));
  return true;
}

function procEntry(dirfd, name) {
  return "/proc/self/fd/" + dirfd + "/" + plainName(name);
}

async function writeAll(handle, payload) {
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

export async function openCheckedDirectory(dirPath, expected) {
  let handle;
  try {
    handle = await fs.open(dirPath, DIR_FLAGS);
  } catch (e) {
    if (e.code === "ELOOP" || e.code === "ENOTDIR" || e.code === "ENOENT" || e.code === "ENXIO") throw badPath();
    throw e;
  }
  try {
    const st = await handle.stat();
    if (!st.isDirectory()) throw badPath();
    if (expected && (st.dev !== expected.dev || st.ino !== expected.ino)) throw badPath();
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
}

export async function createExclusive(dirHandle, name, payload, backend = directoryBackend(), options = {}) {
  const bytes = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  if (backend === "helper") return createWithHelper(dirHandle, name, bytes, options);
  return createWithProc(dirHandle, name, bytes, options);
}

export async function statEntry(dirHandle, name, backend = directoryBackend()) {
  if (backend === "helper") return statWithHelper(dirHandle, name);
  return statWithProc(dirHandle, name);
}

export async function unlinkIfSame(dirHandle, name, id, backend = directoryBackend()) {
  if (backend === "helper") return unlinkWithHelper(dirHandle, name, id);
  return unlinkWithProc(dirHandle, name, id);
}

// A file this call just created may sit outside the vault when a parent was
// swapped before the open. Unlink it only when the directory entry is still
// the inode on this descriptor, so a second swap cannot delete something else.
export async function unlinkOpenedFile(fileHandle, backend = process.platform === "linux" ? "proc" : "helper") {
  if (backend === "helper") {
    const text = await callHelper(fileHandle, ["unlink-self", "-"]);
    return String(text || "").trim().split("\n")[0] === "ok";
  }
  const opened = await fileHandle.stat();
  const id = { dev: opened.dev, ino: opened.ino };
  let linked = "";
  try {
    linked = await fs.readlink("/proc/self/fd/" + fileHandle.fd);
  } catch {
    return false;
  }
  const cleaned = linked.replace(/ \(deleted\)$/, "");
  const parent = path.dirname(cleaned);
  const base = path.basename(cleaned);
  if (!base || base === "." || base === "..") return false;
  let dir;
  try {
    dir = await fs.open(parent, DIR_FLAGS);
  } catch {
    return false;
  }
  try {
    const st = await dir.stat();
    if (!st.isDirectory()) return false;
    return await unlinkWithProc(dir, base, id);
  } finally {
    await dir.close();
  }
}
