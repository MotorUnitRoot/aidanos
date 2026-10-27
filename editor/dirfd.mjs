// Open, stat, and unlink one name on a directory descriptor that was already
// checked. Node has no openat or unlinkat. On Linux, /proc/self/fd/<dirfd>/name
// is that operation. On macOS a small helper calls openat, fstatat, and
// unlinkat on the inherited descriptor.

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DIR_FLAGS = fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW;
const CREATE_FLAGS = fsConstants.O_WRONLY
  | fsConstants.O_CREAT
  | fsConstants.O_EXCL
  | fsConstants.O_NOFOLLOW
  | fsConstants.O_NONBLOCK;

function badPath() {
  const error = new Error("bad path");
  error.code = "BAD_PATH";
  return error;
}

function plainName(name) {
  const text = String(name || "");
  if (!text || text === "." || text === ".." || text.includes("/") || text.includes("\\") || text.includes("\0")) {
    throw badPath();
  }
  return text;
}

export function directoryBackend() {
  return process.platform === "linux" ? "proc" : "helper";
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

let helperBinary = null;

function helperPath() {
  if (!helperBinary) helperBinary = compileHelper();
  return helperBinary;
}

async function compileHelper() {
  const source = fileURLToPath(new URL("./dirfd-tool.c", import.meta.url));
  const src = await fs.readFile(source);
  const digest = createHash("sha256").update(src).digest("hex");
  const uid = typeof process.getuid === "function" ? process.getuid() : "user";
  const dir = path.join(os.tmpdir(), "aidanos-dirfd-" + uid);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const bin = path.join(dir, "dirfd-tool");
  const stamp = path.join(dir, "stamp");
  try {
    const prev = await fs.readFile(stamp, "utf8");
    await fs.access(bin, fsConstants.X_OK);
    if (prev.trim() === digest) return bin;
  } catch {
    /* rebuild */
  }
  const tmpBin = bin + "." + process.pid + "." + Math.random().toString(16).slice(2);
  await new Promise((resolve, reject) => {
    const child = spawn("cc", ["-O2", "-o", tmpBin, source], { stdio: ["ignore", "pipe", "pipe"] });
    let err = "";
    child.stderr.on("data", (chunk) => { err += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(err.trim() || "cc failed"));
    });
  });
  await fs.chmod(tmpBin, 0o700);
  await fs.rename(tmpBin, bin);
  await fs.writeFile(stamp, digest + "\n");
  return bin;
}

function callHelper(dirHandle, args, body) {
  return new Promise((resolve, reject) => {
    helperPath().then((bin) => {
      const child = spawn(bin, args, {
        stdio: ["pipe", "pipe", "pipe", dirHandle.fd],
      });
      const out = [];
      const err = [];
      child.stdout.on("data", (chunk) => out.push(chunk));
      child.stderr.on("data", (chunk) => err.push(chunk));
      child.on("error", reject);
      child.on("close", (code) => {
        if (code === 0) {
          resolve(Buffer.concat(out).toString("utf8"));
          return;
        }
        const name = Buffer.concat(err).toString("utf8").trim().split("\n").filter(Boolean).pop() || "EIO";
        const failed = new Error(name);
        failed.code = name;
        reject(failed);
      });
      if (body && body.length) child.stdin.write(body);
      child.stdin.end();
    }, reject);
  });
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

async function createWithHelper(dirHandle, name, payload) {
  const id = parseIdentity(await callHelper(dirHandle, ["creat", plainName(name)], payload));
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

async function createWithProc(dirHandle, name, payload) {
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

export async function createExclusive(dirHandle, name, payload, backend = directoryBackend()) {
  const bytes = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  if (backend === "helper") return createWithHelper(dirHandle, name, bytes);
  return createWithProc(dirHandle, name, bytes);
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
