// Open, stat, unlink, and rename one name on a directory descriptor that was
// already checked. Node has no openat, unlinkat, or renameat. On Linux,
// /proc/self/fd/<dirfd>/name is that operation. On macOS a small helper calls
// openat, fstatat, unlinkat, and renameat on the inherited descriptor.
//
// A pure Node walk is weaker than that helper. O_NOFOLLOW applies only to the
// last component, so opening vault/notes/file follows a parent that was
// swapped for a symlink and can create the file outside the checked folder.
// Seeing the mismatch afterwards is already too late. Linux keeps the proc
// backend, which is openat. Every other platform runs the pinned helper.
// Linux executes the verified descriptor through /proc/self/fd. macOS will
// not execute /dev/fd, so it executes the path that was just checked. Before
// that exec, every folder from / down to the helper is lstat'd. Each one
// must be owned by root or the current user, and must not be group or world
// writable unless it is sticky and owned by root. A root-owned symlink,
// such as macOS /tmp or /var, is followed. Any other symlink is refused.
// On macOS the same walk reads each folder's ACL, and the helper file's ACL,
// with one /bin/ls -lde -n. ls sorts the paths it is given, so each entry is
// matched by its full path. The process uid and gid come from getuid and
// getgid. A write grant for anyone but the owner is refused.
// The helper does not do that check: it would be reporting on itself.

import { spawn, spawnSync } from "node:child_process";
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
const STICKY = 0o1000;

