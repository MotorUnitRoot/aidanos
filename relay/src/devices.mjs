// One key per device. The key itself is shown once, when the device is added,
// and is not written here. The file keeps a random salt and a SHA-256 of
// salt + key, which is enough to recognize the key later. Removing one
// device sets revokedAt on that row. The other rows are left as they are.
//
// The shared key is not copied into this file. Whether device keys are in
// use, and whether the shared key is retired, also live in device-policy.
// That file is not a key. A notes reset does not delete it or devices.json.
// If device keys were issued and devices.json is missing or unreadable, the
// relay refuses to start. The shared key comes back only from
// --restore-shared-key (when the device file is readable) or
// --reenable-shared-key (the explicit command when it is not).
// devices.json.bak is the last good copy of the fingerprints. Nothing reads
// it unless --restore-device-file is run. It never turns the shared key on.
// A backup older than the revision in device-policy is refused, so a removed
// device does not come back from a stale copy.

import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { logSafe } from "./redact.mjs";

export const DEVICE_FILE_NAME = "devices.json";
export const DEVICE_BACKUP_NAME = "devices.json.bak";
export const DEVICE_POLICY_NAME = "device-policy";
const LOCK_NAME = ".devices.lock";
const POLICY_HEADER = "aidanos-device-policy v1";
const MAX_DEVICES = 32;
const MAX_DEVICE_FILE = 64 * 1024;
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PLAIN = /^[\x21-\x7e]+$/;
const DUMMY = Buffer.alloc(32);
const READ_FLAGS = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0);
const WRITE_FLAGS =
  fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | (fsConstants.O_NOFOLLOW || 0);

const UNREADABLE = "The device file is unreadable. The relay will not start.";

export function deviceFilePath(dataDir) {
  return path.join(dataDir, DEVICE_FILE_NAME);
}

export function deviceBackupPath(dataDir) {
  return path.join(dataDir, DEVICE_BACKUP_NAME);
}

export function devicePolicyPath(dataDir) {
  return path.join(dataDir, DEVICE_POLICY_NAME);
}

export function preservedDevicePaths(dataDir) {
  return [deviceFilePath(dataDir), deviceBackupPath(dataDir), devicePolicyPath(dataDir), path.join(dataDir, LOCK_NAME)];
}

function checkName(name) {
  const deviceName = String(name ?? "");
  if (!NAME.test(deviceName)) {
    throw new Error("Name the device with letters and numbers, for example Mac or iPhone.");
  }
  return deviceName;
}

function decodeExact(text, bytes) {
  if (typeof text !== "string" || !/^[A-Za-z0-9_-]+$/.test(text)) return null;
  const buf = Buffer.from(text, "base64url");
  if (buf.length !== bytes) return null;
  return buf;
}

function digest(salt, key) {
  return createHash("sha256").update(salt).update(String(key), "utf8").digest();
}

function deviceMatches(device, key) {
  const salt = decodeExact(device.salt, 16);
  const expected = decodeExact(device.hash, 32);
  if (!salt || !expected) {
    timingSafeEqual(DUMMY, DUMMY);
    return false;
  }
  return timingSafeEqual(digest(salt, key), expected);
}

function failUnreadable() {
  throw new Error(UNREADABLE);
}

function normalizeDevice(device) {
  if (!device || typeof device !== "object" || Array.isArray(device)) failUnreadable();
  let name;
  try {
    name = checkName(device.name);
  } catch {
    failUnreadable();
  }
  if (typeof device.id !== "string" || !UUID.test(device.id)) failUnreadable();
  if (typeof device.salt !== "string" || !decodeExact(device.salt, 16)) failUnreadable();
  if (typeof device.hash !== "string" || !decodeExact(device.hash, 32)) failUnreadable();
  if (typeof device.createdAt !== "string" || !PLAIN.test(device.createdAt)) failUnreadable();
  let revokedAt = null;
  if (device.revokedAt != null) {
    if (typeof device.revokedAt !== "string" || !PLAIN.test(device.revokedAt)) failUnreadable();
    revokedAt = device.revokedAt;
  }
  return {
    id: device.id,
    name,
    salt: device.salt,
    hash: device.hash,
    createdAt: device.createdAt,
    revokedAt,
  };
}

