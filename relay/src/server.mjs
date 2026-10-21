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

function health(gitEnabled) {
  return JSON.stringify({ ok: true, git: Boolean(gitEnabled) });
}

export function parseArgs(argv) {
  const out = { lan: false, token: "", vault: "", data: "", port: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--lan") out.lan = true;
    else if (arg === "--token") out.token = argv[(i += 1)] || "";
    else if (arg === "--vault") out.vault = argv[(i += 1)] || "";
    else if (arg === "--data") out.data = argv[(i += 1)] || "";
    else if (arg === "--port") out.port = Number(argv[(i += 1)]);
    else throw new Error("Unknown argument " + arg);
  }
  return out;
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
  const token = String(options.token || process.env.AIDANOS_RELAY_TOKEN || "").trim();
  if (!token) {
    throw new Error("Set AIDANOS_RELAY_TOKEN or pass --token. The relay will not start without one.");
  }
  const vault = path.resolve(options.vault || process.env.AIDANOS_VAULT || path.join(process.cwd(), "vault"));
  const dataDir = path.resolve(options.data || process.env.AIDANOS_RELAY_DATA || path.join(vault, ".aidanos", "relay"));
  const port = options.port == null ? portFromEnv() : Number(options.port);
  const { hosts, phone } = listenHosts({ lan: Boolean(options.lan), interfaces: options.interfaces });
  const gitUrl = String(options.gitUrl ?? process.env.AIDANOS_VAULT_GIT_URL ?? "").trim();
  const gitToken = String(options.gitToken ?? process.env.AIDANOS_VAULT_GIT_TOKEN ?? "").trim();
  const secrets = [token, gitToken, gitUrl].filter(Boolean);
  await fs.mkdir(vault, { recursive: true });
  await fs.mkdir(dataDir, { recursive: true });

  const servers = [];
  const adapters = [];
  for (const host of hosts) {
    const httpServer = http.createServer((req, res) => {
      if (req.url === "/health") {
        const body = health(gitUrl);
        res.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
        res.end(body);
        return;
      }
      res.writeHead(404, { "content-length": 0 });
      res.end();
    });
    const wss = new WebSocketServer({ noServer: true });
    const adapter = new NodeWSServerAdapter(wss);
    httpServer.on("upgrade", (req, socket, head) => {
      if (!tokensMatch(token, bearerToken(req.headers.authorization))) {
        logSafe(secrets, "rejected a sync connection");
        rejectUpgrade(socket);
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
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
  if (gitUrl && interval > 0) {
    gitTimer = setInterval(() => {
      backupOnce({ vault, gitUrl, gitToken, secrets }).catch((error) => {
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
      return backupOnce({ vault, gitUrl, gitToken, secrets });
    },
    async close() {
      mirror.stop();
      if (gitTimer) clearInterval(gitTimer);
      for (const entry of servers) entry.wss.close();
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
      token: args.token || process.env.AIDANOS_RELAY_TOKEN,
      vault: args.vault || undefined,
      data: args.data || undefined,
      port: args.port == null || Number.isNaN(args.port) ? undefined : args.port,
    });
  } catch (error) {
    logSafe(
      [process.env.AIDANOS_RELAY_TOKEN, process.env.AIDANOS_VAULT_GIT_TOKEN, args.token],
      error instanceof Error ? error.message : error,
    );
    process.exit(1);
  }
  console.log("LISTENING 127.0.0.1 " + relay.port);
  if (relay.phone) console.log("PHONE " + relay.phone);
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
