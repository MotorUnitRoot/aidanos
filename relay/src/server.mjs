import https from "node:https";
import { loadRelayTLS, pairingRecord, writePairingFile } from "./tls.mjs";
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
import { assertNoServe, hasProxyHints, readServeStatus } from "./exposure-safety.mjs";
import { listenHosts } from "./bind.mjs";
import { relayRequestAllowed, trustedRelayHosts } from "./request-safety.mjs";
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
  "WARNING: --lan is Tailscale-only. Both devices must use the same trusted tailnet; never proxy or forward this relay onto a home or public network.";

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

export function parseArgs(argv) {
  const out = { lan: false, lanAddress: "", vault: "", data: "", port: null, tlsName: "", tlsCertFile: "", tlsKeyFile: "", pairingFile: "" };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--lan") out.lan = true;
    else if (arg === "--token") {
      throw new Error(
        "The token is not read from the command line. Set AIDANOS_RELAY_TOKEN or AIDANOS_RELAY_TOKEN_FILE.",
      );
    } else if (arg === "--lan-address") out.lanAddress = argv[(i += 1)] || "";
    else if (arg === "--tls-name") out.tlsName = argv[(i += 1)] || "";
    else if (arg === "--tls-cert-file") out.tlsCertFile = argv[(i += 1)] || "";
    else if (arg === "--tls-key-file") out.tlsKeyFile = argv[(i += 1)] || "";
    else if (arg === "--pairing-file") out.pairingFile = argv[(i += 1)] || "";
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

export function startupLines({ lan, port, phone, tlsName }) {
  const lines = ["LISTENING 127.0.0.1 " + port];
  if (lan) lines.push(LAN_WARNING);
  if (phone) {
    if (!tlsName) throw new Error("Production sync requires TLS.");
    lines.push("PHONE wss://" + tlsName + ":" + port);
  }
  return lines;
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
  // Loopback is a bind scope, not proof that the caller is local or unproxied.
  assertNoServe(() => readServeStatus(env));
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
  const tls = await loadRelayTLS({ name: options.tlsName || env.AIDANOS_RELAY_TLS_NAME || "",
    certFile: options.tlsCertFile || env.AIDANOS_RELAY_TLS_CERT_FILE || "", keyFile: options.tlsKeyFile || env.AIDANOS_RELAY_TLS_KEY_FILE || "",
    forbidden: [vault, dataDir] });
  const port = options.port == null ? portFromEnv(env) : Number(options.port);
  const { hosts, phone } = listenHosts({
    lan: Boolean(options.lan) || Boolean(options.lanAddress),
    interfaces: options.interfaces, env,
    choose: options.lanAddress || "",
  });
  if (options.pairingFile && !phone) throw new Error("Pairing output requires TLS and a daemon-confirmed Tailscale listener.");
  const gitUrl = String(options.gitUrl ?? env.AIDANOS_RELAY_GIT_URL ?? "").trim();
  const gitToken = String(options.gitToken ?? env.AIDANOS_RELAY_GIT_TOKEN ?? "").trim();
  const secrets = [token, gitToken, gitUrl].filter(Boolean);
  const trustedHosts = trustedRelayHosts(env.AIDANOS_RELAY_TRUSTED_HOSTS);
  await assertNotClientVault(vault);
  await claimRelayFolders(vault, dataDir);
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
  const servers = [];
  let live = null;
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

  for (const host of hosts) {
    const handler = (req, res) => {
      if (hasProxyHints(req.headers) || !relayRequestAllowed(req, hosts, trustedHosts, tls.name)) {
        res.writeHead(403, { "content-length": 0 });
        res.end();
        return;
      }
      try { assertNoServe(() => readServeStatus(env)); } catch {
        res.writeHead(503, { "content-length": 0 }); res.end(); return;
      }
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
      res.writeHead(404, { "content-length": 0 });
      res.end();
    };
    const httpServer = https.createServer(tls.context, handler);
    const rawCap = options.maxPayload != null ? options.maxPayload : env.AIDANOS_MAX_PAYLOAD;
    const cap = payloadLimit(rawCap);
    const wss = new WebSocketServer({ noServer: true, maxPayload: cap });
    const entry = { httpServer, host, wss };
    httpServer.on("upgrade", (req, socket, head) => {
      if (hasProxyHints(req.headers) || !relayRequestAllowed(req, hosts, trustedHosts, tls.name)) {
        socket.end("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
        return;
      }
      try { assertNoServe(() => readServeStatus(env)); } catch {
        socket.end("HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"); return;
      }
      if (!live) {
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
        const addListener = ws.addListener.bind(ws);
        let rejectedFrame = false;
        function listen(event, handler) {
          if (event !== "message" || typeof handler !== "function") return addListener(event, handler);
          return addListener(event, function guarded(data, ...rest) {
            let allowed = false;
            try {
              allowed = syncFrameAllowed(data);
            } catch {
              allowed = false;
            }
            if (!allowed) {
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
        logSafe(secrets, "accepted a sync connection");
        entry.wss.emit("connection", ws, req);
      });
    });
    servers.push(entry);
  }

  live = await openSession();

  let boundPort = port;
  for (const entry of servers) {
    boundPort = await listen(entry.httpServer, entry.host, port);
  }

  const pairing = phone ? pairingRecord({ name: tls.name, ip: phone, port: boundPort, spki: tls.spki }) : null;
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

  api = {
    port: boundPort,
    url: "wss://127.0.0.1:" + boundPort,
    tlsName: tls.name, pairing,
    phone: phone ? "wss://" + tls.name + ":" + boundPort : null,
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
    healthURL: "https://127.0.0.1:" + boundPort + "/health",
    async close() {
      const session = live;
      live = null;
      if (session) session.mirror.stop();
      if (gitTimer) clearInterval(gitTimer);
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
  if (options.pairingFile) {
    try { await writePairingFile(options.pairingFile, pairing, [vault, dataDir]); }
    catch (error) { await api.close(); throw error; }
  }
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

async function main() {
  const needed = nodeRequirement();
  if (needed) {
    logSafe([], needed);
    process.exit(1);
  }
  const args = parseArgs(process.argv.slice(2));
  let relay;
  try {
    relay = await startRelay({
      tlsName: args.tlsName, tlsCertFile: args.tlsCertFile, tlsKeyFile: args.tlsKeyFile, pairingFile: args.pairingFile,
      lan: args.lan,
      lanAddress: args.lanAddress,
      vault: args.vault || undefined,
      data: args.data || undefined,
      port: args.port == null || Number.isNaN(args.port) ? undefined : args.port,
    });
  } catch (error) {
    logSafe(
      [process.env.AIDANOS_RELAY_TOKEN, process.env.AIDANOS_RELAY_GIT_TOKEN],
      error instanceof Error ? error.message : error,
    );
    process.exit(1);
  }
  for (const line of startupLines({ lan: args.lan || Boolean(args.lanAddress), port: relay.port, phone: relay.phone ? new URL(relay.phone).hostname : null, tlsName: relay.tlsName })) {
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