export function parseDeviceRecord(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    failUnreadable();
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) failUnreadable();
  if (parsed.version !== 1) {
    throw new Error("The device file is from a newer relay. This one will not guess.");
  }
  if (parsed.shared !== "active" && parsed.shared !== "retired") failUnreadable();
  if (!Array.isArray(parsed.devices) || parsed.devices.length > MAX_DEVICES) failUnreadable();
  let revision = 0;
  if (parsed.revision != null) {
    if (!Number.isSafeInteger(parsed.revision) || parsed.revision < 0) failUnreadable();
    revision = parsed.revision;
  }
  return {
    version: 1,
    revision,
    shared: parsed.shared,
    devices: parsed.devices.map(normalizeDevice),
  };
}

function bumpRevision(record) {
  const current = record.revision == null ? 0 : record.revision;
  if (!Number.isSafeInteger(current) || current < 0) failUnreadable();
  record.revision = current + 1;
  return record.revision;
}

async function statDeviceFile(dataDir) {
  const file = deviceFilePath(dataDir);
  try {
    return await fs.lstat(file);
  } catch (error) {
    if (error && error.code === "ENOENT") return null;
    failUnreadable();
  }
  return null;
}

export async function readDeviceBytes(dataDir) {
  const info = await statDeviceFile(dataDir);
  if (!info) return null;
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new Error("The device file has to be a regular file.");
  }
  if (info.size > MAX_DEVICE_FILE) failUnreadable();
  let handle;
  try {
    handle = await fs.open(deviceFilePath(dataDir), READ_FLAGS);
  } catch {
    failUnreadable();
  }
  try {
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

export async function readDeviceFile(dataDir) {
  const info = await statDeviceFile(dataDir);
  if (!info) return null;
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new Error("The device file has to be a regular file.");
  }
  if ((info.mode & 0o777) !== 0o600) {
    throw new Error("The device file must be readable only by you (mode 0600).");
  }
  const bytes = await readDeviceBytes(dataDir);
  if (!bytes) return null;
  return parseDeviceRecord(bytes.toString("utf8"));
}

function saveError(error) {
  const code = error && typeof error.code === "string" ? " (" + error.code + ")" : "";
  return new Error("The device file could not be saved" + code + ".");
}

async function fsyncDirectory(dir) {
  const flags = fsConstants.O_RDONLY | (fsConstants.O_DIRECTORY || 0);
  let handle;
  try {
    handle = await fs.open(dir, flags);
  } catch {
    return;
  }
  try {
    await handle.sync();
  } catch {
    // A directory sync can be refused. The rename already replaced the name.
  } finally {
    await handle.close();
  }
}

async function writeDurableFile(dir, name, bytes) {
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, name);
  const tmp = path.join(dir, "." + name + "-" + randomUUID() + ".tmp");
  let handle;
  try {
    handle = await fs.open(tmp, WRITE_FLAGS, 0o600);
  } catch (error) {
    throw saveError(error);
  }
  try {
    await handle.writeFile(bytes);
    await handle.chmod(0o600);
    await handle.sync();
  } catch (error) {
    await handle.close().catch(() => {});
    await fs.rm(tmp, { force: true });
    throw saveError(error);
  }
  await handle.close();
  try {
    await fs.rename(tmp, file);
  } catch (error) {
    await fs.rm(tmp, { force: true });
    throw saveError(error);
  }
  await fs.chmod(file, 0o600);
  let published;
  try {
    published = await fs.open(file, READ_FLAGS);
    await published.sync();
  } catch {
    // The bytes were synced before the name was published.
  } finally {
    if (published) await published.close();
  }
  await fsyncDirectory(dir);
}