// Content pin for the helper shipped in editor/bin. editor/check-dirfd.sh
// rebuilds that file from dirfd-tool.c and fails unless this SHA-256 matches.
// A rebuilt binary does not run until this constant is updated.
const HELPER_SHA256 = {
  "linux-x64": "a11fa3f5c70468692bcba1bc1fb30a47151c351100cacf98d830e3f621ef7e2c",
  "darwin-arm64": "605a6f8d353fe2a1f4b0c97de9bb9a942d6f8b00b6ed7d1c0950c521968131e4",
  "darwin-x64": "7c3d7c2e2fb15e500b6559b26b851a54b2a7c6e9cdb6c634df164458d45b8a31",
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

function overridesAllowed(env) {
  return !!(env && env.NODE_ENV === "test");
}

export function directoryBackend(env = process.env) {
  if (overridesAllowed(env)) {
    const requested = env.AIDANOS_DIRFD_BACKEND;
    if (requested === "helper" || requested === "proc") return requested;
  }
  return process.platform === "linux" ? "proc" : "helper";
}

function helperFile(env = process.env) {
  if (overridesAllowed(env) && env.AIDANOS_DIRFD_TOOL) return path.resolve(String(env.AIDANOS_DIRFD_TOOL));
  const key = helperKey();
  if (!key) return "";
  return fileURLToPath(new URL("./bin/dirfd-tool-" + key, import.meta.url));
}

// Folders from / down to leafDir. A group or other write bit is allowed only
// on a sticky directory owned by root, which is the /tmp case. A missing
// folder, or an owner who is neither root nor this user, is refused.
// macOS /tmp and /var are root-owned symlinks. Those are followed and the
// real folders are checked. Any other symlink is refused.
const MAX_ANCESTOR_LINKS = 8;

let aclSpawns = 0;

export function resetAclSpawnCount() {
  aclSpawns = 0;
}

export function aclSpawnCount() {
  return aclSpawns;
}

function selfIds() {
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  const gid = typeof process.getgid === "function" ? process.getgid() : null;
  if (typeof uid !== "number" || typeof gid !== "number") return null;
  return { uid, gid };
}

function walkToEnd(leafDir, uid) {
  if (typeof uid !== "number") return { kind: "fault", fault: "ancestor", dirs: [] };
  let abs = path.resolve(String(leafDir || ""));
  const seenLinks = new Set();
  const dirs = [];
  for (let hop = 0; hop <= MAX_ANCESTOR_LINKS; hop++) {
    const step = walkAncestors(abs, uid, seenLinks);
    if (step.dirs) dirs.push(...step.dirs);
    if (step.fault) return { kind: "fault", fault: step.fault, dirs };
    if (!step.next) return { kind: "done", dirs };
    abs = step.next;
  }
  return { kind: "limit", dirs };
}

function aclEntries(result, filePath, uid) {
  const entries = result.dirs.map((dir) => ({ path: dir.path, uid: dir.uid, file: false }));
  if (result.kind === "done" && filePath) {
    entries.push({ path: path.resolve(String(filePath)), uid, file: true });
  }
  return entries;
}

function applyAncestorAcl(result, acl) {
  if (result.kind === "limit") return "ancestor";
  if (result.kind === "fault") {
    if (acl) return "ancestor-acl";
    return result.fault;
  }
  if (acl === "file") return "helper-acl";
  if (acl) return "ancestor-acl";
  return "";
}

// filePath is included in the same listing as the directories. A fault on
// that file is "helper-acl"; a fault on a directory is "ancestor-acl".
export function ancestorFault(leafDir, uid = typeof process.getuid === "function" ? process.getuid() : null, filePath = "") {
  const result = walkToEnd(leafDir, uid);
  if (result.kind === "limit") return "ancestor";
  return applyAncestorAcl(result, aclFaultFor(aclEntries(result, filePath, uid)));
}

export async function ancestorFaultAsync(leafDir, uid = typeof process.getuid === "function" ? process.getuid() : null, filePath = "") {
  const result = walkToEnd(leafDir, uid);
  if (result.kind === "limit") return "ancestor";
  return applyAncestorAcl(result, await aclFaultForAsync(aclEntries(result, filePath, uid)));
}

function walkAncestors(abs, uid, seenLinks) {
  const chain = [];
  let cursor = abs;
  for (;;) {
    chain.push(cursor);
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  chain.reverse();
  const dirs = [];
  for (const dir of chain) {
    let st;
    try {
      st = fsSync.lstatSync(dir);
    } catch {
      return { fault: "ancestor" };
    }
    if (st.isSymbolicLink()) {
      if (st.uid !== 0 || seenLinks.has(dir)) return { fault: "ancestor" };
      seenLinks.add(dir);
      let target;
      try {
        target = fsSync.readlinkSync(dir);
      } catch {
        return { fault: "ancestor" };
      }
      const linked = path.resolve(path.dirname(dir), target);
      const rest = path.relative(dir, abs);
      const next = !rest || rest.startsWith("..") || path.isAbsolute(rest)
        ? linked
        : path.resolve(linked, rest);
      return { next, dirs };
    }
    if (!st.isDirectory()) return { fault: "ancestor" };
    const writable = (st.mode & GROUP_OR_OTHER_WRITE) !== 0;
    const stickyRoot = (st.mode & STICKY) !== 0 && st.uid === 0;
    if (writable && !stickyRoot) return { fault: "ancestor-writable", dirs };
    if (st.uid !== 0 && st.uid !== uid) return { fault: "ancestor-owner", dirs };
    dirs.push({ path: dir, uid: st.uid });
  }
  return { dirs };
}

export function installFaultText(fault) {
  if (fault === "ancestor-writable") return "group-writable ancestor";
  if (fault === "ancestor-owner") return "ancestor owned by another user";
  if (fault === "ancestor-acl") return "an ACL grants write to someone other than the owner";
  return "bad ancestor";
}

const WRITE_ACL = new Set([
  "write",
  "append",
  "delete",
  "delete_child",
  "add_file",
  "add_subdirectory",
  "writeattr",
  "writeextattr",
  "writesecurity",
  "chown",
]);

function isAclSpace(code) {
  return code === 32 || code === 9;
}

// One left-to-right pass. A regex with nested space quantifiers stalls on a
// long run of spaces, which is not a listing we should trust anyway.
function parseAclEntry(line) {
  const n = line.length;
  let i = 0;
  while (i < n && isAclSpace(line.charCodeAt(i))) i += 1;
  if (i >= n) return { empty: true };
  const numStart = i;
  while (i < n && line.charCodeAt(i) >= 48 && line.charCodeAt(i) <= 57) i += 1;
  if (i === numStart || i >= n || line.charCodeAt(i) !== 58) return null;
  i += 1;
  while (i < n && isAclSpace(line.charCodeAt(i))) i += 1;
  const principalStart = i;
  while (i < n && !isAclSpace(line.charCodeAt(i))) i += 1;
  if (i === principalStart) return null;
  const principal = line.slice(principalStart, i);
  while (i < n && isAclSpace(line.charCodeAt(i))) i += 1;
  if (line.startsWith("inherited", i) && (i + 9 === n || isAclSpace(line.charCodeAt(i + 9)))) {
    i += 9;
    while (i < n && isAclSpace(line.charCodeAt(i))) i += 1;
  }
  const actionStart = i;
  while (i < n && !isAclSpace(line.charCodeAt(i))) i += 1;
  const action = line.slice(actionStart, i);
  if (action !== "allow" && action !== "deny") return null;
  while (i < n && isAclSpace(line.charCodeAt(i))) i += 1;
  let end = n;
  while (end > i && isAclSpace(line.charCodeAt(end - 1))) end -= 1;
  if (end <= i) return null;
  return { principal, action, perms: line.slice(i, end) };
}

function permList(perms) {
  const items = [];
  let start = 0;
  for (let i = 0; i <= perms.length; i += 1) {
    if (i !== perms.length && perms.charCodeAt(i) !== 44) continue;
    let from = start;
    let to = i;
    while (from < to && isAclSpace(perms.charCodeAt(from))) from += 1;
    while (to > from && isAclSpace(perms.charCodeAt(to - 1))) to -= 1;
    if (to > from) items.push(perms.slice(from, to));
    start = i + 1;
  }
  return items;
}

// text is the stdout of `/bin/ls -lde -n` for one path. An allow entry that
// grants one of the write rights to anyone but the owner is a fault. Anything
// the parser does not recognise is a fault too. An empty string means the
// listing is clean.
export function aclListingFault(text, ownerUid, ownerName = "") {
  const lines = String(text || "").split(/\r?\n/);
  while (lines.length && lines[lines.length - 1] === "") lines.pop();
  if (!lines.length) return "acl";
  const mode = lines[0].split(/[ \t]+/)[0] || "";
  if (!/^[-dlcbps]/.test(mode) || mode.length < 10) return "acl";
  for (const line of lines.slice(1)) {
    const entry = parseAclEntry(line);
    if (!entry) return "acl";
    if (entry.empty) continue;
    if (entry.action !== "allow") continue;
    if (!permList(entry.perms).some((item) => WRITE_ACL.has(item))) continue;
    if (aclPrincipalIsOwner(entry.principal, ownerUid, ownerName)) continue;
    return "acl";
  }
  return "";
}

function decimalId(text) {
  if (!text) return null;
  let value = 0;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code < 48 || code > 57) return null;
    value = value * 10 + (code - 48);
  }
  return value;
}

