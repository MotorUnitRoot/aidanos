import http from "node:http";
import { constants as fsConstants, writeSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { pathToFileURL } from "node:url";
import { WebSocketServer } from "ws";
import { Repo, isValidDocumentId } from "@automerge/automerge-repo";
import { decode } from "@automerge/automerge-repo/helpers/cbor.js";
import { NodeWSServerAdapter } from "@automerge/automerge-repo-network-websocket";
import { NodeFSStorageAdapter } from "@automerge/automerge-repo-storage-nodefs";
import { listenHosts } from "./bind.mjs";
import {
  classifyPresented,
  deviceLines,
  issueDevice,
  preservedDevicePaths,
  readDeviceState,
  withDeviceLock,
  reconcileDeviceState,
  reenableSharedKey,
  restoreDeviceFile,
  restoreSharedKey,
  retireSharedKey,
  revokeDevice,
} from "./devices.mjs";
import { backupOnce } from "./git.mjs";
import { INDEX_ID } from "./ids.mjs";
import { createMirror } from "./mirror.mjs";
import { logSafe, stampLine } from "./redact.mjs";
import { logSyncFrame } from "./sync-log.mjs";

const DEFAULT_PORT = 3750;
const MIN_TOKEN_LENGTH = 32;
// A note's first sync is its whole history. 1 MB was small enough to reject that
// and leave the device retrying forever. The app uses this same 32 MB cap and
// refuses an oversized note on its own, so the socket stays up for every other note.
export const MAX_PAYLOAD = 32 * 1024 * 1024;
const FAILURE_CAP = 1024;
export const LAN_WARNING =
  "WARNING: --lan sends notes across your home network with no encryption. The token is the only protection.";

const CLIENT_MARKERS = ["actor", "storage-id", "index"];

export function tokensMatch(expected, got) {
  const left = Buffer.from(String(expected || ""));
  const right = Buffer.from(String(got || ""));
  if (left.length === 0 || left.length !== right.length) {
    timingSafeEqual(left, left);
    return false;
  }
  return timingSafeEqual(left, right);
}

// The shared key is compared in memory. A device key is accepted only when
// its fingerprint matches a row that has not been removed. A removed key and
// an unknown key are both refused. The caller does not say which one it was.
// The shared key is off when either the device file or the policy marker says
// so. A missing device file, after device keys were issued, is refused here too.
export function connectionAllowed({ sharedToken, record, presented, policy, unreadable }) {
  const issued = Boolean(policy && policy.devicesIssued);
  if (unreadable || (issued && !record)) {
    return { ok: false, refusal: "device-file", deviceId: "" };
  }
  const kind = classifyPresented(record, presented);
  const sharedRetired = Boolean(policy && policy.sharedRetired) || Boolean(record && record.shared === "retired");
  const sharedMatch = tokensMatch(sharedToken, presented);
  const ok = kind.active || (!sharedRetired && sharedMatch);
  let refusal = "";
  if (!ok && kind.revoked && !sharedMatch) refusal = "removed";
  else if (!ok && sharedMatch && sharedRetired) refusal = "retired";
  else if (!ok) refusal = "unknown";
  return { ok, refusal, deviceId: ok ? kind.deviceId : "" };
}

export function bearerToken(header) {
  const match = String(header || "").match(/^Bearer\s+(\S+)\s*$/i);
  return match ? match[1] : "";
}

// The apps store a lowercase UUID. Anything else, including ".." , is not a storage id.
const STORAGE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MARKER_HEADER = "aidanos-relay-folder v2";
const MARKER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DOC_MESSAGE = new Set(["sync", "request", "doc-unavailable"]);

export function tokenWithoutTrailingNewline(raw) {
  let token = String(raw ?? "");
  if (token.endsWith("\r\n")) token = token.slice(0, -2);
  else if (token.endsWith("\n") || token.endsWith("\r")) token = token.slice(0, -1);
  if (/\s/.test(token)) {
    throw new Error(
      "The relay token must not contain spaces or other whitespace. Generate one with openssl rand -base64 32 and store it in the token file.",
    );
  }
  return token;
}

// A single repeated character, or a handful of characters copied over and
// over, is not a key. Eight different characters is the floor. The check
// does not print the key.
export function requireRandomToken(token) {
  const seen = new Set();
  for (const char of String(token)) {
    seen.add(char);
    if (seen.size >= 8) return;
  }
  throw new Error(
    "The relay token must be at least 32 random characters. A repeated or low-variety token is refused.",
  );
}

export function payloadLimit(value) {
  if (value == null || value === "") return MAX_PAYLOAD;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return MAX_PAYLOAD;
  return n;
}

function asFrame(value) {
  if (value == null) return null;
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  if (ArrayBuffer.isView(value)) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  if (typeof value === "string") return Buffer.from(value);
  return null;
}

// Close unless a storage id is a UUID and every document id is one Automerge accepts.
// The disk adapter joins both into a path and does not check them.
export function syncFrameAllowed(value) {
  const raw = asFrame(value);
  if (!raw || raw.length === 0) return false;
  let message;
  try {
    message = decode(raw);
  } catch {
    return false;
  }
  if (!message || typeof message !== "object") return false;
  const type = typeof message.type === "string" ? message.type : "";
  const meta = message.peerMetadata;
  const storageId = meta && typeof meta === "object" ? meta.storageId : message.storageId;
  if (type === "join" || storageId !== undefined) {
    if (typeof storageId !== "string" || !STORAGE_ID.test(storageId)) return false;
  }
  if (DOC_MESSAGE.has(type) || message.documentId !== undefined) {
    if (!isValidDocumentId(message.documentId)) return false;
  }
  return true;
}

function rejectUpgrade(socket) {
  const body = "unauthorized";
  socket.write(
    "HTTP/1.1 401 Unauthorized\r\n" +
      "Content-Type: text/plain\r\n" +
      "Content-Length: " +
      Buffer.byteLength(body) +
      "\r\n" +
      "Connection: close\r\n\r\n" +
      body,
  );
  socket.destroy();
}

function health(gitState, bootedAt, syncUp) {
  return JSON.stringify({
    ok: syncUp,
    status: syncUp ? "ok" : "sync down",
    git: gitState.status === "ok",
    gitStatus: gitState.status,
    bootedAt,
  });
}

function takeDeviceName(argv, index) {
  const name = argv[index + 1];
  if (!name || name.startsWith("--")) {
    throw new Error("Name the device, for example Mac or iPhone.");
  }
  return name;
}

export function parseArgs(argv) {
  const out = {
    lan: false,
    lanAddress: "",
    vault: "",
    data: "",
    port: null,
    behindProxy: false,
    allowSharedKeyBehindProxy: false,
    initDevices: false,
    printKeyAnyway: false,
    deviceCommand: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--lan") out.lan = true;
    else if (arg === "--behind-proxy") out.behindProxy = true;
    else if (arg === "--allow-shared-key-behind-proxy") out.allowSharedKeyBehindProxy = true;
    else if (arg === "--init-devices") out.initDevices = true;
    else if (arg === "--print-key-anyway") out.printKeyAnyway = true;
    else if (arg === "--token") {
      throw new Error(
        "The token is not read from the command line. Set AIDANOS_RELAY_TOKEN or AIDANOS_RELAY_TOKEN_FILE.",
      );
    } else if (arg === "--issue-device" || arg === "--revoke-device") {
      if (out.deviceCommand) throw new Error("Use one device command at a time.");
      out.deviceCommand = { action: arg, name: takeDeviceName(argv, i) };
      i += 1;
    } else if (
      arg === "--list-devices" ||
      arg === "--retire-shared-key" ||
      arg === "--restore-shared-key" ||
      arg === "--reenable-shared-key" ||
      arg === "--restore-device-file"
    ) {
      if (out.deviceCommand) throw new Error("Use one device command at a time.");
      out.deviceCommand = { action: arg, name: "" };
    } else if (arg === "--lan-address") out.lanAddress = argv[(i += 1)] || "";
    else if (arg === "--vault") out.vault = argv[(i += 1)] || "";
    else if (arg === "--data") out.data = argv[(i += 1)] || "";
    else if (arg === "--port") out.port = Number(argv[(i += 1)]);
    else throw new Error("Unknown argument " + arg);
  }
  return out;
}

export async function loadToken(env = process.env) {
  const fromEnv = env.AIDANOS_RELAY_TOKEN == null ? "" : String(env.AIDANOS_RELAY_TOKEN);
  const file = String(env.AIDANOS_RELAY_TOKEN_FILE || "").trim();
  if (fromEnv && file) {
    throw new Error("Set only one of AIDANOS_RELAY_TOKEN and AIDANOS_RELAY_TOKEN_FILE.");
  }
  let token = fromEnv ? tokenWithoutTrailingNewline(fromEnv) : "";
  if (file) {
    const stat = await fs.stat(file);
    if ((stat.mode & 0o777) !== 0o600) {
      throw new Error("The token file must be readable only by you (mode 0600).");
    }
    token = tokenWithoutTrailingNewline(await fs.readFile(file, "utf8"));
  }
  if (!token) {
    throw new Error("Set AIDANOS_RELAY_TOKEN or AIDANOS_RELAY_TOKEN_FILE. The relay will not start without one.");
  }
  if (token.length < MIN_TOKEN_LENGTH) {
    throw new Error("The relay token must be at least 32 characters.");
  }
  requireRandomToken(token);
  return token;
}

export function nodeRequirement(version = process.versions.node) {
  const major = Number(String(version).split(".")[0]);
  if (Number.isFinite(major) && major >= 22) return "";
  return "Node 22 or newer is needed.";
}

export function startupLines({ lan, port, phone, behindProxy }) {
  const lines = ["LISTENING 127.0.0.1 " + port];
  if (behindProxy) {
    lines.push(
      "HOSTED 127.0.0.1 " +
        port +
        ". A TLS proxy on this machine may forward here. The relay is not on the public internet.",
    );
  }
  if (lan) lines.push(LAN_WARNING);
  if (phone) lines.push("PHONE ws://" + phone + ":" + port);
  return lines;
}

function resolveHome(options, env) {
  const vaultArg = options.vault || env.AIDANOS_RELAY_VAULT || "";
  if (!String(vaultArg).trim()) {
    throw new Error(
      "Set --vault or AIDANOS_RELAY_VAULT. The relay will not use AIDANOS_VAULT or another app's folder.",
    );
  }
  const vault = path.resolve(String(vaultArg));
  const dataDir = path.resolve(options.data || env.AIDANOS_RELAY_DATA || path.join(vault, ".aidanos", "relay"));
  return { vault, dataDir };
}

function isInsideDirectory(parent, child) {
  const root = path.resolve(parent);
  const target = path.resolve(child);
  if (root === target) return true;
  const prefix = root.endsWith(path.sep) ? root : root + path.sep;
  return target.startsWith(prefix);
}

function keepsInside(directory, kept) {
  const resolved = path.resolve(directory);
  for (const item of kept) {
    if (item === resolved || isInsideDirectory(resolved, item)) return true;
  }
  return false;
}

async function emptyDirectory(dir, keep = []) {
  // One name at a time. A parallel delete races a mirror rename and macOS
  // then returns ENOTEMPTY for the directory. A missing directory is already empty:
  // wiping the notes folder also removes a data folder that lives inside it.
  // Kept paths are absolute files inside the relay data folder. A notes file
  // with the same name, sitting in the vault, is still deleted.
  const kept = new Set(keep.map((item) => path.resolve(item)));
  async function removeTree(current) {
    let names;
    try {
      names = await fs.readdir(current);
    } catch (error) {
      if (error && error.code === "ENOENT") return;
      throw error;
    }
    for (const name of names) {
      const full = path.join(current, name);
      const resolved = path.resolve(full);
      if (kept.has(resolved)) continue;
      let info;
      try {
        info = await fs.lstat(full);
      } catch (error) {
        if (error && error.code === "ENOENT") continue;
        throw error;
      }
      if (info.isSymbolicLink() || !info.isDirectory()) {
        await fs.rm(full, { force: true, maxRetries: 8, retryDelay: 25 });
        continue;
      }
      if (keepsInside(full, kept)) {
        await removeTree(full);
        try {
          await fs.rmdir(full);
        } catch (error) {
          if (error && (error.code === "ENOTEMPTY" || error.code === "ENOENT" || error.code === "EEXIST")) continue;
          throw error;
        }
        continue;
      }
      await fs.rm(full, { recursive: true, force: true, maxRetries: 8, retryDelay: 25 });
    }
  }
  await removeTree(dir);
}

// Create only. O_EXCL refuses an existing path, and O_NOFOLLOW refuses a symlink,
// so a marker cannot replace another file by pointing at it.
const MARKER_CREATE_FLAGS =
  fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | (fsConstants.O_NOFOLLOW || 0);
const MARKER_READ_FLAGS = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0);