export async function writeDeviceBytes(dataDir, bytes) {
  await writeDurableFile(dataDir, DEVICE_FILE_NAME, bytes);
  try {
    await writeDurableFile(dataDir, DEVICE_BACKUP_NAME, bytes);
  } catch (error) {
    // The live file is already in place. The backup is not used on its own.
    logSafe([], "device backup was not saved:", error instanceof Error ? error.message : "error");
  }
}

export async function withDeviceLock(dataDir, fn) {
  await fs.mkdir(dataDir, { recursive: true });
  const lockPath = path.join(dataDir, LOCK_NAME);
  const started = Date.now();
  for (;;) {
    let handle;
    try {
      handle = await fs.open(lockPath, WRITE_FLAGS, 0o600);
    } catch (error) {
      if (!error || error.code !== "EEXIST") throw new Error("The device file is busy.");
      let stale = false;
      try {
        const info = await fs.lstat(lockPath);
        stale = Date.now() - info.mtimeMs > 30000;
      } catch {
        stale = false;
      }
      if (stale) {
        await fs.rm(lockPath, { force: true });
        continue;
      }
      if (Date.now() - started > 20000) throw new Error("The device file is busy. Try again.");
      await new Promise((resolve) => setTimeout(resolve, 20));
      continue;
    }
    try {
      return await fn();
    } finally {
      await handle.close();
      await fs.rm(lockPath, { force: true });
    }
  }
}

export async function readDevicePolicy(dataDir) {
  const file = devicePolicyPath(dataDir);
  let info;
  try {
    info = await fs.lstat(file);
  } catch (error) {
    if (error && error.code === "ENOENT") {
    return { exists: false, devicesIssued: false, sharedRetired: false, revision: 0 };
  }
    throw new Error("The device policy is unreadable. The relay will not start.");
  }
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new Error("The device policy has to be a regular file.");
  }
  if ((info.mode & 0o777) !== 0o600) {
    throw new Error("The device policy must be readable only by you (mode 0600).");
  }
  if (info.size > 1024) throw new Error("The device policy is unreadable. The relay will not start.");
  let handle;
  try {
    handle = await fs.open(file, READ_FLAGS);
  } catch {
    throw new Error("The device policy is unreadable. The relay will not start.");
  }
  let text;
  try {
    text = await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
  const lines = text.split("\n");
  if (lines[0] !== POLICY_HEADER) throw new Error("The device policy is unreadable. The relay will not start.");
  if (lines[1] !== "devices-issued yes" && lines[1] !== "devices-issued no") {
    throw new Error("The device policy is unreadable. The relay will not start.");
  }
  if (lines[2] !== "shared retired" && lines[2] !== "shared active") {
    throw new Error("The device policy is unreadable. The relay will not start.");
  }
  let revision = 0;
  if (lines.length === 4 && lines[3] === "") {
    revision = 0;
  } else if (lines.length === 5 && lines[4] === "" && /^revision (0|[1-9][0-9]*)$/.test(lines[3])) {
    revision = Number(lines[3].slice("revision ".length));
    if (!Number.isSafeInteger(revision)) throw new Error("The device policy is unreadable. The relay will not start.");
  } else {
    throw new Error("The device policy is unreadable. The relay will not start.");
  }
  return {
    exists: true,
    devicesIssued: lines[1] === "devices-issued yes",
    sharedRetired: lines[2] === "shared retired",
    revision,
  };
}

export async function writeDevicePolicy(dataDir, policy) {
  const existing = await readDevicePolicy(dataDir);
  let revision = policy && Number.isSafeInteger(policy.revision) && policy.revision >= 0 ? policy.revision : 0;
  if (existing.revision > revision) revision = existing.revision;
  const issued = policy && policy.devicesIssued ? "yes" : "no";
  const shared = policy && policy.sharedRetired ? "retired" : "active";
  const text =
    POLICY_HEADER +
    "\ndevices-issued " +
    issued +
    "\nshared " +
    shared +
    "\nrevision " +
    String(revision) +
    "\n";
  await writeDurableFile(dataDir, DEVICE_POLICY_NAME, Buffer.from(text, "utf8"));
}