function aclPrincipalIsOwner(principal, ownerUid, ownerName) {
  if (principal.startsWith("user:")) {
    const rest = principal.slice(5);
    const id = decimalId(rest);
    if (id != null) return id === ownerUid;
    return !!(ownerName && rest === ownerName);
  }
  return false;
}

function isAclHeader(line) {
  if (!line || isAclSpace(line.charCodeAt(0))) return false;
  const mode = line.split(/[ \t]+/)[0] || "";
  return /^[-dlcbps]/.test(mode) && mode.length >= 10;
}

// The pathname is whatever remains after the mode and the seven fields
// `ls -l -n` prints before it: nlink, uid, gid, size, month, day, and
// HH:MM or YYYY. A suffix of that text is not a path.
function headerPathname(header) {
  let i = 0;
  const n = header.length;
  for (let field = 0; field < 8; field += 1) {
    while (i < n && isAclSpace(header.charCodeAt(i))) i += 1;
    const start = i;
    while (i < n && !isAclSpace(header.charCodeAt(i))) i += 1;
    if (i === start) return null;
  }
  while (i < n && isAclSpace(header.charCodeAt(i))) i += 1;
  if (i >= n) return null;
  return header.slice(i);
}

// One block per requested path, in the order asked. ls prints those paths
// in its own order, so the pathname on each header has to be that path.
// A missing, extra, duplicate, or unreadable entry is refused, including a
// newline in a name, which would otherwise invent another header.
export function splitAclListing(text, paths) {
  const wanted = [];
  for (const filePath of paths) {
    const name = String(filePath);
    if (name.includes("\n") || name.includes("\r")) return null;
    wanted.push(name);
  }
  const lines = String(text || "").split(/\n/);
  while (lines.length && lines[lines.length - 1] === "") lines.pop();
  const blocks = [];
  let current = null;
  for (const raw of lines) {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (!line) {
      if (current) blocks.push(current);
      current = null;
      continue;
    }
    if (isAclHeader(line)) {
      if (current) blocks.push(current);
      current = [line];
      continue;
    }
    if (!current) return null;
    current.push(line);
  }
  if (current) blocks.push(current);
  const byPath = new Map();
  for (const block of blocks) {
    const name = headerPathname(block[0]);
    if (name == null || name.includes("\n") || name.includes("\r")) return null;
    if (byPath.has(name)) return null;
    byPath.set(name, block);
  }
  const unique = new Set(wanted);
  if (byPath.size !== unique.size) return null;
  for (const name of byPath.keys()) {
    if (!unique.has(name)) return null;
  }
  const ordered = [];
  for (const name of wanted) {
    const block = byPath.get(name);
    if (!block) return null;
    ordered.push(block);
  }
  return ordered;
}