async function readMarker(file) {
  let info;
  try {
    info = await fs.lstat(file);
  } catch (error) {
    if (error && error.code === "ENOENT") return null;
    throw error;
  }
  if (info.isSymbolicLink() || !info.isFile()) return null;
  let handle;
  try {
    handle = await fs.open(file, MARKER_READ_FLAGS);
  } catch (error) {
    if (error && (error.code === "ENOENT" || error.code === "ELOOP")) return null;
    throw error;
  }
  try {
    return await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
}

async function writeMarkerFile(file, text) {
  let handle;
  try {
    handle = await fs.open(file, MARKER_CREATE_FLAGS, 0o600);
  } catch (error) {
    if (!error || (error.code !== "EEXIST" && error.code !== "ELOOP")) throw error;
    const info = await fs.lstat(file);
    if (info.isSymbolicLink()) {
      throw new Error("The relay marker is a symlink and will not be followed.");
    }
    if (!info.isFile()) {
      throw new Error("The relay marker already exists and is not a regular file.");
    }
    const current = await readMarker(file);
    if (current === text) return;
    throw new Error("The relay marker already exists and does not match this relay.");
  }
  try {
    await handle.writeFile(text);
  } finally {
    await handle.close();
  }
}

async function replaceRegularFile(file, text) {
  const info = await fs.lstat(file);
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new Error("The relay marker is a symlink and will not be followed.");
  }
  const tmp = path.join(path.dirname(file), ".relay-id-" + randomUUID() + ".tmp");
  let handle;
  try {
    handle = await fs.open(tmp, MARKER_CREATE_FLAGS, 0o600);
  } catch {
    throw new Error("The relay marker could not be saved.");
  }
  try {
    await handle.writeFile(text);
    await handle.sync();
  } catch {
    await handle.close().catch(() => {});
    await fs.rm(tmp, { force: true });
    throw new Error("The relay marker could not be saved.");
  }
  await handle.close();
  try {
    await fs.rename(tmp, file);
  } catch {
    await fs.rm(tmp, { force: true });
    throw new Error("The relay marker could not be saved.");
  }
  await fs.chmod(file, 0o600);
}

