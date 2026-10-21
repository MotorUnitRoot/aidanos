import http from "node:http";
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
import { createMirror } from "./mirror.mjs";
import { logSafe } from "./redact.mjs";

const DEFAULT_PORT = 3750;
const MIN_TOKEN_LENGTH = 32;
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

function health(gitState) {
  return JSON.stringify({
    ok: true,
    git: gitState.status === "ok",
    gitStatus: gitState.status,
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

export function startupLines({ lan, port, phone }) {
  const lines = ["LISTENING 127.0.0.1 " + port];
  if (lan) lines.push(LAN_WARNING);
  if (phone) lines.push("PHONE ws://" + phone + ":" + port);
  return lines;
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
  await fs.mkdir(dataDir, { recursive: true });
  const guessLimit = Number(options.guessLimit ?? 5);
  const guessBlockMs = Number(options.guessBlockMs ?? 60_000);
  const failures = new Map();
  const gitState = { status: gitUrl ? "pending" : "off" };

  function clientAddress(req) {
    return (req.socket && req.socket.remoteAddress) || "";
  }

  function blocked(ip) {
    const row = failures.get(ip);
    return Boolean(row && row.until && Date.now() < row.until);
  }

  function noteFailure(ip) {
    const row = failures.get(ip) || { count: 0, until: 0 };
    row.count += 1;
    if (row.count >= guessLimit) row.until = Date.now() + guessBlockMs;
    failures.set(ip, row);
  }

  function noteGit(result) {
    if (!result) return;
    if (result.pushed) gitState.status = "ok";
    else if (result.committed && result.pushed === false) gitState.status = "failed";
  }

  const servers = [];
  const adapters = [];
  for (const host of hosts) {
    const httpServer = http.createServer((req, res) => {
      if (req.url === "/health") {
        const body = health(gitState);
        res.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
        res.end(body);
        return;
      }
      res.writeHead(404, { "content-length": 0 });
      res.end();
    });
    const wss = new WebSocketServer({ noServer: true, maxPayload: Number(options.maxPayload ?? 1_000_000) });
    const adapter = new NodeWSServerAdapter(wss);
    httpServer.on("upgrade", (req, socket, head) => {
      const ip = clientAddress(req);
      if (blocked(ip) || !tokensMatch(token, bearerToken(req.headers.authorization))) {
        if (!blocked(ip)) noteFailure(ip);
        logSafe(secrets, "rejected a sync connection");
        rejectUpgrade(socket);
        return;
      }
      failures.delete(ip);
      wss.handleUpgrade(req, socket, head, (ws) => {
        ws.on("error", (error) => {
          logSafe(secrets, "sync connection closed:", error instanceof Error ? error.message : error);
        });
        logSafe(secrets, "accepted a sync connection");
        wss.emit("connection", ws, req);
      });
    });
    servers.push({ httpServer, host, wss });
    adapters.push(adapter);
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

  return {
    port: boundPort,
    url: "ws://" + "127.0.0.1:" + boundPort,
    phone: phone ? "ws://" + phone + ":" + boundPort : null,
    hosts,
    vault,
    repo,
    token,
    async mirrorNow() {
      await mirror.now();
    },
    async backupNow() {
      return runBackup();
    },
    healthURL: "http://127.0.0.1:" + boundPort + "/health",
    async close() {
      mirror.stop();
      if (gitTimer) clearInterval(gitTimer);
      for (const entry of servers) {
        for (const ws of entry.wss.clients) ws.terminate();
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
      if (typeof repo.shutdown === "function") await repo.shutdown();
    },
  };
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
  const args = parseArgs(process.argv.slice(2));
  let relay;
  try {
    relay = await startRelay({
      lan: args.lan,
      lanAddress: args.lanAddress,
      vault: args.vault || undefined,
      data: args.data || undefined,
      port: args.port == null || Number.isNaN(args.port) ? undefined : args.port,
    });
  } catch (error) {
    logSafe(
      [process.env.AIDANOS_RELAY_TOKEN, process.env.AIDANOS_VAULT_GIT_TOKEN],
      error instanceof Error ? error.message : error,
    );
    process.exit(1);
  }
  for (const line of startupLines({ lan: args.lan || Boolean(args.lanAddress), port: relay.port, phone: relay.phone })) {
    if (line.startsWith("WARNING")) console.error(line);
    else console.log(line);
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