function trustedLs() {
  let file = "/bin/ls";
  for (let hop = 0; hop < 2; hop++) {
    let st;
    try {
      st = fsSync.lstatSync(file);
    } catch {
      return "";
    }
    if (st.isSymbolicLink()) {
      if (st.uid !== 0) return "";
      let target;
      try {
        target = fsSync.readlinkSync(file);
      } catch {
        return "";
      }
      file = path.resolve(path.dirname(file), target);
      continue;
    }
    if (!st.isFile() || st.uid !== 0 || (st.mode & GROUP_OR_OTHER_WRITE) !== 0) return "";
    return file;
  }
  return "";
}

// "" is clean. "file" means the helper file's entry. "acl" means a directory.
function aclRequest(entries) {
  if (process.platform !== "darwin" || !entries.length) return { done: "" };
  const self = selfIds();
  if (!self || self.gid < 0) return { done: "acl" };
  const ls = trustedLs();
  if (!ls) return { done: "acl" };
  const paths = [];
  const seen = new Set();
  const unique = [];
  for (const entry of entries) {
    const filePath = String(entry.path);
    if (filePath.includes("\n") || filePath.includes("\r")) return { done: "acl" };
    paths.push(filePath);
    if (seen.has(filePath)) continue;
    seen.add(filePath);
    unique.push(filePath);
  }
  unique.sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  return { self, ls, paths, unique, entries };
}

function aclFromListing(request, listed) {
  if (!listed || listed.error || listed.status !== 0) return "acl";
  const blocks = splitAclListing(listed.stdout, request.paths);
  if (!blocks) return "acl";
  for (let i = 0; i < request.entries.length; i += 1) {
    const ownerUid = typeof request.entries[i].uid === "number" ? request.entries[i].uid : request.self.uid;
    if (aclListingFault(blocks[i].join("\n"), ownerUid, "")) {
      return request.entries[i].file ? "file" : "acl";
    }
  }
  return "";
}

function aclFaultFor(entries) {
  const request = aclRequest(entries);
  if (request.done !== undefined) return request.done;
  aclSpawns += 1;
  const listed = spawnSync(request.ls, ["-lde", "-n", ...request.unique], {
    encoding: "utf8",
    env: { LC_ALL: "C", PATH: "/bin:/usr/bin" },
    timeout: 5000,
  });
  return aclFromListing(request, listed);
}

// Same check as aclFaultFor. spawnSync froze the worker for the whole `ls`,
// which showed up as a multi-second event-loop gap during a mirror pass.
// Nothing is cached: the next save lists the paths again.
function captureSpawn(cmd, args) {
  return new Promise((resolve) => {
    let settled = false;
    function finish(result) {
      if (settled) return;
      settled = true;
      resolve(result);
    }
    let child;
    try {
      child = spawn(cmd, args, {
        env: { LC_ALL: "C", PATH: "/bin:/usr/bin" },
        timeout: 5000,
        killSignal: "SIGKILL",
      });
    } catch (error) {
      finish({ error, status: null, stdout: "" });
      return;
    }
    const out = [];
    if (child.stdout) child.stdout.on("data", (chunk) => out.push(chunk));
    if (child.stderr) child.stderr.on("data", () => {});
    child.on("error", (error) => finish({ error, status: null, stdout: "" }));
    child.on("close", (status) => {
      finish({ error: null, status, stdout: Buffer.concat(out).toString("utf8") });
    });
  });
}