function markerFiles(vault, dataDir) {
  return [relayIdFile(vault), path.join(vault, ".aidanos", "relay-folder"), path.join(dataDir, "relay-folder")];
}

async function readMarkerSet(vault, dataDir) {
  const texts = [];
  for (const file of markerFiles(vault, dataDir)) texts.push(await readMarker(file));
  return texts;
}

async function writeKeysIssuedRecord(vault, dataDir, issued) {
  const files = markerFiles(vault, dataDir);
  const current = [];
  let id = "";
  for (const file of files) {
    const text = await readMarker(file);
    current.push(text);
    if (!id) id = relayMarkerId(text || "");
  }
  if (!id) return;
  const line = issued ? "keys-issued yes" : "keys-issued no";
  const next = MARKER_HEADER + "\n" + id + "\n" + line + "\n";
  for (let i = 0; i < files.length; i += 1) {
    if (current[i] === next) continue;
    await replaceRegularFile(files[i], next);
  }
}

function markerTextForReset(id, texts) {
  const anyYes = texts.some((text) => relayMarkerKeysIssued(text || ""));
  if (anyYes) return MARKER_HEADER + "\n" + id + "\nkeys-issued yes\n";
  const anyNo = texts.some((text) => {
    if (typeof text !== "string") return false;
    const lines = text.split("\n");
    return lines.length === 4 && lines[2] === "keys-issued no" && lines[3] === "";
  });
  if (anyNo) return MARKER_HEADER + "\n" + id + "\nkeys-issued no\n";
  return relayMarkerText(id);
}

async function directoryHasGitRemote(dir) {
  try {
    const text = await fs.readFile(path.join(dir, ".git", "config"), "utf8");
    return /\[remote\s+"/.test(text);
  } catch (error) {
    if (error && error.code === "ENOENT") return false;
    throw error;
  }
}

async function describeForeign(dir) {
  const notes = [];
  let gitRemote = false;
  let other = false;
  async function walk(current) {
    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.name === ".git" && entry.isDirectory()) {
        gitRemote = (await directoryHasGitRemote(dir)) || gitRemote;
        other = true;
        continue;
      }
      if (entry.isDirectory()) {
        if (entry.name === "log") {
          const inner = await fs.readdir(full);
          if (inner.length > 0) notes.push("log/");
          else other = true;
        } else {
          await walk(full);
        }
        continue;
      }
      if (entry.name.endsWith(".md") || entry.name.endsWith(".txt")) notes.push(path.relative(dir, full));
      else other = true;
    }
  }
  const names = await fs.readdir(dir);
  if (names.length === 0) return { empty: true, notes, gitRemote, other };
  await walk(dir);
  return { empty: false, notes, gitRemote, other };
}

function foreignFolderError(found) {
  const parts = ["This folder is not the relay's own folder."];
  if (found.notes.length) {
    parts.push("It contains notes (" + found.notes.slice(0, 3).join(", ") + ").");
  }
  if (found.gitRemote) parts.push("It has a git remote.");
  if (!found.notes.length && !found.gitRemote) {
    parts.push("It already has files, and it has no relay marker.");
  }
  parts.push("Pass an empty folder, or the folder the relay marked earlier.");
  return parts.join(" ");
}

// v2 is a header the old relay never wrote, plus an id. The same id is in the
// vault, the data folder, and a file next to the vault. An old "relay" marker
// does not match. A folder that has any files and no matching id is refused.
export function relayMarkerText(id) {
  return MARKER_HEADER + "\n" + id + "\n";
}

export function relayMarkerId(text) {
  if (typeof text !== "string") return "";
  const lines = text.split("\n");
  if (lines[lines.length - 1] !== "") return "";
  if (lines[0] !== MARKER_HEADER || !MARKER_ID.test(lines[1])) return "";
  if (lines.length === 3) return lines[1];
  if (lines.length === 4 && (lines[2] === "keys-issued yes" || lines[2] === "keys-issued no")) return lines[1];
  return "";
}