export async function readDeviceState(dataDir) {
  const policy = await readDevicePolicy(dataDir);
  let record = null;
  let unreadable = false;
  try {
    record = await readDeviceFile(dataDir);
  } catch {
    unreadable = true;
  }
  return { policy, record, unreadable };
}

const MISSING_DEVICE_FILE = "Device keys are in use, but the device file is missing. The relay will not start.";

export async function reconcileDeviceState(dataDir) {
  return withDeviceLock(dataDir, async () => {
    const policy = await readDevicePolicy(dataDir);
    let record = null;
    try {
      record = await readDeviceFile(dataDir);
    } catch (error) {
      throw error;
    }
    if (policy.devicesIssued && !record) {
      throw new Error(MISSING_DEVICE_FILE);
    }
    if (!policy.exists && record && record.devices.length > 0) {
      const adopted = {
        devicesIssued: true,
        sharedRetired: record.shared === "retired",
        revision: record.revision || 0,
      };
      await writeDevicePolicy(dataDir, adopted);
      return { policy: { ...adopted, exists: true }, record };
    }
    if (record && record.shared === "retired" && !policy.sharedRetired) {
      const next = {
        devicesIssued: true,
        sharedRetired: true,
        revision: Math.max(policy.revision || 0, record.revision || 0),
      };
      await writeDevicePolicy(dataDir, next);
      return { policy: { ...next, exists: true }, record };
    }
    if (policy.sharedRetired && record && record.shared !== "retired") {
      record.shared = "retired";
      bumpRevision(record);
      await writeRecord(dataDir, record);
      await writeDevicePolicy(dataDir, {
        devicesIssued: policy.devicesIssued || record.devices.length > 0,
        sharedRetired: true,
        revision: record.revision,
      });
    }
    return { policy, record };
  });
}

async function writeRecord(dataDir, record) {
  await writeDeviceBytes(dataDir, Buffer.from(JSON.stringify(record, null, 2) + "\n", "utf8"));
}

export function deviceLines(record) {
  if (!record) return ["shared on", "no devices"];
  const lines = [record.shared === "retired" ? "shared off" : "shared on"];
  if (record.devices.length === 0) lines.push("no devices");
  for (const device of record.devices) {
    lines.push(device.name + " " + (device.revokedAt ? "removed" : "active"));
  }
  return lines;
}

// Walk every row. One device being removed does not stop the walk, so the
// check takes the same shape for a live key, a removed key, and an unknown key.
export function classifyPresented(record, presented) {
  const key = String(presented ?? "");
  const devices = record && Array.isArray(record.devices) ? record.devices : [];
  if (key.length === 0 || key.length > 512) return { active: false, revoked: false, deviceId: "" };
  let active = false;
  let revoked = false;
  let deviceId = "";
  for (const device of devices) {
    if (!deviceMatches(device, key)) continue;
    if (device.revokedAt) revoked = true;
    else {
      active = true;
      deviceId = device.id;
    }
  }
  return { active, revoked, deviceId };
}

