import http from "node:http";
import { writeSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { timingSafeEqual } from "node:crypto";
import { pathToFileURL } from "node:url";
import { WebSocketServer } from "ws";
import { Repo } from "@automerge/automerge-repo";
import { NodeWSServerAdapter } from "@automerge/automerge-repo-network-websocket";
import { NodeFSStorageAdapter } from "@automerge/automerge-repo-storage-nodefs";
import { listenHosts } from "./bind.mjs";
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

export function bearerToken(header) {
  const match = String(header || "").match(/^Bearer\s+(\S+)\s*$/i);
  return match ? match[1] : "";
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

function health(gitState, bootedAt) {
  return JSON.stringify({
    ok: true,
    git: gitState.status === "ok",
    gitStatus: gitState.status,
    bootedAt,
  });
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
  const fromEnv = String(env.AIDANOS_RELAY_TOKEN || "").trim();
  const file = String(env.AIDANOS_RELAY_TOKEN_FILE || "").trim();
  if (fromEnv && file) {
    throw new Error("Set only one of AIDANOS_RELAY_TOKEN and AIDANOS_RELAY_TOKEN_FILE.");
  }
  let token = fromEnv;
  if (file) {
    const stat = await fs.stat(file);
    if ((stat.mode & 0o777) !== 0o600) {
      throw new Error("The token file must be readable only by you (mode 0600).");
    }
    token = String(await fs.readFile(file, "utf8")).trim();
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

async function emptyDirectory(dir) {
  const names = await fs.readdir(dir);
  await Promise.all(names.map((name) => fs.rm(path.join(dir, name), { recursive: true, force: true })));
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
  const token = String(options.token || "").trim() || (await loadToken(options.env || process.env));
  if (token.length < MIN_TOKEN_LENGTH) {
    throw new Error("The relay token must be at least 32 characters.");
  }
  const vault = path.resolve(options.vault || process.env.AIDANOS_VAULT || path.join(process.cwd(), "vault"));
  const dataDir = path.resolve(options.data || process.env.AIDANOS_RELAY_DATA || path.join(vault, ".aidanos", "relay"));
  const port = options.port == null ? portFromEnv() : Number(options.port);
  const { hosts, phone } = listenHosts({
    lan: Boolean(options.lan) || Boolean(options.lanAddress),
    interfaces: options.interfaces,
    choose: options.lanAddress || "",
  });
  const gitUrl = String(options.gitUrl ?? process.env.AIDANOS_VAULT_GIT_URL ?? "").trim();
  const gitToken = String(options.gitToken ?? process.env.AIDANOS_VAULT_GIT_TOKEN ?? "").trim();
  const secrets = [token, gitToken, gitUrl].filter(Boolean);
  await fs.mkdir(vault, { recursive: true });
  await assertNotClientVault(vault);
  await fs.mkdir(path.join(vault, ".aidanos"), { recursive: true });
  await fs.writeFile(path.join(vault, ".aidanos", "relay-folder"), "relay\n");
  await fs.mkdir(dataDir, { recursive: true });
  await fs.writeFile(path.join(dataDir, "relay-folder"), "relay\n");
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
    if (typeof session.repo.shutdown === "function") await session.repo.shutdown();
  }

  async function rotate() {
    await disposeSession(live);
    live = null;
    await emptyDirectory(vault);
    await emptyDirectory(dataDir);
    await fs.mkdir(path.join(vault, ".aidanos"), { recursive: true });
    await fs.writeFile(path.join(vault, ".aidanos", "relay-folder"), "relay\n");
    await fs.writeFile(path.join(dataDir, "relay-folder"), "relay\n");
    live = await openSession();
    bootedAt = new Date().toISOString();
    if (api) api.repo = live.repo;
    logSafe(secrets, "reset complete");
    if (typeof options.onReset === "function") options.onReset();
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
        const body = health(gitState, bootedAt);
        res.writeHead(200, {
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
        if (!tokensMatch(token, bearerToken(req.headers.authorization))) {
          res.writeHead(401, { "content-length": 0 });
          res.end();
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
        return;
      }
      res.writeHead(404, { "content-length": 0 });
      res.end();
    });
    const cap = Number(options.maxPayload ?? process.env.AIDANOS_MAX_PAYLOAD ?? MAX_PAYLOAD);
    const wss = new WebSocketServer({ noServer: true, maxPayload: cap });
    const entry = { httpServer, host, wss };
    httpServer.on("upgrade", (req, socket, head) => {
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

  const interval = gitInterval(options.gitIntervalMs);
  let gitTimer = null;
  async function runBackup() {
    try {
      const result = await backupOnce({ vault, gitUrl, gitToken, secrets });
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
      await resetChain.catch(() => {});
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

function portFromEnv() {
  if (process.env.AIDANOS_RELAY_PORT == null || process.env.AIDANOS_RELAY_PORT === "") return DEFAULT_PORT;
  return Number(process.env.AIDANOS_RELAY_PORT);
}

function gitInterval(override) {
  if (override != null) return Number(override);
  const raw = process.env.AIDANOS_VAULT_GIT_INTERVAL_MS;
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
      lan: args.lan,
      lanAddress: args.lanAddress,
      vault: args.vault || undefined,
      data: args.data || undefined,
      port: args.port == null || Number.isNaN(args.port) ? undefined : args.port,
      allowReset: process.env.AIDANOS_RELAY_ALLOW_RESET === "1",
    });
  } catch (error) {
    logSafe(
      [process.env.AIDANOS_RELAY_TOKEN, process.env.AIDANOS_VAULT_GIT_TOKEN],
      error instanceof Error ? error.message : error,
    );
    process.exit(1);
  }
  for (const line of startupLines({ lan: args.lan || Boolean(args.lanAddress), port: relay.port, phone: relay.phone })) {
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