export function relayMarkerKeysIssued(text) {
  if (typeof text !== "string") return false;
  const lines = text.split("\n");
  return lines.length === 4 && lines[2] === "keys-issued yes" && lines[3] === "";
}

// Once any marker says keys were issued, a sibling that has gone back to the
// old three-line form is not accepted. A fresh install, where every marker is
// still three lines, is left alone.
export function relayMarkerMissingIssuedLine(texts) {
  const list = Array.isArray(texts) ? texts : [];
  const anyYes = list.some((text) => relayMarkerKeysIssued(text || ""));
  if (!anyYes) return false;
  return list.some((text) => {
    const body = typeof text === "string" ? text : "";
    if (!relayMarkerId(body)) return true;
    return body.split("\n").length === 3;
  });
}

export function relayIdFile(vault) {
  const resolved = path.resolve(vault);
  return path.join(path.dirname(resolved), "." + path.basename(resolved) + ".aidanos-relay-id");
}

async function hasAnyEntry(dir) {
  try {
    const names = await fs.readdir(dir);
    return names.length > 0;
  } catch (error) {
    if (error && error.code === "ENOENT") return false;
    throw error;
  }
}

async function claimRelayFolders(vault, dataDir) {
  for (const dir of [vault, dataDir]) {
    try {
      const stat = await fs.stat(dir);
      if (!stat.isDirectory()) throw new Error("The relay folder has to be a directory.");
    } catch (error) {
      if (!error || error.code !== "ENOENT") throw error;
    }
  }
  const vaultMarker = path.join(vault, ".aidanos", "relay-folder");
  const dataMarker = path.join(dataDir, "relay-folder");
  const outside = relayIdFile(vault);
  const vaultId = relayMarkerId(await readMarker(vaultMarker));
  const dataId = relayMarkerId(await readMarker(dataMarker));
  const outsideId = relayMarkerId(await readMarker(outside));
  if (vaultId && vaultId === dataId && vaultId === outsideId) return vaultId;
  if ((await hasAnyEntry(vault)) || (await hasAnyEntry(dataDir))) {
    const found = await describeForeign((await hasAnyEntry(vault)) ? vault : dataDir);
    throw new Error(foreignFolderError(found));
  }
  const id = randomUUID();
  const text = relayMarkerText(id);
  // The id file sits beside the notes folder. Write it before the folder so a
  // symlink there is refused without leaving a half-written marker inside.
  await writeMarkerFile(outside, text);
  await fs.mkdir(path.dirname(vaultMarker), { recursive: true });
  await fs.mkdir(dataDir, { recursive: true });
  await writeMarkerFile(vaultMarker, text);
  await writeMarkerFile(dataMarker, text);
  return id;
}

async function ownedMarkerId(vault, dataDir) {
  const vaultId = relayMarkerId(await readMarker(path.join(vault, ".aidanos", "relay-folder")));
  const dataId = relayMarkerId(await readMarker(path.join(dataDir, "relay-folder")));
  const outsideId = relayMarkerId(await readMarker(relayIdFile(vault)));
  if (!vaultId || vaultId !== dataId || vaultId !== outsideId) return "";
  return vaultId;
}

async function assertNotClientVault(vault) {
  for (const name of CLIENT_MARKERS) {
    try {
      await fs.stat(path.join(vault, ".aidanos", name));
    } catch (error) {
      if (error && error.code === "ENOENT") continue;
      throw error;
    }
    throw new Error(
      "This folder is an app vault (it has .aidanos/" +
        name +
        "). The relay keeps its own folder and will not use the app's folder.",
    );
  }
}

function listen(server, host, port) {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      const address = server.address();
      resolve(typeof address === "object" && address ? address.port : port);
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
}