export async function issueDevice(dataDir, name) {
  const deviceName = checkName(name);
  return withDeviceLock(dataDir, async () => {
    const policy = await readDevicePolicy(dataDir);
    let current;
    try {
      current = await readDeviceFile(dataDir);
    } catch {
      throw new Error("The device file is unreadable. The relay will not change it.");
    }
    if (policy.devicesIssued && !current) {
      throw new Error(
        "The device file is missing. Restore it, or run --reenable-shared-key before issuing another key.",
      );
    }
    current = current || {
      version: 1,
      shared: policy.sharedRetired ? "retired" : "active",
      devices: [],
    };
    if (policy.sharedRetired) current.shared = "retired";
    if (current.devices.some((device) => device.name === deviceName && !device.revokedAt)) {
      throw new Error(deviceName + " already has a key. Remove that key before issuing a new one.");
    }
    if (current.devices.length >= MAX_DEVICES) {
      throw new Error("The relay already has as many device keys as it will store.");
    }
    const key = randomBytes(32).toString("base64url");
    const salt = randomBytes(16);
    const entry = {
      id: randomUUID(),
      name: deviceName,
      salt: salt.toString("base64url"),
      hash: digest(salt, key).toString("base64url"),
      createdAt: new Date().toISOString(),
      revokedAt: null,
    };
    current.devices.push(entry);
    bumpRevision(current);
    await writeRecord(dataDir, current);
    await writeDevicePolicy(dataDir, {
      devicesIssued: true,
      sharedRetired: current.shared === "retired",
      revision: current.revision,
    });
    const saved = await readDeviceBytes(dataDir);
    let backup = null;
    try {
      backup = await readBackupBytes(dataDir);
    } catch {
      backup = null;
    }
    const leaked = Buffer.from(key, "utf8");
    if ((saved && saved.includes(leaked)) || (backup && backup.includes(leaked))) {
      current.devices.pop();
      try {
        await writeRecord(dataDir, current);
      } catch {
        // The error below stays generic. It does not repeat the key.
      }
      throw new Error("The device key was not saved.");
    }
    return {
      id: entry.id,
      name: deviceName,
      key,
      announcement: "Put this key in the " + deviceName + " app. It is shown once.\n" + key + "\n",
    };
  });
}

export async function revokeDevice(dataDir, name) {
  const deviceName = checkName(name);
  return withDeviceLock(dataDir, async () => {
    const policy = await readDevicePolicy(dataDir);
    const current = await readDeviceFile(dataDir);
    if (!current) throw new Error("There is no device named " + deviceName + ".");
    const active = current.devices.filter((device) => device.name === deviceName && !device.revokedAt);
    if (active.length === 0) {
      const known = current.devices.some((device) => device.name === deviceName);
      throw new Error(known ? deviceName + " is already removed." : "There is no device named " + deviceName + ".");
    }
    const retired = policy.sharedRetired || current.shared === "retired";
    const live = current.devices.filter((device) => !device.revokedAt);
    if (retired && live.length <= active.length) {
      throw new Error("Restore the shared key before removing the last device key.");
    }
    const now = new Date().toISOString();
    for (const device of current.devices) {
      if (device.name === deviceName && !device.revokedAt) device.revokedAt = now;
    }
    if (retired) current.shared = "retired";
    bumpRevision(current);
    await writeRecord(dataDir, current);
    await writeDevicePolicy(dataDir, { devicesIssued: true, sharedRetired: retired, revision: current.revision });
    return active.map((device) => device.id);
  });
}

export async function retireSharedKey(dataDir) {
  return withDeviceLock(dataDir, async () => {
    let current;
    try {
      current = await readDeviceFile(dataDir);
    } catch {
      throw new Error("The device file is unreadable. The shared key was not changed.");
    }
    const live = current ? current.devices.filter((device) => !device.revokedAt) : [];
    if (live.length === 0) {
      throw new Error("The shared key stays on until at least one device has its own key.");
    }
    // The policy is written first. A crash before the device file is updated
    // still leaves the shared key off. The revision moves with it, so an older
    // backup cannot be restored over this change.
    const revision = (current.revision || 0) + 1;
    await writeDevicePolicy(dataDir, { devicesIssued: true, sharedRetired: true, revision });
    current.shared = "retired";
    current.revision = revision;
    await writeRecord(dataDir, current);
  });
}

export async function restoreSharedKey(dataDir) {
  return withDeviceLock(dataDir, async () => {
    let current;
    try {
      current = await readDeviceFile(dataDir);
    } catch {
      throw new Error(
        "The device file is unreadable. The shared key stays as it is. Run --reenable-shared-key to turn it back on.",
      );
    }
    if (!current) {
      throw new Error(
        "The device file is missing. The shared key stays as it is. Run --reenable-shared-key to turn it back on.",
      );
    }
    current.shared = "active";
    bumpRevision(current);
    await writeRecord(dataDir, current);
    await writeDevicePolicy(dataDir, {
      devicesIssued: current.devices.length > 0,
      sharedRetired: false,
      revision: current.revision,
    });
  });
}