async function aclFaultForAsync(entries) {
  const request = aclRequest(entries);
  if (request.done !== undefined) return request.done;
  aclSpawns += 1;
  const listed = await captureSpawn(request.ls, ["-lde", "-n", ...request.unique]);
  return aclFromListing(request, listed);
}

function foreignAcl(filePath, ownerUid) {
  return aclFaultFor([{ path: filePath, uid: ownerUid, file: true }]) ? "acl" : "";
}

async function foreignAclAsync(filePath, ownerUid) {
  const fault = await aclFaultForAsync([{ path: filePath, uid: ownerUid, file: true }]);
  return fault ? "acl" : "";
}

// A umask 002 checkout leaves the helper group-writable. Saves keep refusing
// it. Startup prints this exact command so the mode can be fixed in place.
export function groupWritableHelperMessage(binDir) {
  let bad = false;
  let listed;
  try {
    listed = fsSync.lstatSync(binDir);
  } catch {
    return "";
  }
  if (!listed.isSymbolicLink() && listed.isDirectory() && (listed.mode & GROUP_OR_OTHER_WRITE) !== 0) bad = true;
  let names = [];
  try {
    names = fsSync.readdirSync(binDir);
  } catch {
    names = [];
  }
  for (const name of names) {
    if (!name.startsWith("dirfd-tool-")) continue;
    try {
      const file = fsSync.lstatSync(path.join(binDir, name));
      if ((file.mode & GROUP_OR_OTHER_WRITE) !== 0) bad = true;
    } catch {
      // A missing helper is refused when a save needs it.
    }
  }
  return bad ? "chmod go-w editor/bin editor/bin/dirfd-tool-*" : "";
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

// The folder that contains the helper may be root's. The ancestor walk
// already allows that. Group and other write stay refused. The helper file
// itself still has to belong to this user.
function ownedByAcceptableParent(st, uid) {
  return !!st && (st.uid === uid || st.uid === 0) && (st.mode & GROUP_OR_OTHER_WRITE) === 0;
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
  const fault = await ancestorFaultAsync(parentPath, uid);
  if (fault) throw helperUnavailable(fault);
  let listed;
  let parentListed;
  try {
    listed = await fs.lstat(filePath);
    parentListed = await fs.lstat(parentPath);
  } catch {
    throw helperUnavailable("stat");
  }
  if (listed.isSymbolicLink() || parentListed.isSymbolicLink() || !parentListed.isDirectory()) throw helperUnavailable("symlink");
  if (!ownedByAcceptableParent(parentListed, uid)) throw helperUnavailable("parent-owner");
  // This listing is the parent-owner refusal. A mode or owner change after
  // the directory is open is a race, checked again below.

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
    if (!ownedByAcceptableParent(parentStat, uid)) throw helperUnavailable("race");
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
    if (!ownedAndPrivate(again, uid)) throw helperUnavailable("owner");
    if (!ownedByAcceptableParent(parentAgain, uid)) throw helperUnavailable("race");
    if (parentAgain.dev !== parentStat.dev || parentAgain.ino !== parentStat.ino) throw helperUnavailable("race");
    if (await foreignAclAsync(filePath, again.uid)) throw helperUnavailable("helper-acl");
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

function callHelper(dirHandle, args, body, borrowed) {
  const ready = borrowed ? Promise.resolve(borrowed) : openTrustedHelper();
  return ready.then(async (tool) => {
    // The same checked descriptor is reused for every call in one save.
    // The folder walk still runs before each exec: a parent can change
    // without the open file descriptor changing. The listing is async so
    // the walk does not freeze the caller while `ls` runs.
    const uid = typeof process.getuid === "function" ? process.getuid() : null;
    const fault = await ancestorFaultAsync(path.dirname(tool.path), uid, tool.path);
    if (fault) {
      if (!borrowed) {
        try { await tool.handle.close(); } catch { /* already closed */ }
      }
      throw helperUnavailable(fault);
    }
    return new Promise((resolve, reject) => {
    function rejectClosed(error) {
      if (borrowed) {
        reject(error);
        return;
      }
      Promise.resolve(tool.handle.close()).then(() => reject(error), () => reject(error));
    }
    // macOS will not execute /dev/fd. Recheck the path, then execute that path.
    // Linux executes the descriptor that was hashed, through /proc/self/fd.
    // TODO: once Developer ID signing exists, check the helper's code
    // signature before this exec. The owner walk is the check until then.
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
        rejectClosed(helperUnavailable("race"));
        return;
      }
      execPath = tool.path;
    }
    let settled = false;
    function finish(fn) {
      if (settled) return;
      settled = true;
      if (borrowed) {
        fn();
        return;
      }
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
    });
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

async function createWithHelper(dirHandle, name, payload, options) {
  const args = ["creat", plainName(name)];
  if (options && Number.isInteger(options.failAfterBytes) && options.failAfterBytes >= 0) {
    args.push(String(options.failAfterBytes));
  }
  const id = parseIdentity(await callHelper(dirHandle, args, payload, options && options.tool));
  if (!id || !id.regular) throw badPath();
  return { dev: id.dev, ino: id.ino };
}

async function statWithHelper(dirHandle, name, tool) {
  const id = parseIdentity(await callHelper(dirHandle, ["stat", plainName(name)], null, tool));
  if (!id) return null;
  return { dev: id.dev, ino: id.ino, symlink: id.symlink, regular: id.regular };
}

async function unlinkWithHelper(dirHandle, name, id, tool) {
  if (!id) return false;
  const text = await callHelper(dirHandle, ["unlink", plainName(name), String(id.dev), String(id.ino)], null, tool);
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

async function renameWithHelper(dirHandle, fromName, toName, tool) {
  const text = await callHelper(
    dirHandle,
    ["rename", plainName(fromName), plainName(toName)],
    null,
    tool,
  );
  if (String(text || "").trim().split("\n")[0] !== "ok") {
    const error = new Error("EIO");
    error.code = "EIO";
    throw error;
  }
}

async function renameWithProc(dirHandle, fromName, toName) {
  const srcPath = procEntry(dirHandle.fd, fromName);
  const dstPath = procEntry(dirHandle.fd, toName);
  const src = await fs.lstat(srcPath);
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  if (src.isSymbolicLink() || !src.isFile() || src.nlink !== 1) throw badPath();
  if (typeof uid === "number" && src.uid !== uid) throw badPath();
  let dst = null;
  try {
    dst = await fs.lstat(dstPath);
  } catch (error) {
    if (!error || error.code !== "ENOENT") throw error;
  }
  if (dst) {
    if (dst.isSymbolicLink() || !dst.isFile() || dst.nlink !== 1) throw badPath();
    if (typeof uid === "number" && dst.uid !== uid) throw badPath();
  }
  await fs.rename(srcPath, dstPath);
  await dirHandle.sync();
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

export async function openDirectoryHelper(env = process.env) {
  if (directoryBackend(env) !== "helper") return null;
  return openTrustedHelper(env);
}

export async function createExclusive(dirHandle, name, payload, backend = directoryBackend(), options = {}) {
  const bytes = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  if (backend === "helper") return createWithHelper(dirHandle, name, bytes, options);
  return createWithProc(dirHandle, name, bytes, options);
}

export async function statEntry(dirHandle, name, backend = directoryBackend(), tool = null) {
  if (backend === "helper") return statWithHelper(dirHandle, name, tool);
  return statWithProc(dirHandle, name);
}

export async function unlinkIfSame(dirHandle, name, id, backend = directoryBackend(), tool = null) {
  if (backend === "helper") return unlinkWithHelper(dirHandle, name, id, tool);
  return unlinkWithProc(dirHandle, name, id);
}

// Atomic replace inside the checked directory. The temp and the destination
// are both one path component. A symlink or a second hard link is refused.
export async function renameEntry(dirHandle, fromName, toName, backend = directoryBackend(), tool = null) {
  if (backend === "helper") return renameWithHelper(dirHandle, fromName, toName, tool);
  return renameWithProc(dirHandle, fromName, toName);
}

// A file this call just created may sit outside the vault when a parent was
// swapped before the open. Unlink it only when the directory entry is still
// the inode on this descriptor, so a second swap cannot delete something else.
export async function unlinkOpenedFile(fileHandle, backend = directoryBackend(), tool = null) {
  if (backend === "helper") {
    const text = await callHelper(fileHandle, ["unlink-self", "-"], null, tool);
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