export async function startRelay(options = {}) {
  const env = options.env || process.env;
  const token =
    options.token != null && String(options.token) !== ""
      ? tokenWithoutTrailingNewline(options.token)
      : await loadToken(env);
  if (token.length < MIN_TOKEN_LENGTH) {
    throw new Error("The relay token must be at least 32 characters.");
  }
  requireRandomToken(token);
  const behindProxy = Boolean(options.behindProxy) || String(env.AIDANOS_RELAY_BEHIND_PROXY || "") === "1";
  if (behindProxy && (options.lan || options.lanAddress)) {
    throw new Error("A hosted relay listens on 127.0.0.1 only. Do not use --lan with --behind-proxy.");
  }
  const { vault, dataDir } = resolveHome(options, env);
  const port = options.port == null ? portFromEnv(env) : Number(options.port);
  const { hosts, phone } = listenHosts({
    lan: behindProxy ? false : Boolean(options.lan) || Boolean(options.lanAddress),
    interfaces: options.interfaces,
    choose: behindProxy ? "" : options.lanAddress || "",
  });
  const gitUrl = String(options.gitUrl ?? env.AIDANOS_RELAY_GIT_URL ?? "").trim();
  const gitToken = String(options.gitToken ?? env.AIDANOS_RELAY_GIT_TOKEN ?? "").trim();
  const secrets = [token, gitToken, gitUrl].filter(Boolean);
  await assertNotClientVault(vault);
  await claimRelayFolders(vault, dataDir);
  const opened = await reconcileDeviceState(dataDir);
  const markerTexts = await readMarkerSet(vault, dataDir);
  if (relayMarkerMissingIssuedLine(markerTexts)) {
    throw new Error("The relay id file is missing the keys-issued line. The relay will not start.");
  }
  const filesMissing = !opened.record && opened.policy && !opened.policy.exists;
  const recordedKeys = markerTexts.some((text) => relayMarkerKeysIssued(text || ""));
  if (recordedKeys && filesMissing && !options.initDevices) {
    throw new Error(
      "Device keys were issued, but the device files are missing. The relay will not start. Pass --init-devices to start again on purpose.",
    );
  }
  const sharedStillOn = !(opened.policy.sharedRetired || (opened.record && opened.record.shared === "retired"));
  if (behindProxy && sharedStillOn && !options.allowSharedKeyBehindProxy) {
    throw new Error(
      "A hosted relay will not start while the shared key can open a connection. Retire the shared key, or pass --allow-shared-key-behind-proxy.",
    );
  }
  if (recordedKeys && filesMissing && options.initDevices) {
    await writeKeysIssuedRecord(vault, dataDir, false);
    logSafe(secrets, "cleared the keys-issued record because --init-devices was passed and the device files are missing");
  }
  if (sharedStillOn) logSafe(secrets, "WARNING: the shared key can still open a connection");
  else logSafe(secrets, "the shared key is off");
  let stickyKeysIssued = Boolean(
    opened.policy.devicesIssued || (opened.record && opened.record.devices.length > 0),
  );
  let stickySharedRetired = Boolean(
    opened.policy.sharedRetired || (opened.record && opened.record.shared === "retired"),
  );
  if (stickyKeysIssued) {
    try {
      await writeKeysIssuedRecord(vault, dataDir, true);
    } catch (error) {
      logSafe(secrets, "could not record that device keys were issued:", error instanceof Error ? error.message : "error");
    }
  }
  let loggedDisappeared = false;
  let loggedSharedBack = false;
  let loggedSharedBlocked = false;
  const guessLimit = Number(options.guessLimit ?? 5);
  const guessBlockMs = Number(options.guessBlockMs ?? 60_000);
  const failures = new Map();
  const gitState = { status: gitUrl ? "pending" : "off" };

  function clientAddress(req) {
    return (req.socket && req.socket.remoteAddress) || "";
  }

  function pruneFailures(now) {
    for (const [ip, row] of failures) {
      const blockOver = row.until && now >= row.until;
      const attemptStale = !row.until && row.at && now - row.at >= guessBlockMs;
      if (blockOver || attemptStale) failures.delete(ip);
    }
    while (failures.size > FAILURE_CAP) {
      const oldest = failures.keys().next().value;
      if (oldest == null) break;
      failures.delete(oldest);
    }
  }

  function blocked(ip) {
    pruneFailures(Date.now());
    const row = failures.get(ip);
    return Boolean(row && row.until && Date.now() < row.until);
  }

  function noteFailure(ip) {
    const now = Date.now();
    pruneFailures(now);
    const row = failures.get(ip) || { count: 0, until: 0, at: now };
    failures.delete(ip);
    row.count += 1;
    row.at = now;
    if (row.count >= guessLimit) row.until = now + guessBlockMs;
    failures.set(ip, row);
  }

  // Once this process has seen device keys, or a retired shared key, forgetting
  // the files must not turn the shared key back on. An explicit policy that
  // says the shared key is on is the only way it returns before a restart.
  async function gateState(state) {
    if (!state.unreadable) {
      const issued = Boolean(
        (state.policy && state.policy.devicesIssued) || (state.record && state.record.devices.length > 0),
      );
      const retired = Boolean(
        (state.policy && state.policy.sharedRetired) || (state.record && state.record.shared === "retired"),
      );
      if (issued) {
        if (!stickyKeysIssued) {
          stickyKeysIssued = true;
          try {
            await writeKeysIssuedRecord(vault, dataDir, true);
          } catch (error) {
            logSafe(
              secrets,
              "could not record that device keys were issued:",
              error instanceof Error ? error.message : "error",
            );
          }
        }
      }
      if (retired) stickySharedRetired = true;
      const explicitOn =
        state.policy &&
        state.policy.exists &&
        !state.policy.sharedRetired &&
        !(state.record && state.record.shared === "retired") &&
        !(state.policy.devicesIssued && !state.record);
      if (explicitOn && stickySharedRetired) {
        if (behindProxy && !options.allowSharedKeyBehindProxy) {
          if (!loggedSharedBlocked) {
            loggedSharedBlocked = true;
            logSafe(secrets, "refusing to turn the shared key back on because this relay is behind a proxy");
          }
        } else {
          stickySharedRetired = false;
          if (!loggedSharedBack) {
            loggedSharedBack = true;
            logSafe(secrets, "the shared key can open a connection again");
          }
        }
      }
    }
    const bothGone = !state.unreadable && state.policy && !state.policy.exists && !state.record;
    if ((stickyKeysIssued || stickySharedRetired) && bothGone) {
      if (!loggedDisappeared) {
        loggedDisappeared = true;
        logSafe(secrets, "refusing the shared key because the device files disappeared");
      }
      return {
        policy: { exists: false, devicesIssued: true, sharedRetired: true },
        record: null,
        unreadable: true,
      };
    }
    if (stickySharedRetired && state.policy) {
      return {
        ...state,
        policy: {
          ...state.policy,
          sharedRetired: true,
          devicesIssued: state.policy.devicesIssued || stickyKeysIssued,
        },
      };
    }
    return state;
  }

  // Read the device file on every attempt. Behind a proxy every client is
  // 127.0.0.1, so the per-address lockout is off and the proxy does that job.
  // X-Forwarded-For is not read.
  async function allowPresented(presented, ip) {
    if (!behindProxy && blocked(ip)) return { ok: false, refusal: "locked", deviceId: "" };
    let state;
    try {
      state = await readDeviceState(dataDir);
    } catch {
      return { ok: false, refusal: "device-file", deviceId: "" };
    }
    state = await gateState(state);
    const decision = connectionAllowed({
      sharedToken: token,
      record: state.record,
      presented,
      policy: state.policy,
      unreadable: state.unreadable,
    });
    if (!decision.ok) {
      if (!behindProxy && decision.refusal !== "device-file") noteFailure(ip);
      return decision;
    }
    if (!behindProxy) failures.delete(ip);
    return decision;
  }

  function noteGit(result) {
    if (!result) return;
    if (result.pushed) gitState.status = "ok";
    else if (result.committed && result.pushed === false) gitState.status = "failed";
  }

  let bootedAt = new Date().toISOString();
  const allowReset = options.allowReset === true;
  const servers = [];
  let live = null;
  let resetChain = Promise.resolve();
  let api = null;

  async function openSession() {
    const adapters = [];
    for (const entry of servers) {
      adapters.push(new NodeWSServerAdapter(entry.wss));
    }
    const repo = new Repo({
      storage: new NodeFSStorageAdapter(dataDir),
      network: adapters,
      sharePolicy: async () => true,
      peerId: options.peerId || "aidanos-relay",
    });
    const debounce = Number(options.mirrorDebounceMs ?? process.env.AIDANOS_MIRROR_DEBOUNCE_MS);
    const mirror = createMirror({
      repo,
      vault,
      debounceMs: Number.isFinite(debounce) && debounce >= 0 ? debounce : 400,
      secrets,
    });
    // Fold a file that changed while this process was stopped before any device
    // can connect. Doing it later lets that device's offline edit arrive first,
    // and the file then replaces it.
    await preloadStoredNotes(repo);
    await mirror.now();
    // The socket listener is attached only after the storage id is read.
    // The port stays closed until that has finished, or the first join is missed.
    await repo.networkSubsystem.peerMetadata;
    for (const adapter of adapters) {
      if (!adapter.peerId) throw new Error("The sync engine was not ready.");
    }
    return { repo, mirror, adapters };
  }

  async function disposeSession(session) {
    if (!session) return;
    session.mirror.stop();
    for (const entry of servers) {
      for (const ws of [...entry.wss.clients]) ws.terminate();
      // The adapter clears its ping timer on "close". Emitting it here does not
      // mark the socket server shut, so the next test can still connect.
      entry.wss.emit("close");
      entry.wss.removeAllListeners();
    }
    // The folder is about to be deleted, so do not flush or write it again.
    // Wait only for a rename that has already started.
    await session.mirror.idle();
    try {
      session.repo.networkSubsystem.disconnect();
    } catch {
      // The adapter is already detached from the socket server.
    }
    try {
      await session.repo.storageSubsystem?.close();
    } catch {
      // Closing storage is best effort. The directory is removed next.
    }
  }

  async function rotate() {
    const markerId = await ownedMarkerId(vault, dataDir);
    if (!markerId) {
      logSafe(secrets, "reset refused: the folder has no current relay marker");
      return;
    }
    // Device fingerprints and the policy marker stay on disk. The reset does
    // not delete them and does not write them back, so a crash cannot drop
    // them and a removal during the reset is not undone.
    const markerTexts = await readMarkerSet(vault, dataDir);
    await disposeSession(live);
    live = null;
    let lastError;
    const marker = markerTextForReset(markerId, markerTexts);
    const dataInsideVault = isInsideDirectory(vault, dataDir);
    const keep = preservedDevicePaths(dataDir);
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        await withDeviceLock(dataDir, async () => {
          await emptyDirectory(vault, dataInsideVault ? keep : []);
          // The default data folder is vault/.aidanos/relay. Emptying the notes
          // folder already walked it. A data folder outside the notes is emptied
          // on its own, still leaving the device files in place.
          if (!dataInsideVault) await emptyDirectory(dataDir, keep);
          await fs.mkdir(path.join(vault, ".aidanos"), { recursive: true });
          await fs.mkdir(dataDir, { recursive: true });
          await writeMarkerFile(path.join(vault, ".aidanos", "relay-folder"), marker);
          await writeMarkerFile(path.join(dataDir, "relay-folder"), marker);
        });
        if (typeof options.beforeReopen === "function") await options.beforeReopen();
        live = await openSession();
        bootedAt = new Date().toISOString();
        if (api) api.repo = live.repo;
        logSafe(secrets, "reset complete");
        if (typeof options.onReset === "function") options.onReset();
        return;
      } catch (error) {
        lastError = error;
        logSafe(secrets, "reset attempt failed:", error instanceof Error ? error.message : error);
      }
    }
    throw lastError;
  }

  function scheduleReset() {
    resetChain = resetChain.then(rotate).catch((error) => {
      logSafe(secrets, "reset failed:", error instanceof Error ? error.message : error);
    });
  }

  for (const host of hosts) {
    const httpServer = http.createServer((req, res) => {
      const pathOnly = String(req.url || "").split("?")[0];
      if (pathOnly === "/health") {
        const syncUp = live != null;
        const body = health(gitState, bootedAt, syncUp);
        res.writeHead(syncUp ? 200 : 503, {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
          "cache-control": "no-store",
        });
        res.end(body);
        return;
      }
      if (req.method === "POST" && pathOnly === "/reset") {
        if (!allowReset) {
          res.writeHead(404, { "content-length": 0 });
          res.end();
          return;
        }
        const ip = clientAddress(req);
        const presented = bearerToken(req.headers.authorization);
        allowPresented(presented, ip)
          .then((decision) => {
            if (res.writableEnded) return undefined;
            if (!decision.ok) {
              const listed = String(presented || "").length >= MIN_TOKEN_LENGTH ? secrets.concat(presented) : secrets;
              logSafe(listed, "rejected a reset reason=" + (decision.refusal || "unknown"));
              res.writeHead(401, { "content-length": 0 });
              res.end();
              return undefined;
            }
            return ownedMarkerId(vault, dataDir);
          })
          .then((markerId) => {
            if (markerId === undefined || res.writableEnded) return;
            if (!markerId) {
              const refused = "reset refused";
              res.writeHead(409, {
                "content-type": "text/plain",
                "content-length": Buffer.byteLength(refused),
                "cache-control": "no-store",
              });
              res.end(refused);
              return;
            }
            const body = JSON.stringify({ ok: true, resetting: true });
            res.writeHead(200, {
              "content-type": "application/json",
              "content-length": Buffer.byteLength(body),
              "cache-control": "no-store",
            });
            res.end(body);
            logSafe(secrets, "resetting");
            // The iOS simulator shares this process. Empty the folder here instead
            // of exiting: starting Node again while the simulator is up takes
            // longer than the tests will wait. Off unless allowReset is set.
            scheduleReset();
          })
          .catch((error) => {
            logSafe(secrets, "reset failed:", error instanceof Error ? error.message : error);
            if (!res.headersSent) {
              res.writeHead(500, { "content-length": 0 });
              res.end();
            }
          });
        return;
      }
      res.writeHead(404, { "content-length": 0 });
      res.end();
    });
    const rawCap = options.maxPayload != null ? options.maxPayload : env.AIDANOS_MAX_PAYLOAD;
    const cap = payloadLimit(rawCap);
    const wss = new WebSocketServer({ noServer: true, maxPayload: cap });
    const entry = { httpServer, host, wss };
    httpServer.on("upgrade", (req, socket, head) => {
      if (!live) {
        socket.destroy();
        return;
      }
      const ip = clientAddress(req);
      const presented = bearerToken(req.headers.authorization);
      allowPresented(presented, ip)
        .then((decision) => {
          if (!decision.ok) {
            const listed = String(presented || "").length >= MIN_TOKEN_LENGTH ? secrets.concat(presented) : secrets;
            logSafe(listed, "rejected a sync connection reason=" + (decision.refusal || "unknown"));
            rejectUpgrade(socket);
            return;
          }
          entry.wss.handleUpgrade(req, socket, head, (ws) => {
            ws.aidanosAuth = decision.deviceId ? "device" : "shared";
            ws.aidanosDeviceId = decision.deviceId || "";
            const addListener = ws.addListener.bind(ws);
            let rejectedFrame = false;
            function listen(event, handler) {
              if (event !== "message" || typeof handler !== "function") return addListener(event, handler);
              return addListener(event, function guarded(data, ...rest) {
                let allowedFrame = false;
                try {
                  allowedFrame = syncFrameAllowed(data);
                } catch {
                  allowedFrame = false;
                }
                if (!allowedFrame) {
                  if (!rejectedFrame) {
                    rejectedFrame = true;
                    logSafe(secrets, "closed a sync connection");
                    ws.terminate();
                  }
                  return;
                }
                return handler.call(this, data, ...rest);
              });
            }
            ws.on = listen;
            ws.addListener = listen;
            ws.on("error", (error) => {
              logSafe(secrets, "sync connection closed:", error instanceof Error ? error.message : error);
            });
            ws.on("message", (data) => {
              logSyncFrame("in", data, secrets);
            });
            const send = ws.send;
            ws.send = function sendLogged(...args) {
              logSyncFrame("out", args[0], secrets);
              return send.apply(ws, args);
            };
            const who = decision.deviceId ? "device=" + decision.deviceId : "shared-key";
            logSafe(secrets, "accepted a sync connection " + who);
            entry.wss.emit("connection", ws, req);
          });
        })
        .catch(() => {
          logSafe(secrets, "rejected a sync connection reason=unknown");
          try {
            rejectUpgrade(socket);
          } catch {
            socket.destroy();
          }
        });
    });
    servers.push(entry);
  }

  live = await openSession();

  let boundPort = port;
  for (const entry of servers) {
    boundPort = await listen(entry.httpServer, entry.host, port);
  }

  const interval = gitInterval(options.gitIntervalMs, env);
  let gitTimer = null;
  async function runBackup() {
    try {
      const result = await backupOnce({ vault, gitUrl, gitToken, secrets, env });
      noteGit(result);
      return result;
    } catch (error) {
      gitState.status = "failed";
      throw error;
    }
  }

  if (gitUrl && interval > 0) {
    gitTimer = setInterval(() => {
      runBackup().catch((error) => {
        logSafe(secrets, "git backup failed:", error instanceof Error ? error.message : error);
      });
    }, interval);
    if (gitTimer.unref) gitTimer.unref();
  }

  let deviceFileWarned = false;
  function closeForDeviceFile() {
    for (const entry of servers) {
      for (const ws of [...entry.wss.clients]) ws.terminate();
    }
    if (!deviceFileWarned) {
      deviceFileWarned = true;
      logSafe(secrets, "closing sync connections reason=device-file");
    }
  }

  async function sweepDevices() {
    let state;
    try {
      state = await readDeviceState(dataDir);
    } catch {
      closeForDeviceFile();
      return;
    }
    state = await gateState(state);
    if (state.unreadable || (state.policy.devicesIssued && !state.record)) {
      closeForDeviceFile();
      return;
    }
    deviceFileWarned = false;
    const record = state.record;
    const sharedRetired = Boolean(state.policy.sharedRetired) || Boolean(record && record.shared === "retired");
    const devices = record && Array.isArray(record.devices) ? record.devices : [];
    for (const entry of servers) {
      for (const ws of [...entry.wss.clients]) {
        if (ws.aidanosAuth === "device") {
          const id = String(ws.aidanosDeviceId || "");
          const row = devices.find((device) => device.id === id);
          if (!row || row.revokedAt) {
            logSafe(secrets, "closed a sync connection device=" + id);
            ws.terminate();
          }
        } else if (ws.aidanosAuth === "shared" && sharedRetired) {
          logSafe(secrets, "closed a sync connection reason=shared-key-retired");
          ws.terminate();
        }
      }
    }
  }

  const requestedPoll = Number(options.devicePollMs);
  const devicePollMs = Number.isFinite(requestedPoll) && requestedPoll > 0 ? requestedPoll : 2000;
  const deviceTimer = setInterval(() => {
    sweepDevices().catch((error) => {
      logSafe(secrets, "device check failed:", error instanceof Error ? error.message : error);
    });
  }, devicePollMs);
  if (deviceTimer.unref) deviceTimer.unref();

  api = {
    port: boundPort,
    url: "ws://" + "127.0.0.1:" + boundPort,
    phone: phone ? "ws://" + phone + ":" + boundPort : null,
    hosts,
    behindProxy,
    vault,
    repo: live.repo,
    token,
    async mirrorNow() {
      await live.mirror.now();
    },
    async backupNow() {
      return runBackup();
    },
    healthURL: "http://127.0.0.1:" + boundPort + "/health",
    async close() {
      await resetChain.catch(() => {});
      const session = live;
      live = null;
      if (session) session.mirror.stop();
      if (gitTimer) clearInterval(gitTimer);
      clearInterval(deviceTimer);
      for (const entry of servers) {
        for (const ws of [...entry.wss.clients]) ws.terminate();
        entry.wss.close();
        if (typeof entry.httpServer.closeAllConnections === "function") entry.httpServer.closeAllConnections();
      }
      await Promise.all(
        servers.map(
          (entry) =>
            new Promise((resolve) => {
              entry.httpServer.close(() => resolve());
            }),
        ),
      );
      // The websocket adapter clears its ping timer on "close". A client that
      // already went away can leave that timer running, which holds the
      // process open after the tests have finished.
      for (const entry of servers) entry.wss.emit("close");
      if (session && typeof session.repo.shutdown === "function") await session.repo.shutdown();
    },
  };
  return api;
}

