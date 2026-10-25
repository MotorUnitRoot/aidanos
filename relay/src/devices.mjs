// One key per device. The key itself is shown once, when the device is added,
// and is not written here. The file keeps a random salt and a SHA-256 of
// salt + key, which is enough to recognize the key later. Removing one
// device sets revokedAt on that row. The other rows are left as they are.
//
// The shared key is not copied into this file. "active" means a connection
// may still use it. "retired" means it may not. Retiring does not delete
// the shared-key file. Restoring flips this flag back to "active".

import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

export const DEVICE_FILE_NAME = "devices.json";
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
  return {
    version: 1,
    shared: parsed.shared,
    devices: parsed.devices.map(normalizeDevice),
  };
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

export async function writeDeviceBytes(dataDir, bytes) {
  await fs.mkdir(dataDir, { recursive: true });
  const file = deviceFilePath(dataDir);
  const tmp = path.join(dataDir, ".devices-" + randomUUID() + ".tmp");
  let handle;
  try {
    handle = await fs.open(tmp, WRITE_FLAGS, 0o600);
  } catch (error) {
    throw saveError(error);
  }
  try {
    await handle.writeFile(bytes);
    await handle.chmod(0o600);
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
}

async function writeRecord(dataDir, record) {
  await writeDeviceBytes(dataDir, Buffer.from(JSON.stringify(record, null, 2) + "\n", "utf8"));
}

async function loadOrEmpty(dataDir) {
  return (await readDeviceFile(dataDir)) || { version: 1, shared: "active", devices: [] };
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
  if (key.length === 0 || key.length > 512) return { active: false, revoked: false };
  let active = false;
  let revoked = false;
  for (const device of devices) {
    if (!deviceMatches(device, key)) continue;
    if (device.revokedAt) revoked = true;
    else active = true;
  }
  return { active, revoked };
}

export async function issueDevice(dataDir, name) {
  const deviceName = checkName(name);
  const current = await loadOrEmpty(dataDir);
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
  await writeRecord(dataDir, current);
  const saved = await readDeviceBytes(dataDir);
  if (saved && saved.includes(Buffer.from(key, "utf8"))) {
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
}

export async function revokeDevice(dataDir, name) {
  const deviceName = checkName(name);
  const current = await readDeviceFile(dataDir);
  if (!current) throw new Error("There is no device named " + deviceName + ".");
  const active = current.devices.filter((device) => device.name === deviceName && !device.revokedAt);
  if (active.length === 0) {
    const known = current.devices.some((device) => device.name === deviceName);
    throw new Error(known ? deviceName + " is already removed." : "There is no device named " + deviceName + ".");
  }
  const live = current.devices.filter((device) => !device.revokedAt);
  if (current.shared === "retired" && live.length <= active.length) {
    throw new Error("Restore the shared key before removing the last device key.");
  }
  const now = new Date().toISOString();
  for (const device of current.devices) {
    if (device.name === deviceName && !device.revokedAt) device.revokedAt = now;
  }
  await writeRecord(dataDir, current);
  return deviceName;
}

export async function retireSharedKey(dataDir) {
  const current = await readDeviceFile(dataDir);
  const live = current ? current.devices.filter((device) => !device.revokedAt) : [];
  if (live.length === 0) {
    throw new Error("The shared key stays on until at least one device has its own key.");
  }
  current.shared = "retired";
  await writeRecord(dataDir, current);
}

export async function restoreSharedKey(dataDir) {
  const current = await readDeviceFile(dataDir);
  if (!current || current.shared === "active") return;
  current.shared = "active";
  await writeRecord(dataDir, current);
}