export async function reenableSharedKey(dataDir) {
  return withDeviceLock(dataDir, async () => {
    const policy = await readDevicePolicy(dataDir);
    let current = null;
    let broken = false;
    try {
      current = await readDeviceFile(dataDir);
    } catch {
      broken = true;
    }
    const currentRevision = current && Number.isSafeInteger(current.revision) ? current.revision : 0;
    const revision = Math.max(policy.revision || 0, currentRevision) + 1;
    if (broken) {
      const moved = await moveDeviceFileAside(dataDir);
      await writeDevicePolicy(dataDir, { devicesIssued: false, sharedRetired: false, revision });
      if (moved) {
        return "Moved the device file aside and turned every device key off. The shared key can open a connection again.";
      }
      return "The device file is missing. The shared key can open a connection again. Device keys stay off.";
    }
    if (!current) {
      await writeDevicePolicy(dataDir, { devicesIssued: false, sharedRetired: false, revision });
      return "The device file is missing. The shared key can open a connection again. Device keys stay off.";
    }
    current.shared = "active";
    current.revision = revision;
    await writeRecord(dataDir, current);
    await writeDevicePolicy(dataDir, {
      devicesIssued: current.devices.length > 0,
      sharedRetired: false,
      revision,
    });
    return "The shared key can open a connection again. Existing device keys were kept.";
  });
}

export async function restoreDeviceFile(dataDir) {
  return withDeviceLock(dataDir, async () => {
    let live;
    try {
      live = await readDeviceFile(dataDir);
    } catch {
      live = undefined;
    }
    if (live) {
      throw new Error("The device file is already readable. The relay will not replace it.");
    }
    const backup = await readBackupBytes(dataDir);
    if (!backup) throw new Error("There is no saved device file to restore.");
    let record;
    try {
      record = parseDeviceRecord(backup.toString("utf8"));
    } catch {
      throw new Error("The saved device file is unreadable. The relay will not restore it.");
    }
    const policy = await readDevicePolicy(dataDir);
    if ((record.revision || 0) < (policy.revision || 0)) {
      throw new Error("The saved device file is older than the last device change. The relay will not restore it.");
    }
    if (policy.sharedRetired || record.shared === "retired") record.shared = "retired";
    record.revision = Math.max(record.revision || 0, policy.revision || 0);
    await writeRecord(dataDir, record);
    await writeDevicePolicy(dataDir, {
      devicesIssued: true,
      sharedRetired: policy.sharedRetired || record.shared === "retired",
      revision: record.revision,
    });
  });
}

async function readBackupBytes(dataDir) {
  const file = deviceBackupPath(dataDir);
  let info;
  try {
    info = await fs.lstat(file);
  } catch (error) {
    if (error && error.code === "ENOENT") return null;
    throw new Error("The saved device file is unreadable.");
  }
  if (info.isSymbolicLink() || !info.isFile()) throw new Error("The saved device file has to be a regular file.");
  if ((info.mode & 0o777) !== 0o600) throw new Error("The saved device file must be readable only by you (mode 0600).");
  if (info.size > MAX_DEVICE_FILE) throw new Error("The saved device file is unreadable.");
  let handle;
  try {
    handle = await fs.open(file, READ_FLAGS);
  } catch {
    throw new Error("The saved device file is unreadable.");
  }
  try {
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

async function moveDeviceFileAside(dataDir) {
  const file = deviceFilePath(dataDir);
  let info;
  try {
    info = await fs.lstat(file);
  } catch (error) {
    if (error && error.code === "ENOENT") return "";
    throw new Error("The device file could not be moved aside.");
  }
  if (!info) return "";
  const aside = path.join(dataDir, "devices.json.aside");
  let dest = aside;
  try {
    await fs.lstat(aside);
    dest = path.join(dataDir, "devices.json.aside-" + Date.now());
  } catch (error) {
    if (!error || error.code !== "ENOENT") throw new Error("The device file could not be moved aside.");
  }
  try {
    await fs.rename(file, dest);
  } catch {
    throw new Error("The device file could not be moved aside.");
  }
  return dest;
}