async function preloadStoredNotes(repo) {
  const storage = repo.storageSubsystem;
  if (!storage || typeof storage.loadDoc !== "function") return;
  const index = await storage.loadDoc(INDEX_ID);
  if (!index) return;
  await repo.find(INDEX_ID);
  const paths = index.paths && typeof index.paths === "object" ? index.paths : {};
  for (const id of Object.values(paths)) {
    if (typeof id !== "string" || !id) continue;
    const stored = await storage.loadDoc(id);
    if (!stored) continue;
    await repo.find(id);
  }
}

function portFromEnv(env = process.env) {
  if (env.AIDANOS_RELAY_PORT == null || env.AIDANOS_RELAY_PORT === "") return DEFAULT_PORT;
  return Number(env.AIDANOS_RELAY_PORT);
}

function gitInterval(override, env = process.env) {
  if (override != null) return Number(override);
  const raw = env.AIDANOS_RELAY_GIT_INTERVAL_MS;
  if (raw == null || String(raw).trim() === "") return 300000;
  return Number(raw);
}

function redactList(token, key) {
  const list = [];
  if (token) list.push(token);
  if (key && String(key).length >= MIN_TOKEN_LENGTH) list.push(key);
  return list;
}

export async function runDeviceCommand(args, env = process.env) {
  const token = await loadToken(env);
  const { vault, dataDir } = resolveHome(args, env);
  await assertNotClientVault(vault);
  await claimRelayFolders(vault, dataDir);
  const markerTexts = await readMarkerSet(vault, dataDir);
  if (relayMarkerMissingIssuedLine(markerTexts)) {
    throw new Error("The relay id file is missing the keys-issued line. The relay will not start.");
  }
  const command = args.deviceCommand;
  if (!command) throw new Error("Name the device command.");
  if (command.action === "--list-devices" || command.action === "--issue-device") {
    const state = await readDeviceState(dataDir);
    const filesMissing = !state.unreadable && !state.record && state.policy && !state.policy.exists;
    const recordedKeys = markerTexts.some((text) => relayMarkerKeysIssued(text || ""));
    if (recordedKeys && filesMissing && !args.initDevices) {
      throw new Error(
        "Device keys were issued, but the device files are missing. The relay will not start. Pass --init-devices to start again on purpose.",
      );
    }
    if (recordedKeys && filesMissing && args.initDevices) {
      await writeKeysIssuedRecord(vault, dataDir, false);
      logSafe(
        redactList(token, ""),
        "cleared the keys-issued record because --init-devices was passed and the device files are missing",
      );
    }
  }
  if (command.action === "--list-devices") {
    const state = await readDeviceState(dataDir);
    if (state.unreadable || (state.policy.devicesIssued && !state.record)) {
      throw new Error("Device keys are in use, but the device file is missing or unreadable.");
    }
    const lines = deviceLines(state.record);
    if (state.policy.sharedRetired) lines[0] = "shared off";
    return { lines };
  }
  if (command.action === "--issue-device") {
    if (!args.stdoutIsTTY && !args.printKeyAnyway) {
      throw new Error(
        "Refusing to print a device key because stdout is not a terminal. Pass --print-key-anyway to print it.",
      );
    }
    const issued = await issueDevice(dataDir, command.name);
    try {
      await writeKeysIssuedRecord(vault, dataDir, true);
    } catch (error) {
      logSafe(redactList(token, issued.key), "could not record that device keys were issued:", error instanceof Error ? error.message : "error");
    }
    return { announcement: issued.announcement, key: issued.key, id: issued.id, token };
  }
  if (command.action === "--revoke-device") {
    const ids = await revokeDevice(dataDir, command.name);
    return { message: "removed a device key device=" + ids.join(","), token };
  }
  if (command.action === "--retire-shared-key") {
    await retireSharedKey(dataDir);
    return {
      message: "The shared key will no longer open a connection. The key file was not changed.",
      token,
    };
  }
  if (command.action === "--restore-shared-key") {
    await restoreSharedKey(dataDir);
    return { message: "The shared key can open a connection again.", token };
  }
  if (command.action === "--reenable-shared-key") {
    const message = await reenableSharedKey(dataDir);
    return { message, token };
  }
  if (command.action === "--restore-device-file") {
    await restoreDeviceFile(dataDir);
    return { message: "Restored the device file from the last good copy.", token };
  }
  throw new Error("Name the device command.");
}

