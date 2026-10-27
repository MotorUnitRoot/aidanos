import http from "node:http";
import { constants as fsConstants, writeSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { pathToFileURL } from "node:url";
import { WebSocket, WebSocketServer } from "ws";
import * as Automerge from "@automerge/automerge";
import { next as AutomergeNext } from "@automerge/automerge/slim";
import { isValidDocumentId } from "@automerge/automerge-repo";
import { decode, encode } from "@automerge/automerge-repo/helpers/cbor.js";
import { listenHosts } from "./bind.mjs";
import { planBudget } from "./budget.mjs";
import {
  HEALTH_CRASH_LOOP,
  HEALTH_OK,
  HEALTH_SILENT,
  HEALTH_SYNC_DOWN,
  HEALTH_WARMING,
  WORKER_SILENT_MS,
  frameToTransfer,
} from "./channel.mjs";
import { backupOnce } from "./git.mjs";
import { peekFrameHeader } from "./frame-header.mjs";
import { INDEX_ID } from "./ids.mjs";
import { installIndexTrace, noteGitWork } from "./index-trace.mjs";
import { discardOpenNoteTemps, logToken, rememberVaultRoot, saveNoteFile, sweepStaleNoteTemps } from "./mirror.mjs";
import {
  flushFileLog,
  installFileLog,
  logFatal,
  logSafe,
  pauseFileLog,
  redact,
  setFatalFallbackDir,
  stampLine,
} from "./redact.mjs";
import { refuseSymlinkedStorage, storageFolderFault } from "./storage-safe.mjs";
import { createWorkerHost } from "./worker-host.mjs";

const DEFAULT_PORT = 3750;
const MIN_TOKEN_LENGTH = 32;
// openSession loads stored notes before /health can say the engine is up.
// A hang there used to leave the port open and /health at 503. This bound
// is separate from the 15s handshake.
const SESSION_TIMEOUT_MS = 30_000;
// launchd's stop sends SIGTERM, then SIGKILL if the process is still
// there. A close() that never finishes used to wait for that SIGKILL,
// and a second SIGTERM or SIGINT was ignored. The deadline exits first.
// A second signal exits the same way, without waiting out the deadline.
export const SHUTDOWN_DEADLINE_MS = 5000;
export const SHUTDOWN_TIMEOUT_LINE = "relay close timed out";
// launchd waits about 20s after SIGTERM. Saves get 12s, then close gets 5s.
export const SAVE_WAIT_MS = 12_000;
export const SAVE_WAIT_TIMEOUT_LINE = "in-flight saves timed out";
export const SLOW_SAVE_NOTE_NAME = "held-note.md";

export function slowSaveNoteBody() {
  return "whole-note-line\n".repeat(256);
}

const inflightSaves = new Set();

function trackInflight(work) {
  const run = Promise.resolve().then(work);
  inflightSaves.add(run);
  return run.finally(() => inflightSaves.delete(run));
}

function saveWaitBound(env = process.env) {
  if (env.NODE_ENV === "test") {
    const raw = Number(env.AIDANOS_RELAY_TEST_SAVE_WAIT_MS);
    if (Number.isFinite(raw) && raw >= 50 && raw <= SAVE_WAIT_MS) return raw;
  }
  return SAVE_WAIT_MS;
}

function waitForInflightSaves(ms) {
  if (inflightSaves.size === 0) return Promise.resolve("settled");
  return new Promise((resolve) => {
    const deadline = Date.now() + ms;
    const check = () => {
      if (inflightSaves.size === 0) return resolve("settled");
      const left = deadline - Date.now();
      if (left <= 0) return resolve("timeout");
      setTimeout(check, Math.min(20, left));
    };
    check();
  });
}

function shutdownDeadline(env = process.env) {
  if (env.NODE_ENV === "test") {
    const raw = Number(env.AIDANOS_RELAY_TEST_SHUTDOWN_MS);
    if (Number.isFinite(raw) && raw >= 50 && raw <= SHUTDOWN_DEADLINE_MS) return raw;
  }
  return SHUTDOWN_DEADLINE_MS;
}

function hangClose(env = process.env) {
  return env.NODE_ENV === "test" && env.AIDANOS_RELAY_TEST_HANG_CLOSE === "1";
}

function fatalStateDir(vault, data, env = process.env) {
  if (data) return path.resolve(String(data));
  if (env.AIDANOS_RELAY_DATA) return path.resolve(String(env.AIDANOS_RELAY_DATA));
  const root = vault || env.AIDANOS_RELAY_VAULT || "";
  if (!String(root).trim()) return "";
  return path.resolve(String(root), ".aidanos", "relay");
}
// A note's first sync is its whole history. 1 MB was small enough to reject that
// and leave the device retrying forever. Measured with Automerge 3.2.6 on
// synthetic text, the largest CBOR sync frame was 306,331 bytes for a fresh
// 2 MB note, 1,191,807 bytes for 2 MB of high-entropy text, 919,964 bytes for
// 6 MB of note-like text, and 31,575 bytes for an index of 1,000 paths. The
// relay syncs .md only, so a .txt file is not one of those frames. The largest
// realistic frame is about 1.19 MB. Twice that is about 2.3 MB, below the
// 4–8 MB range, so the cap is the bottom of that range. The app uses this
// same cap and refuses an oversized note on its own, so the socket stays up
// for every other note.
export const MAX_PAYLOAD = 4 * 1024 * 1024;
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

export function payloadLimit(value) {
  if (value == null || value === "") return MAX_PAYLOAD;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return MAX_PAYLOAD;
  return n;
}

// Close unless a storage id is a UUID and every document id is one Automerge accepts.
// The disk adapter joins both into a path and does not check them.
export function syncMessageAllowed(message) {
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

export function syncFrameAllowed(value) {
  return syncMessageAllowed(frameMessage(value));
}

function deviceToken(metadata) {
  if (!metadata || typeof metadata !== "object") return "";
  const value = metadata.deviceToken;
  if (typeof value !== "string" || value.length === 0 || value.length > 256) return "";
  return value;
}

function sameDeviceToken(left, right) {
  if (!left || !right || left.length !== right.length) return false;
  return timingSafeEqual(Buffer.from(left), Buffer.from(right));
}

const JOIN_DECODE_LIMIT = 64 * 1024;

function frameBytes(data) {
  if (data == null) return null;
  if (typeof data === "string") return Buffer.from(data);
  if (Buffer.isBuffer(data)) return data;
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return null;
}

function decodeFrameMessage(raw) {
  try {
    const message = decode(raw);
    if (!message || typeof message !== "object" || Array.isArray(message)) return null;
    return message;
  } catch {
    return null;
  }
}

// Sync frames carry the note bytes. The accept thread reads the header and
// forwards the original buffer. A join is small, so it is decoded in full
// for the handshake fields the header walk does not keep.
function frameMessage(data) {
  const raw = frameBytes(data);
  if (!raw) return null;
  const header = peekFrameHeader(raw);
  if (header && header.type === "join") {
    if (raw.length > JOIN_DECODE_LIMIT) return null;
    return decodeFrameMessage(raw);
  }
  if (header) return header;
  if (raw.length > JOIN_DECODE_LIMIT) return null;
  return decodeFrameMessage(raw);
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

function seconds(millis) {
  return (millis / 1000).toFixed(3) + "s";
}

/// The first sync message loads the engine. On a cold simulator that work
/// blocked the process: run 40425278945 took 48s to accept the other device,
/// and run 40423525581 took 6.6s for the first index reply. Doing it before
/// any device is connected keeps that cost off the 15s handshake.
export function warmSyncEngine() {
  const local = AutomergeNext.init();
  const remote = AutomergeNext.init();
  let localState = AutomergeNext.initSyncState();
  let remoteState = AutomergeNext.initSyncState();
  const generated = AutomergeNext.generateSyncMessage(local, localState);
  localState = generated[0];
  const request = generated[1];
  if (!request) return;
  Automerge.decodeSyncMessage(request);
  const received = AutomergeNext.receiveSyncMessage(remote, remoteState, request);
  remoteState = received[1];
  const reply = AutomergeNext.generateSyncMessage(received[0], remoteState);
  if (reply[1]) AutomergeNext.receiveSyncMessage(local, localState, reply[1]);
  AutomergeNext.decodeSyncState(AutomergeNext.encodeSyncState(localState));
}

function health(gitState, bootedAt, status, resetGeneration) {
  const syncUp = status === HEALTH_OK;
  return JSON.stringify({
    ok: syncUp,
    status,
    git: gitState.status === "ok",
    gitStatus: gitState.status,
    bootedAt,
    resetGeneration,
  });
}

function selectProtocol(versions) {
  if (versions === undefined) return "1";
  if (Array.isArray(versions) && versions.includes("1")) return "1";
  return null;
}

export function parseArgs(argv) {
  const out = { lan: false, lanAddress: "", vault: "", data: "", port: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--lan") out.lan = true;
    else if (arg === "--token") {
      throw new Error(
        "The token is not read from the command line. Set AIDANOS_RELAY_TOKEN or AIDANOS_RELAY_TOKEN_FILE.",
      );
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
  return token;
}

export function nodeRequirement(version = process.versions.node) {
  const major = Number(String(version).split(".")[0]);
  if (Number.isFinite(major) && major >= 22) return "";
  return "Node 22 or newer is needed.";
}

export function startupLines({ lan, port, phone }) {
  const lines = ["LISTENING 127.0.0.1 " + port];
  if (lan) lines.push(LAN_WARNING);
  if (phone) lines.push("PHONE ws://" + phone + ":" + port);
  return lines;
}

function isInsideDirectory(parent, child) {
  const root = path.resolve(parent);
  const target = path.resolve(child);
  if (root === target) return true;
  const prefix = root.endsWith(path.sep) ? root : root + path.sep;
  return target.startsWith(prefix);
}

async function emptyDirectory(dir) {
  // One name at a time. A parallel delete races a mirror rename and macOS
  // then returns ENOTEMPTY for the directory. A missing directory is already empty:
  // wiping the notes folder also removes a data folder that lives inside it.
  let names;
  try {
    names = await fs.readdir(dir);
  } catch (error) {
    if (error && error.code === "ENOENT") return;
    throw error;
  }
  for (const name of names) {
    await fs.rm(path.join(dir, name), { recursive: true, force: true, maxRetries: 8, retryDelay: 25 });
  }
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
  if (found.gitRemote) parts.push("It has a git remote.");
  else parts.push("It already has files, and it has no relay marker.");
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
  if (lines.length !== 3 || lines[2] !== "") return "";
  if (lines[0] !== MARKER_HEADER || !MARKER_ID.test(lines[1])) return "";
  return lines[1];
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
  const vaultArg = options.vault || env.AIDANOS_RELAY_VAULT || "";
  if (!String(vaultArg).trim()) {
    throw new Error(
      "Set --vault or AIDANOS_RELAY_VAULT. The relay will not use AIDANOS_VAULT or another app's folder.",
    );
  }
  const vault = path.resolve(String(vaultArg));
  const dataDir = path.resolve(options.data || env.AIDANOS_RELAY_DATA || path.join(vault, ".aidanos", "relay"));
  setFatalFallbackDir(dataDir);
  const port = options.port == null ? portFromEnv(env) : Number(options.port);
  const { hosts, phone } = listenHosts({
    lan: Boolean(options.lan) || Boolean(options.lanAddress),
    interfaces: options.interfaces,
    choose: options.lanAddress || "",
  });
  const gitUrl = String(options.gitUrl ?? env.AIDANOS_RELAY_GIT_URL ?? "").trim();
  const gitToken = String(options.gitToken ?? env.AIDANOS_RELAY_GIT_TOKEN ?? "").trim();
  const secrets = [token, gitToken, gitUrl].filter(Boolean);
  if (env.NODE_ENV === "test") {
    const holdNote = Number(env.AIDANOS_RELAY_TEST_HOLD_NOTE_MS);
    if (Number.isFinite(holdNote) && holdNote > 0) options.testHoldNoteMs = holdNote;
    if (env.AIDANOS_RELAY_TEST_CRASH_MID_WRITE === "1") options.testCrashMidWrite = true;
  }
  await installIndexTrace((line) => logSafe(secrets, line), { thread: "main", timersOnly: true });
  await assertNotClientVault(vault);
  // A symlink is refused before any marker is written through it.
  // The temp sweep runs only after the folder is claimed, and only for
  // paths recorded in the state-folder manifest. There is no tree walk.
  await refuseSymlinkedStorage(dataDir);
  await claimRelayFolders(vault, dataDir);
  if (storageFolderFault(dataDir)) throw new Error("storage folder failed the owner walk");
  // One realpath for the life of this process. A save must not call it again.
  rememberVaultRoot(vault);
  await sweepStaleNoteTemps(vault, dataDir);
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

  function noteGit(result) {
    if (!result) return;
    if (result.pushed) gitState.status = "ok";
    else if (result.committed && result.pushed === false) gitState.status = "failed";
  }

  let bootedAt = new Date().toISOString();
  // Finished resets. A caller waits for its own ticket: an earlier queued
  // reset can change bootedAt before this request's rotate runs.
  let resetGeneration = 0;
  let resetQueued = 0;
  const allowReset = options.allowReset === true;
  const servers = [];
  let live = null;
  let everLive = false;
  let resetChain = Promise.resolve();
  let api = null;
  const sockets = new Map();
  const peers = new Map();
  let nextConn = 1;
  let budgetTimer = null;
  let keepAliveTimer = null;
  let accepting = true;
  let dropSavesOnClose = false;
  const workerSaves = new Map();

  function currentHost() {
    return live && live.host ? live.host : null;
  }

  function syncStatus() {
    const host = currentHost();
    if (host && host.crashLoop) return HEALTH_CRASH_LOOP;
    if (!live && everLive) return HEALTH_SYNC_DOWN;
    if (!host || !host.warm) return HEALTH_WARMING;
    if (!host.lastPong || Date.now() - host.lastPong > WORKER_SILENT_MS) return HEALTH_SILENT;
    return HEALTH_OK;
  }

  function closeConn(entry, code) {
    if (!entry || entry.gone) return;
    entry.gone = true;
    sockets.delete(entry.id);
    if (entry.peerId && peers.get(entry.peerId) === entry.id) peers.delete(entry.peerId);
    const host = currentHost();
    if (host) host.post({ v: 1, kind: "close", conn: entry.id });
    try {
      if (code) entry.ws.close(code);
      else entry.ws.terminate();
    } catch {
      // The socket is already gone.
    }
  }

  function closeAll(code) {
    for (const entry of [...sockets.values()]) closeConn(entry, code);
  }

  function applyBudget() {
    const now = Date.now();
    const plan = planBudget([...sockets.values()], now);
    const closing = new Set(plan.close);
    for (const id of plan.close) {
      const entry = sockets.get(id);
      if (entry) closeConn(entry, 1008);
    }
    for (const id of plan.pause) {
      const entry = sockets.get(id);
      if (!entry || entry.gone || closing.has(id) || entry.paused) continue;
      entry.paused = true;
      entry.pausedAt = now;
      try { entry.ws._socket.pause(); } catch { /* the socket is already gone */ }
    }
    for (const id of plan.resume) {
      const entry = sockets.get(id);
      if (!entry || entry.gone || !entry.paused) continue;
      entry.paused = false;
      entry.pausedAt = 0;
      try { entry.ws._socket.resume(); } catch { /* the socket is already gone */ }
    }
  }

  function deliver(msg) {
    if (!msg || !Number.isInteger(msg.conn)) return;
    const entry = sockets.get(msg.conn);
    if (msg.kind === "ack") {
      if (entry) entry.bytes = Math.max(0, (Number(entry.bytes) || 0) - (Number(msg.bytes) || 0));
      applyBudget();
      return;
    }
    // A worker frame is written only to the socket that owns this id.
    if (!entry || entry.gone) return;
    if (msg.kind === "msg" && msg.data instanceof ArrayBuffer) {
      try { entry.sendLogged(msg.data); } catch { /* already closed */ }
      return;
    }
    if (msg.kind === "close") closeConn(entry, msg.code);
  }

  function noteWorkerSave(msg) {
    if (!msg || msg.phase === "reset") {
      for (const resolve of workerSaves.values()) resolve();
      workerSaves.clear();
      return;
    }
    if (!Number.isInteger(msg.id)) return;
    if (msg.phase === "start") {
      if (workerSaves.has(msg.id)) return;
      let resolve;
      const promise = new Promise((done) => {
        resolve = done;
      });
      workerSaves.set(msg.id, resolve);
      inflightSaves.add(promise);
      promise.finally(() => inflightSaves.delete(promise));
      return;
    }
    if (msg.phase === "end") {
      const resolve = workerSaves.get(msg.id);
      workerSaves.delete(msg.id);
      if (resolve) resolve();
    }
  }

  async function openSession() {
    const debounce = Number(options.mirrorDebounceMs ?? env.AIDANOS_MIRROR_DEBOUNCE_MS);
    const host = createWorkerHost({
      vault,
      dataDir,
      peerId: options.peerId || "aidanos-relay",
      mirrorDebounceMs: Number.isFinite(debounce) && debounce >= 0 ? debounce : 400,
      test: options,
      isOpen(id) {
        const entry = sockets.get(id);
        return Boolean(entry && !entry.gone);
      },
      onLog(line) {
        console.error(redact(line, secrets));
      },
      onDown() {
        closeAll(1011);
      },
      onSocket: deliver,
      onSave: noteWorkerSave,
    });
    try {
      await host.start();
      return { repo: host.repo, mirror: host.mirror, host, release() {} };
    } catch (error) {
      try { await host.stop(); } catch { /* the start error is the one that surfaces */ }
      throw error;
    }
  }

  async function disposeSession(session, how) {
    if (!session || session.closed) return;
    session.closed = true;
    const keepSockets = how === "abandon";
    if (session.host && typeof session.host.wake === "function") session.host.wake();
    session.mirror.stop();
    // The folder is about to be deleted, so do not flush it again.
    // Wait only for a write that has already started. A save the shutdown
    // bound already gave up on is unlinked instead, and must not hold close.
    if (how !== "drop-saves") await session.mirror.idle();
    // A timed-out open finishes after the retry is live. Leave those sockets.
    if (!keepSockets) closeAll(1000);
    try { await session.host.stop(); } catch { /* already stopped */ }
    if (keepSockets && typeof options.onAbandonedSession === "function") {
      try { options.onAbandonedSession(); } catch { /* the test observes the cleanup */ }
    }
  }

  function warmTimeout() {
    const error = new Error("sync warm-up timed out");
    error.code = "WARM_TIMEOUT";
    return error;
  }

  async function openSessionWithinTimeout() {
    const ms = Number(options.sessionTimeoutMs) > 0 ? Number(options.sessionTimeoutMs) : SESSION_TIMEOUT_MS;
    let settled = false;
    let opened = null;
    let timer;
    const work = (async () => {
      if (typeof options.beforeOpenReady === "function") await options.beforeOpenReady();
      const session = await openSession();
      opened = session;
      if (settled) {
        await disposeSession(session, "abandon");
        throw warmTimeout();
      }
      return session;
    })();
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        settled = true;
        reject(warmTimeout());
      }, ms);
    });
    try {
      return await Promise.race([work, timeout]);
    } catch (error) {
      settled = true;
      if (opened) await disposeSession(opened, "abandon");
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  async function closeListening() {
    for (const entry of servers) {
      for (const ws of [...entry.wss.clients]) ws.terminate();
      entry.wss.close();
      if (typeof entry.httpServer.closeAllConnections === "function") entry.httpServer.closeAllConnections();
    }
    await Promise.all(servers.map((entry) => whenServerClosed(entry.httpServer)));
    for (const entry of servers) entry.wss.emit("close");
  }

  async function activateSession(session) {
    let published = false;
    try {
      // The worker already warmed its own isolate before it posted ready.
      // Running that WASM here blocks the accept thread on every reset.
      if (typeof options.warm === "function") options.warm();
      const warmMs = session.host && Number.isFinite(session.host.warmMs) ? session.host.warmMs : 0;
      logSafe(secrets, "sync engine warm in " + seconds(warmMs));
      if (api) api.repo = session.repo;
      bootedAt = new Date().toISOString();
      live = session;
      everLive = true;
      published = true;
    } finally {
      if (!published) {
        try { await disposeSession(session); } catch { /* keep the warm error */ }
      }
    }
  }

  async function rotate() {
    const started = Date.now();
    const markerId = await ownedMarkerId(vault, dataDir);
    if (!markerId) {
      logSafe(secrets, "reset refused: the folder has no current relay marker");
      return;
    }
    await disposeSession(live);
    live = null;
    let lastError;
    const marker = relayMarkerText(markerId);
    const dataInsideVault = isInsideDirectory(vault, dataDir);
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        await emptyDirectory(vault);
        // The default data folder is vault/.aidanos/relay. Emptying the notes
        // folder already removed it, so do not try to empty a path that is gone.
        if (!dataInsideVault) await emptyDirectory(dataDir);
        await fs.mkdir(path.join(vault, ".aidanos"), { recursive: true });
        await fs.mkdir(dataDir, { recursive: true });
        await writeMarkerFile(path.join(vault, ".aidanos", "relay-folder"), marker);
        await writeMarkerFile(path.join(dataDir, "relay-folder"), marker);
        if (typeof options.beforeReopen === "function") await options.beforeReopen();
        const session = await openSessionWithinTimeout();
        // The new generation stays hidden until the first sync has run.
        // A device waiting on /health then connects to an engine that already
        // answered one index round trip, instead of paying for it while the
        // other device's handshake sits unread.
        await activateSession(session);
        resetGeneration += 1;
        logSafe(secrets, "reset complete");
        logSafe(secrets, "reset ready in " + seconds(Date.now() - started));
        if (typeof options.onReset === "function") options.onReset();
        return;
      } catch (error) {
        lastError = error;
        logSafe(secrets, "reset attempt failed:", error instanceof Error ? error.message : error);
      }
    }
    logSafe(secrets, "reset failed: kept generation " + resetGeneration);
    // A timed-out open is closed above. One more open, still on the old
    // generation, so /health does not stay 503 after the wait has ended.
    // Any other reset failure leaves sync down.
    if (lastError && lastError.code === "WARM_TIMEOUT") {
      try {
        const session = await openSessionWithinTimeout();
        await activateSession(session);
      } catch (error) {
        logSafe(secrets, "reset failed:", error instanceof Error ? error.message : error);
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
      if (!accepting) {
        res.writeHead(503, { "content-length": 0 });
        res.end();
        return;
      }
      const pathOnly = String(req.url || "").split("?")[0];
      if (pathOnly === "/health") {
        const status = syncStatus();
        const body = health(gitState, bootedAt, status, resetGeneration);
        res.writeHead(status === HEALTH_OK ? 200 : 503, {
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
        if (blocked(ip) || !tokensMatch(token, bearerToken(req.headers.authorization))) {
          if (!blocked(ip)) noteFailure(ip);
          res.writeHead(401, { "content-length": 0 });
          res.end();
          return;
        }
        ownedMarkerId(vault, dataDir)
          .then((markerId) => {
            if (res.writableEnded) return;
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
            resetQueued += 1;
            const ticket = resetQueued;
            const body = JSON.stringify({ ok: true, resetting: true, resetGeneration: ticket });
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
    httpServer.on("connection", (socket) => {
      if (!accepting) socket.destroy();
    });
    httpServer.on("upgrade", (req, socket, head) => {
      const hostNow = currentHost();
      if (!accepting || !live || !hostNow || !hostNow.warm || hostNow.crashLoop) {
        socket.destroy();
        return;
      }
      const ip = clientAddress(req);
      if (blocked(ip) || !tokensMatch(token, bearerToken(req.headers.authorization))) {
        if (!blocked(ip)) noteFailure(ip);
        logSafe(secrets, "rejected a sync connection");
        rejectUpgrade(socket);
        return;
      }
      failures.delete(ip);
      entry.wss.handleUpgrade(req, socket, head, (ws) => {
        const id = nextConn;
        nextConn += 1;
        const conn = {
          id,
          ws,
          bytes: 0,
          paused: false,
          pausedAt: 0,
          peerId: "",
          gone: false,
          rejected: false,
          openedAt: Date.now(),
          joinAnswered: false,
          indexRequestAt: null,
        };
        ws.isAlive = true;
        ws.on("pong", () => {
          ws.isAlive = true;
        });
        function logFrame(direction, data, decoded) {
          const message = decoded || frameMessage(data);
          if (!message) return null;
          const type = typeof message.type === "string" ? message.type : "";
          const docId = typeof message.documentId === "string" ? message.documentId : "";
          let line = "";
          if (type === "join") line = "sync " + direction + " join";
          else if (type === "peer") line = "sync " + direction + " peer";
          else if (type === "doc-unavailable") line = "sync " + direction + " doc-unavailable doc=" + docId;
          else if (type === "sync" || type === "request") {
            line = "sync " + direction + " " + type + " doc=" + docId;
          }
          if (line) logSafe(secrets, line);
          const now = Date.now();
          if (direction === "out" && type === "peer" && !conn.joinAnswered) {
            conn.joinAnswered = true;
            logSafe(secrets, "join answered in " + seconds(now - conn.openedAt));
          }
          const indexFrame =
            docId === INDEX_ID &&
            (type === "request" || type === "sync" || type === "doc-unavailable");
          if (indexFrame && direction === "in") {
            conn.indexRequestAt = now;
            logSafe(secrets, "index request");
          } else if (indexFrame && direction === "out" && conn.indexRequestAt != null) {
            logSafe(secrets, "index reply in " + seconds(now - conn.indexRequestAt));
            conn.indexRequestAt = null;
          }
          return message;
        }
        conn.sendLogged = (payload) => {
          logFrame("out", payload);
          return ws.send(payload);
        };
        function handleJoin(message) {
          const senderId = typeof message.senderId === "string" ? message.senderId : "";
          if (!senderId) {
            closeConn(conn, 1008);
            return;
          }
          if (conn.peerId) {
            closeConn(conn, 1008);
            return;
          }
          const nextToken = deviceToken(message.peerMetadata);
          const previousId = peers.get(senderId);
          if (previousId != null && previousId !== conn.id) {
            const previous = sockets.get(previousId);
            if (previous && sameDeviceToken(previous.deviceToken, nextToken)) {
              logSafe(secrets, "closed the older sync connection for a duplicate peer id");
              closeConn(previous, 1000);
            } else {
              logSafe(secrets, "kept the existing device for a duplicate peer id");
              closeConn(conn, 1008);
              return;
            }
          }
          const host = currentHost();
          if (!host || !host.warm || host.crashLoop) {
            closeConn(conn, 1011);
            return;
          }
          conn.peerId = senderId;
          conn.deviceToken = nextToken;
          peers.set(senderId, conn.id);
          const selected = selectProtocol(message.supportedProtocolVersions);
          if (selected == null) {
            try {
              ws.send(encode({
                type: "error",
                senderId: host.peerId,
                message: "unsupported protocol version",
                targetId: senderId,
              }));
            } catch { /* already closed */ }
            closeConn(conn, 1008);
            return;
          }
          // Tell the worker about the peer before the peer frame hits the socket,
          // so the client's first sync cannot overtake "open" on the port.
          host.post({
            v: 1,
            kind: "open",
            conn: conn.id,
            peerId: senderId,
            peerMetadata: message.peerMetadata || null,
          });
          conn.sendLogged(encode({
            type: "peer",
            senderId: host.peerId,
            peerMetadata: host.peerMetadata,
            selectedProtocolVersion: "1",
            targetId: senderId,
          }));
        }
        function handleDoc(message, raw) {
          const host = currentHost();
          if (!host || !host.warm || host.crashLoop) {
            closeConn(conn, 1011);
            return;
          }
          const docId = typeof message.documentId === "string" ? message.documentId : "";
          if (docId && host.refused.has(docId)) {
            logSafe(secrets, "poison document " + logToken(docId));
            closeConn(conn, 1008);
            return;
          }
          const copy = frameToTransfer(raw);
          if (!copy) {
            closeConn(conn, 1008);
            return;
          }
          conn.bytes += copy.byteLength;
          applyBudget();
          if (conn.gone) return;
          host.post({ v: 1, kind: "msg", conn: conn.id, data: copy }, [copy]);
        }
        ws.on("error", (error) => {
          logSafe(secrets, "sync connection closed:", error instanceof Error ? error.message : error);
        });
        ws.on("close", () => {
          if (conn.gone) return;
          conn.gone = true;
          sockets.delete(conn.id);
          if (conn.peerId && peers.get(conn.peerId) === conn.id) peers.delete(conn.peerId);
          const host = currentHost();
          if (host) host.post({ v: 1, kind: "close", conn: conn.id });
          applyBudget();
        });
        ws.on("message", (data, isBinary) => {
          if (conn.gone) return;
          const message = frameMessage(isBinary === false && typeof data === "string" ? data : data);
          let allowed = false;
          try {
            allowed = syncMessageAllowed(message);
          } catch {
            allowed = false;
          }
          if (!allowed) {
            if (!conn.rejected) {
              conn.rejected = true;
              logSafe(secrets, "closed a sync connection");
              try { ws.terminate(); } catch { /* already gone */ }
            }
            return;
          }
          logFrame("in", null, message);
          if (!message || conn.gone) return;
          if (message.type === "join") handleJoin(message);
          else handleDoc(message, data);
        });
        sockets.set(id, conn);
        logSafe(secrets, "accepted a sync connection");
        if (ws.readyState !== WebSocket.OPEN) return;
      });
    });
    servers.push(entry);
  }

  let boundPort = port;
  for (const entry of servers) {
    boundPort = await listen(entry.httpServer, entry.host, port);
  }

  // /health stays 503 until this warm-up finishes. The port is already open,
  // so a start script can wait on it instead of racing a closed socket.
  let session = null;
  try {
    session = await openSessionWithinTimeout();
    await activateSession(session);
  } catch (error) {
    try { await disposeSession(session); } catch { /* the warm error is the one that stops startup */ }
    await closeListening();
    throw error;
  }

  const interval = gitInterval(options.gitIntervalMs, env);
  let gitTimer = null;
  async function runBackup() {
    const started = Date.now();
    try {
      const result = await backupOnce({ vault, gitUrl, gitToken, secrets, env });
      noteGitWork(Date.now() - started);
      noteGit(result);
      return result;
    } catch (error) {
      noteGitWork(Date.now() - started);
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

  budgetTimer = setInterval(() => applyBudget(), 1000);
  if (budgetTimer.unref) budgetTimer.unref();
  keepAliveTimer = setInterval(() => {
    for (const entry of [...sockets.values()]) {
      if (entry.gone) continue;
      if (entry.ws.isAlive === false) {
        try { entry.ws.terminate(); } catch { /* already gone */ }
        continue;
      }
      entry.ws.isAlive = false;
      try { entry.ws.ping(); } catch { /* already gone */ }
    }
  }, 5000);
  if (keepAliveTimer.unref) keepAliveTimer.unref();

  api = {
    port: boundPort,
    url: "ws://" + "127.0.0.1:" + boundPort,
    phone: phone ? "ws://" + phone + ":" + boundPort : null,
    hosts,
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
      if (hangClose(env)) await new Promise(() => {});
      await resetChain.catch(() => {});
      const session = live;
      live = null;
      if (gitTimer) clearInterval(gitTimer);
      if (budgetTimer) clearInterval(budgetTimer);
      if (keepAliveTimer) clearInterval(keepAliveTimer);
      if (session) {
        try { await disposeSession(session, dropSavesOnClose ? "drop-saves" : undefined); } catch { /* shutdown still closes the port */ }
      }
      for (const entry of servers) {
        for (const ws of [...entry.wss.clients]) ws.terminate();
        entry.wss.close();
        if (typeof entry.httpServer.closeAllConnections === "function") entry.httpServer.closeAllConnections();
      }
      await Promise.all(servers.map((entry) => whenServerClosed(entry.httpServer)));
      // The websocket adapter clears its ping timer on "close". A client that
      // already went away can leave that timer running, which holds the
      // process open after the tests have finished.
      for (const entry of servers) entry.wss.emit("close");
      if (session && session.repo && typeof session.repo.shutdown === "function") await session.repo.shutdown();
    },
    async stopAcceptingAndDrainSaves() {
      accepting = false;
      for (const entry of servers) {
        try {
          if (entry.httpServer.listening) entry.httpServer.close();
        } catch { /* close() stops the rest */ }
      }
      const bound = saveWaitBound(env);
      const session = live;
      const asked = session && session.mirror && typeof session.mirror.finishSaves === "function"
        ? session.mirror.finishSaves().then(() => "settled", () => "settled")
        : Promise.resolve("settled");
      const timeout = new Promise((resolve) => {
        const timer = setTimeout(() => resolve("timeout"), bound);
        asked.then(() => clearTimeout(timer), () => clearTimeout(timer));
      });
      const [workerResult, localResult] = await Promise.all([
        Promise.race([asked, timeout]),
        waitForInflightSaves(bound),
      ]);
      const result = workerResult === "timeout" || localResult === "timeout" ? "timeout" : "settled";
      if (result === "timeout") {
        logSafe(secrets, SAVE_WAIT_TIMEOUT_LINE);
        // Temps created on this thread (the slow-save hook) and temps the
        // worker still holds. The worker unlinks its own set, then we exit 1.
        await discardOpenNoteTemps();
        const discard = session && session.mirror && session.mirror.discardTemps;
        if (typeof discard === "function") {
          try { await discard(); } catch { /* close still exits 1 */ }
        }
        dropSavesOnClose = true;
      }
      return result;
    },
  };
  if (env.NODE_ENV === "test") {
    api.pausedSockets = () =>
      [...sockets.values()].filter((entry) => entry.paused && !entry.gone).map((entry) => entry.id);
    api.echoedFrames = () => (live && live.host ? live.host.echoes.map((frame) => Buffer.from(frame)) : []);
    api.workerHolding = () => Boolean(live && live.host && live.host.holding);
    api.refusedDocs = () => (live && live.host ? [...live.host.refused] : []);
  }
  if (env.NODE_ENV === "test" && env.AIDANOS_RELAY_TEST_SLOW_SAVE === "1") {
    const body = slowSaveNoteBody();
    const noteFile = path.join(vault, SLOW_SAVE_NOTE_NAME);
    const staged = env.AIDANOS_RELAY_TEST_SAVE_STAGED;
    const hold = Number(env.AIDANOS_RELAY_TEST_SAVE_HOLD_MS);
    const delay = Number.isFinite(hold) && hold >= 0 ? hold : 900;
    trackInflight(() => saveNoteFile(noteFile, body, async () => {
      if (staged) await fs.writeFile(String(staged), body);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }, { vault, stateDir: dataDir })).catch(() => { /* the shutdown wait still sees this save leave the set */ });
  }
  return api;
}

function whenServerClosed(server) {
  return new Promise((resolve) => {
    if (!server.listening) {
      resolve();
      return;
    }
    server.close(() => resolve());
  });
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

async function main() {
  // A terminal stays on the synchronous console. A file or a pipe does
  // not: Node's file stderr is writeSync, and a full pipe blocks until
  // the reader drains it. CI and launchd both point this process at a
  // file. The async stream writes that same fd.
  if (!process.stderr.isTTY) installFileLog();
  const args = parseArgs(process.argv.slice(2));
  const stateDir = fatalStateDir(args.vault, args.data);
  if (stateDir) setFatalFallbackDir(stateDir);
  const needed = nodeRequirement();
  if (needed) {
    logFatal([], needed);
    process.exit(1);
  }
  let relay;
  try {
    relay = await startRelay({
      lan: args.lan,
      lanAddress: args.lanAddress,
      vault: args.vault || undefined,
      data: args.data || undefined,
      port: args.port == null || Number.isNaN(args.port) ? undefined : args.port,
      allowReset: process.env.NODE_ENV === "test" && process.env.AIDANOS_RELAY_ALLOW_RESET === "1",
    });
  } catch (error) {
    logFatal(
      [process.env.AIDANOS_RELAY_TOKEN, process.env.AIDANOS_RELAY_GIT_TOKEN],
      error instanceof Error ? error.message : error,
    );
    process.exit(1);
  }
  let closing = false;
  let settled = false;
  let deadlineTimer = null;
  let giveUp = () => {};
  const shutdown = () => {
    if (settled) return;
    if (closing) {
      giveUp();
      return;
    }
    closing = true;
    const exitWith = (code, line) => {
      if (settled) return;
      settled = true;
      if (deadlineTimer) clearTimeout(deadlineTimer);
      try {
        pauseFileLog();
        logSafe([], line);
      } catch { /* the flush still runs */ }
      try {
        flushFileLog();
      } catch { /* exit still runs */ }
      process.exit(code);
    };
    let saveWaitTimedOut = false;
    giveUp = () => exitWith(1, SHUTDOWN_TIMEOUT_LINE);
    const beginClose = () => {
      if (settled) return;
      // The 5s close deadline starts only after in-flight saves settle,
      // or after the 12s save bound has already been logged. A save wait
      // that hit that bound still closes, then exits 1.
      deadlineTimer = setTimeout(() => giveUp(), shutdownDeadline());
      const code = saveWaitTimedOut ? 1 : 0;
      Promise.resolve(relay.close()).then(
        () => exitWith(code, "relay log closed"),
        () => exitWith(code, "relay log closed"),
      );
    };
    Promise.resolve(relay.stopAcceptingAndDrainSaves()).then((result) => {
      saveWaitTimedOut = result === "timeout";
      beginClose();
    }, beginClose);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  for (const line of startupLines({ lan: args.lan || Boolean(args.lanAddress), port: relay.port, phone: relay.phone })) {
    writeSync(line.startsWith("WARNING") ? 2 : 1, stampLine(line) + "\n");
  }
}

const invoked = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invoked) {
  main();
}