async function main() {
  const needed = nodeRequirement();
  if (needed) {
    logSafe([], needed);
    process.exit(1);
  }
  const args = parseArgs(process.argv.slice(2));
  args.stdoutIsTTY = process.stdout.isTTY === true;
  if (args.deviceCommand) {
    let revealed = "";
    try {
      const result = await runDeviceCommand(args);
      revealed = result.key || "";
      if (result.announcement) {
        writeSync(1, result.announcement);
        logSafe(redactList(result.token, result.key), "issued a device key device=" + result.id);
      } else if (result.lines) {
        for (const line of result.lines) writeSync(1, line + "\n");
      } else if (result.message) {
        logSafe(redactList(result.token, ""), result.message);
      }
    } catch (error) {
      logSafe(
        redactList(process.env.AIDANOS_RELAY_TOKEN, revealed),
        error instanceof Error ? error.message : error,
      );
      process.exit(1);
    }
    return;
  }
  let relay;
  try {
    relay = await startRelay({
      lan: args.lan,
      lanAddress: args.lanAddress,
      behindProxy: args.behindProxy,
      allowSharedKeyBehindProxy: args.allowSharedKeyBehindProxy,
      initDevices: args.initDevices,
      vault: args.vault || undefined,
      data: args.data || undefined,
      port: args.port == null || Number.isNaN(args.port) ? undefined : args.port,
      allowReset: process.env.AIDANOS_RELAY_ALLOW_RESET === "1",
    });
  } catch (error) {
    logSafe(
      [process.env.AIDANOS_RELAY_TOKEN, process.env.AIDANOS_RELAY_GIT_TOKEN],
      error instanceof Error ? error.message : error,
    );
    process.exit(1);
  }
  for (const line of startupLines({
    lan: !relay.behindProxy && (args.lan || Boolean(args.lanAddress)),
    port: relay.port,
    phone: relay.behindProxy ? null : relay.phone,
    behindProxy: relay.behindProxy,
  })) {
    writeSync(line.startsWith("WARNING") ? 2 : 1, stampLine(line) + "\n");
  }
  const shutdown = () => {
    relay.close().then(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

const invoked = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invoked) {
  main();
}
