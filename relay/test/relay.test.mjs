import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import crypto from "node:crypto";
import net from "node:net";
import { promisify } from "node:util";
import { WebSocket } from "ws";
import * as Automerge from "@automerge/automerge";
import { INDEX_ID, noteId } from "../src/ids.mjs";
import { isPrivateIPv4, listenHosts } from "../src/bind.mjs";
import { logSafe, redact, stampLine } from "../src/redact.mjs";
import { cbor } from "@automerge/automerge-repo";
import { describeSyncFrame, logSyncFrame } from "../src/sync-log.mjs";
import { LAN_WARNING, MAX_PAYLOAD, loadToken, nodeRequirement, parseArgs, startRelay, startupLines } from "../src/server.mjs";

const TOKEN = "aidanos-test-token-0123456789abcdef";

const exec = promisify(execFile);

async function tempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), "aidanos-relay-"));
}

function git(args, cwd) {
  return exec("git", args, { cwd });
}

test("listen addresses stay on this computer unless --lan", () => {
  const interfaces = {
    lo: [{ family: "IPv4", internal: true, address: "127.0.0.1" }],
    en0: [{ family: "IPv4", internal: false, address: "192.168.1.20" }],
    danger: [{ family: "IPv4", internal: false, address: "203.0.113.8" }],
  };
  const local = listenHosts({ lan: false, interfaces });
  assert.deepEqual(local.hosts, ["127.0.0.1"]);
  assert.equal(local.phone, null);
  const lan = listenHosts({ lan: true, interfaces });
  assert.deepEqual(lan.hosts, ["127.0.0.1", "192.168.1.20"]);
  assert.equal(lan.phone, "192.168.1.20");
  assert.equal(lan.hosts.includes("0.0.0.0"), false);
  assert.equal(isPrivateIPv4("10.1.2.3"), true);
  assert.equal(isPrivateIPv4("172.16.0.1"), true);
  assert.equal(isPrivateIPv4("172.32.0.1"), false);
  assert.throws(() => listenHosts({ lan: true, interfaces: { lo: interfaces.lo } }), /private network address/);
  const home = listenHosts({
    lan: true,
    interfaces: {
      utun0: [{ family: "IPv4", internal: false, address: "10.8.0.2" }],
      en0: [{ family: "IPv4", internal: false, address: "192.168.1.20" }],
    },
  });
  assert.equal(home.phone, "192.168.1.20");
  const chosen = listenHosts({
    lan: true,
    choose: "10.8.0.2",
    interfaces: { utun0: [{ family: "IPv4", internal: false, address: "10.8.0.2" }] },
  });
  assert.equal(chosen.phone, "10.8.0.2");
});

test("every relay log line starts with a timestamp", () => {
  const stamped = stampLine("accepted a sync connection", new Date("2026-10-22T01:02:03.004Z"));
  assert.equal(stamped, "2026-10-22T01:02:03.004Z accepted a sync connection");
  const seen = [];
  const write = console.error;
  console.error = (line) => seen.push(line);
  try {
    logSafe([], "LISTENING 127.0.0.1 3757");
  } finally {
    console.error = write;
  }
  assert.match(seen[0], /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z LISTENING 127\.0\.0\.1 3757$/);
});

test("a sync frame log names the type, document, and heads", () => {
  let doc = Automerge.from({ text: "hello" });
  const heads = Automerge.getHeads(doc);
  const [, message] = Automerge.generateSyncMessage(doc, Automerge.initSyncState());
  assert.ok(message);
  const frame = cbor.encode({
    type: "request",
    senderId: "phone",
    targetId: "relay",
    documentId: "doc-1",
    data: message,
  });
  const line = describeSyncFrame("out", frame);
  assert.equal(line.startsWith("sync out request doc=doc-1 heads="), true);
  assert.equal(line.includes(String(heads[0])), true);
  const unavailable = cbor.encode({ type: "doc-unavailable", documentId: "doc-1", senderId: "relay" });
  assert.equal(describeSyncFrame("in", unavailable), "sync in doc-unavailable doc=doc-1");
  assert.equal(describeSyncFrame("out", cbor.encode({ type: "join", senderId: "phone" })), "sync out join");
  assert.equal(describeSyncFrame("in", cbor.encode({ type: "peer", senderId: "relay" })), "sync in peer");
  assert.equal(describeSyncFrame("in", Buffer.from([0xff, 0x00])), "");
  const seen = [];
  const write = console.error;
  console.error = (text) => seen.push(text);
  try {
    logSyncFrame("out", frame, []);
    logSyncFrame("in", Buffer.from([0xff]), []);
  } finally {
    console.error = write;
  }
  assert.equal(seen.length, 1);
  assert.match(seen[0], /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z sync out request doc=doc-1 heads=/);
});

test("an old Node gets a plain startup message", () => {
  assert.equal(nodeRequirement("22.14.0"), "");
  assert.equal(nodeRequirement("20.11.1"), "Node 22 or newer is needed.");
  assert.equal(nodeRequirement("18.0.0"), "Node 22 or newer is needed.");
});

test("redact removes the token and the git url", () => {
  const token = "super-secret-token-value";
  const text = "push failed https://x-access-token:" + token + "@github.com/acme/vault.git " + token;
  const cleaned = redact(text, [token, "https://github.com/acme/vault.git"]);
  assert.equal(cleaned, "push failed [url] ***");
  const short = redact("Authorization: Bearer a", []);
  assert.equal(short.includes("Bearer a"), false);
  const long = "q".repeat(64);
  assert.equal(redact("Bearer " + long, []).includes("q"), false);
});

test("relay rejects a bad token and accepts the real one", async () => {
  const dir = await tempDir();
  const relay = await startRelay({
    token: TOKEN,
    vault: path.join(dir, "vault"),
    data: path.join(dir, "data"),
    port: 0,
    gitUrl: "",
    mirrorDebounceMs: 1000,
  });
  try {
    const refused = await connect(relay.url, "wrong-token");
    assert.equal(refused.opened, false);
    assert.equal(refused.status, 401);
    const opened = await connect(relay.url, TOKEN);
    assert.equal(opened.opened, true);
    opened.socket.close();
  } finally {
    await relay.close();
  }
});

test("a bad frame does not stop the relay", async () => {
  const dir = await tempDir();
  const relay = await startRelay({
    token: TOKEN,
    vault: path.join(dir, "vault"),
    data: path.join(dir, "data"),
    port: 0,
    gitUrl: "",
    mirrorDebounceMs: 1000,
  });
  try {
    await sendUnmaskedPong(relay.port);
    const health = await fetch("http://127.0.0.1:" + relay.port + "/health");
    assert.equal(health.status, 200);
    const opened = await connect(relay.url, TOKEN);
    assert.equal(opened.opened, true);
    opened.socket.close();
  } finally {
    await relay.close();
  }
});

test("relay writes markdown and does not use git unless asked", async () => {
  const dir = await tempDir();
  const vault = path.join(dir, "vault");
  const relay = await startRelay({
    token: TOKEN,
    vault,
    data: path.join(dir, "data"),
    port: 0,
    gitUrl: "",
    mirrorDebounceMs: 20,
  });
  try {
    const id = noteId("notes/hello.md");
    importDoc(relay.repo, INDEX_ID, { kind: "index", paths: { "notes/hello.md": id } });
    const note = importDoc(relay.repo, id, { kind: "note", text: "Hello mirror" });
    await relay.mirrorNow();
    const written = await fs.readFile(path.join(vault, "notes", "hello.md"), "utf8");
    assert.equal(written, "Hello mirror");
    const backup = await relay.backupNow();
    assert.equal(backup.skipped, true);
    await fs.writeFile(path.join(vault, "notes", "hello.md"), "Hello from outside");
    await relay.mirrorNow();
    assert.equal(note.doc().text, "Hello from outside");
  } finally {
    await relay.close();
  }
});

test("git backup commits and pushes, and never pulls", async () => {
  const dir = await tempDir();
  const vault = path.join(dir, "vault");
  const bare = path.join(dir, "bare.git");
  const other = path.join(dir, "other");
  await git(["init", "--bare", "-b", "main", bare]);
  await fs.mkdir(other, { recursive: true });
  await git(["init", "-b", "main"], other);
  await git(["config", "user.name", "Other"], other);
  await git(["config", "user.email", "other@local"], other);
  await fs.writeFile(path.join(other, "other.md"), "from the other side\n");
  await git(["add", "other.md"], other);
  await git(["commit", "-m", "other"], other);
  await git(["remote", "add", "origin", bare], other);
  await git(["push", "origin", "HEAD:refs/heads/main"], other);

  const token = "super-secret-token-value";
  const relay = await startRelay({
    token: TOKEN,
    vault,
    data: path.join(dir, "data"),
    port: 0,
    gitUrl: bare,
    gitToken: token,
    gitIntervalMs: 0,
  });
  try {
    await fs.mkdir(vault, { recursive: true });
    await fs.writeFile(path.join(vault, "notes.md"), "local note\n");
    const result = await relay.backupNow();
    assert.equal(result.skipped, false);
    assert.equal(result.committed, true);
    assert.equal(result.pushed, false);
    const log = await git(["-C", vault, "log", "--oneline"]);
    assert.equal(log.stdout.includes("other"), false);
    assert.match(log.stdout, /Backup notes/);
    await assert.rejects(fs.stat(path.join(vault, "other.md")));
    const config = await fs.readFile(path.join(vault, ".git", "config"), "utf8");
    assert.equal(config.includes(token), false);
    assert.equal(config.includes("x-access-token"), false);
    const health = await fetch(relay.healthURL);
    const body = await health.json();
    assert.equal(body.gitStatus, "failed");
  } finally {
    await relay.close();
  }
});

test("a fresh backup pushes to an empty repo", async () => {
  const dir = await tempDir();
  const vault = path.join(dir, "vault");
  const bare = path.join(dir, "empty.git");
  await git(["init", "--bare", "-b", "main", bare]);
  const relay = await startRelay({
    token: TOKEN,
    vault,
    data: path.join(dir, "data"),
    port: 0,
    gitUrl: bare,
    gitIntervalMs: 0,
  });
  try {
    await fs.writeFile(path.join(vault, "day.md"), "today\n");
    const result = await relay.backupNow();
    assert.equal(result.pushed, true);
    const listed = await git(["--git-dir", bare, "log", "--oneline", "main"]);
    assert.match(listed.stdout, /Backup notes/);
    const ignore = await fs.readFile(path.join(vault, ".gitignore"), "utf8");
    assert.match(ignore, /\.aidanos\//);
  } finally {
    await relay.close();
  }
});

test("relay refuses an app vault", async () => {
  const dir = await tempDir();
  const vault = path.join(dir, "vault");
  await fs.mkdir(path.join(vault, ".aidanos"), { recursive: true });
  await fs.writeFile(path.join(vault, ".aidanos", "actor"), Buffer.from([1]));
  await assert.rejects(
    startRelay({ token: TOKEN, vault, data: path.join(dir, "data"), port: 0, gitUrl: "" }),
    /app vault/,
  );
});

test("relay refuses .git/config", async () => {
  const dir = await tempDir();
  const vault = path.join(dir, "vault");
  const relay = await startRelay({
    token: TOKEN,
    vault,
    data: path.join(dir, "data"),
    port: 0,
    gitUrl: "",
    mirrorDebounceMs: 1000,
  });
  try {
    const evil = noteId(".git/config");
    const ok = noteId("notes/ok.md");
    importDoc(relay.repo, INDEX_ID, { kind: "index", paths: { ".git/config": evil, "notes/ok.md": ok } });
    importDoc(relay.repo, evil, { kind: "note", text: "[core]\n" });
    importDoc(relay.repo, ok, { kind: "note", text: "safe" });
    await relay.mirrorNow();
    await assert.rejects(fs.stat(path.join(vault, ".git", "config")));
    assert.equal(await fs.readFile(path.join(vault, "notes", "ok.md"), "utf8"), "safe");
  } finally {
    await relay.close();
  }
});

test("restart keeps a newer note instead of the old file", async () => {
  const dir = await tempDir();
  const vault = path.join(dir, "vault");
  const data = path.join(dir, "data");
  const id = noteId("notes/hello.md");
  const first = await startRelay({
    token: TOKEN,
    vault,
    data,
    port: 0,
    gitUrl: "",
    mirrorDebounceMs: 1000,
  });
  importDoc(first.repo, INDEX_ID, { kind: "index", paths: { "notes/hello.md": id } });
  importDoc(first.repo, id, { kind: "note", text: "Hello" });
  await first.mirrorNow();
  assert.equal(await fs.readFile(path.join(vault, "notes", "hello.md"), "utf8"), "Hello");
  await first.close();

  const second = await startRelay({
    token: TOKEN,
    vault,
    data,
    port: 0,
    gitUrl: "",
    mirrorDebounceMs: 1000,
  });
  try {
    await second.repo.find(INDEX_ID);
    const handle = await second.repo.find(id);
    handle.change((doc) => {
      Automerge.updateText(doc, ["text"], "Hello PHONE");
    });
    await second.mirrorNow();
    assert.equal(await fs.readFile(path.join(vault, "notes", "hello.md"), "utf8"), "Hello PHONE");
  } finally {
    await second.close();
  }
});

test("token is read from the environment or a 0600 file, never the command line", async () => {
  assert.throws(() => parseArgs(["--token", TOKEN]), /command line/);
  const dir = await tempDir();
  const file = path.join(dir, "token");
  await fs.writeFile(file, TOKEN + "\n", { mode: 0o644 });
  await assert.rejects(loadToken({ AIDANOS_RELAY_TOKEN_FILE: file }), /0600/);
  await fs.chmod(file, 0o600);
  assert.equal(await loadToken({ AIDANOS_RELAY_TOKEN_FILE: file }), TOKEN);
  await assert.rejects(loadToken({ AIDANOS_RELAY_TOKEN: "too-short" }), /32/);
  const lines = startupLines({ lan: true, port: 3750, phone: "ws://192.168.1.20:3750" });
  assert.equal(lines.includes(LAN_WARNING), true);
  assert.match(LAN_WARNING, /no encryption/);
  assert.match(LAN_WARNING, /token is the only protection/);
});

test("too many bad tokens are refused", async () => {
  const dir = await tempDir();
  const relay = await startRelay({
    token: TOKEN,
    vault: path.join(dir, "vault"),
    data: path.join(dir, "data"),
    port: 0,
    gitUrl: "",
    guessLimit: 2,
    guessBlockMs: 60_000,
    mirrorDebounceMs: 1000,
  });
  try {
    assert.equal((await connect(relay.url, "nope")).status, 401);
    assert.equal((await connect(relay.url, "nope")).status, 401);
    const blocked = await connect(relay.url, TOKEN);
    assert.equal(blocked.opened, false);
    assert.equal(blocked.status, 401);
  } finally {
    await relay.close();
  }
});

test("an edit while the relay is stopped merges with an offline change", async () => {
  const dir = await tempDir();
  const vault = path.join(dir, "vault");
  const data = path.join(dir, "data");
  const id = noteId("notes/hello.md");
  const first = await startRelay({
    token: TOKEN,
    vault,
    data,
    port: 0,
    gitUrl: "",
    mirrorDebounceMs: 1000,
  });
  assert.equal(await fs.readFile(path.join(vault, ".aidanos", "relay-folder"), "utf8"), "relay\n");
  assert.equal(await fs.readFile(path.join(data, "relay-folder"), "utf8"), "relay\n");
  importDoc(first.repo, INDEX_ID, { kind: "index", paths: { "notes/hello.md": id } });
  importDoc(first.repo, id, { kind: "note", text: "Hello" });
  await first.mirrorNow();
  const saved = Automerge.save((await first.repo.find(id)).doc());
  await first.close();

  await fs.writeFile(path.join(vault, "notes", "hello.md"), "Hello MAC");
  const second = await startRelay({
    token: TOKEN,
    vault,
    data,
    port: 0,
    gitUrl: "",
    mirrorDebounceMs: 1000,
  });
  try {
    const handle = await second.repo.find(id);
    assert.equal(handle.doc().text, "Hello MAC");
    let phone = Automerge.load(saved);
    phone = Automerge.change(phone, (doc) => {
      Automerge.splice(doc, ["text"], 5, 0, " PHONE");
    });
    handle.update((doc) => Automerge.merge(doc, phone));
    const text = handle.doc().text;
    assert.ok(["Hello MAC PHONE", "Hello PHONE MAC"].includes(text), text);
    await second.mirrorNow();
    assert.equal(await fs.readFile(path.join(vault, "notes", "hello.md"), "utf8"), text);
  } finally {
    await second.close();
  }
});

test("a blocked address can try again after the block expires", async () => {
  const dir = await tempDir();
  const relay = await startRelay({
    token: TOKEN,
    vault: path.join(dir, "vault"),
    data: path.join(dir, "data"),
    port: 0,
    gitUrl: "",
    guessLimit: 1,
    guessBlockMs: 80,
    mirrorDebounceMs: 1000,
  });
  try {
    assert.equal((await connect(relay.url, "nope")).status, 401);
    const blocked = await connect(relay.url, TOKEN);
    assert.equal(blocked.opened, false);
    assert.equal(blocked.status, 401);
    await new Promise((resolve) => setTimeout(resolve, 150));
    const again = await connect(relay.url, TOKEN);
    assert.equal(again.opened, true);
    again.socket.close();
  } finally {
    await relay.close();
  }
});

test("an outside edit keeps a device change that arrived in the same moment", async () => {
  const dir = await tempDir();
  const vault = path.join(dir, "vault");
  const data = path.join(dir, "data");
  const id = noteId("notes/hello.md");
  const relay = await startRelay({
    token: TOKEN,
    vault,
    data,
    port: 0,
    gitUrl: "",
    mirrorDebounceMs: 60_000,
  });
  try {
    importDoc(relay.repo, INDEX_ID, { kind: "index", paths: { "notes/hello.md": id } });
    importDoc(relay.repo, id, { kind: "note", text: "Hello" });
    await relay.mirrorNow();
    assert.equal(await fs.readFile(path.join(vault, "notes", "hello.md"), "utf8"), "Hello");
    const handle = await relay.repo.find(id);
    handle.change((doc) => {
      Automerge.splice(doc, ["text"], 5, 0, " PHONE3");
    });
    assert.equal(handle.doc().text, "Hello PHONE3");
    await fs.writeFile(path.join(vault, "notes", "hello.md"), "Hello MAC");
    await relay.mirrorNow();
    const text = handle.doc().text;
    assert.equal(text.includes("PHONE3"), true, text);
    assert.equal(text.includes("MAC"), true, text);
    assert.equal(await fs.readFile(path.join(vault, "notes", "hello.md"), "utf8"), text);
  } finally {
    await relay.close();
  }
});

test("the relay message cap is 32 MB", async () => {
  assert.equal(MAX_PAYLOAD, 32 * 1024 * 1024);
  const dir = await tempDir();
  const relay = await startRelay({
    token: TOKEN,
    vault: path.join(dir, "vault"),
    data: path.join(dir, "data"),
    port: 0,
    gitUrl: "",
    mirrorDebounceMs: 1000,
  });
  try {
    const result = await new Promise((resolve) => {
      const ws = new WebSocket(relay.url, { headers: { Authorization: "Bearer " + TOKEN } });
      ws.on("open", () => {
        ws.send(Buffer.alloc(2_000_000, 7));
      });
      ws.on("close", (code) => resolve({ code }));
      ws.on("error", () => {});
      setTimeout(() => {
        const open = ws.readyState === WebSocket.OPEN;
        ws.close();
        resolve({ code: open ? 0 : ws.readyState });
      }, 800);
    });
    assert.notEqual(result.code, 1009);
    const health = await fetch(relay.healthURL);
    assert.equal(health.status, 200);
  } finally {
    await relay.close();
  }
});

test("the try-it guide keeps the token off the command line", async () => {
  const text = await fs.readFile(new URL("../../docs/native/TRY-IT.md", import.meta.url), "utf8");
  assert.equal(text.includes("printf"), false);
  assert.equal(text.includes("AIDANOS_RELAY_TOKEN="), false);
  assert.equal(text.includes("paste-your-long-token"), false);
  const readAt = text.indexOf("read -s");
  const editAt = text.indexOf("TextEdit");
  assert.equal(readAt >= 0 && editAt > readAt, true);
  assert.match(text, /Make Plain Text/);
  assert.match(text, /If no extension is provided, use \.txt/);
});

test("an oversized frame does not stop the relay", async () => {
  const dir = await tempDir();
  const relay = await startRelay({
    token: TOKEN,
    vault: path.join(dir, "vault"),
    data: path.join(dir, "data"),
    port: 0,
    gitUrl: "",
    maxPayload: 64,
    mirrorDebounceMs: 1000,
  });
  try {
    await new Promise((resolve) => {
      const ws = new WebSocket(relay.url, { headers: { Authorization: "Bearer " + TOKEN } });
      const done = () => resolve();
      ws.on("open", () => ws.send(Buffer.alloc(200, 1)));
      ws.on("close", done);
      ws.on("error", () => {});
      setTimeout(done, 1000);
    });
    const health = await fetch(relay.healthURL);
    assert.equal(health.status, 200);
  } finally {
    await relay.close();
  }
});

test("the relay logs the handshake it sends and receives", async () => {
  const dir = await tempDir();
  const seen = [];
  const write = console.error;
  console.error = (text) => seen.push(String(text));
  const relay = await startRelay({
    token: TOKEN,
    vault: path.join(dir, "vault"),
    data: path.join(dir, "data"),
    port: 0,
    gitUrl: "",
    mirrorDebounceMs: 1000,
  });
  try {
    const join = cbor.encode({
      type: "join",
      senderId: "phone-1",
      supportedProtocolVersions: ["1"],
      peerMetadata: { storageId: "storage-1", isEphemeral: false },
    });
    await new Promise((resolve, reject) => {
      const ws = new WebSocket(relay.url, { headers: { Authorization: "Bearer " + TOKEN } });
      const timer = setTimeout(() => reject(new Error("no peer")), 3000);
      ws.on("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      ws.on("open", () => ws.send(join));
      ws.on("message", () => {
        clearTimeout(timer);
        ws.close();
        resolve();
      });
    });
  } finally {
    console.error = write;
    await relay.close();
  }
  const text = seen.join("\n");
  assert.match(text, /sync in join/);
  assert.match(text, /sync out peer/);
});

function importDoc(repo, docId, value) {
  return repo.import(Automerge.save(Automerge.from(value)), { docId });
}

test("reset is off unless a supervisor asked for it", async () => {
  const dir = await tempDir();
  const relay = await startRelay({
    token: TOKEN,
    vault: path.join(dir, "vault"),
    data: path.join(dir, "data"),
    port: 0,
    gitUrl: "",
  });
  try {
    const hidden = await fetch(relay.healthURL.replace("/health", "/reset"), { method: "POST" });
    assert.equal(hidden.status, 404);
  } finally {
    await relay.close();
  }
});

test("an allowed reset checks the token and empties the folder", async () => {
  const dir = await tempDir();
  const vault = path.join(dir, "vault");
  let resets = 0;
  const relay = await startRelay({
    token: TOKEN,
    vault,
    data: path.join(dir, "data"),
    port: 0,
    gitUrl: "",
    allowReset: true,
    onReset: () => {
      resets += 1;
    },
  });
  try {
    const health = await fetch(relay.healthURL);
    const body = await health.json();
    assert.equal(typeof body.bootedAt, "string");
    const id = noteId("notes/reset.md");
    await importDoc(relay.repo, id, { kind: "note", text: "secret-before-reset" });
    await relay.repo.flush();
    const previous = relay.repo;
    await fs.mkdir(path.join(vault, "notes"), { recursive: true });
    await fs.writeFile(path.join(vault, "notes", "hello.md"), "still here");
    await fs.writeFile(path.join(vault, "leftover.txt"), "still here");
    const denied = await fetch(relay.healthURL.replace("/health", "/reset"), {
      method: "POST",
      headers: { Authorization: "Bearer nope" },
    });
    assert.equal(denied.status, 401);
    assert.equal(resets, 0);
    const accepted = await fetch(relay.healthURL.replace("/health", "/reset"), {
      method: "POST",
      headers: { Authorization: "Bearer " + TOKEN },
    });
    assert.equal(accepted.status, 200);
    assert.deepEqual(await accepted.json(), { ok: true, resetting: true });
    const deadline = Date.now() + 5000;
    let booted = body.bootedAt;
    while (Date.now() < deadline && booted === body.bootedAt) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      const again = await fetch(relay.healthURL + "?n=" + Date.now());
      booted = (await again.json()).bootedAt;
    }
    assert.notEqual(booted, body.bootedAt);
    assert.equal(resets, 1);
    assert.notEqual(relay.repo, previous);
    await assert.rejects(fs.stat(path.join(vault, "leftover.txt")));
    await assert.rejects(fs.stat(path.join(vault, "notes", "hello.md")));
    assert.equal(await relay.repo.storageSubsystem.loadDoc(id), null);
    const opened = await Promise.race([
      connect(relay.url, TOKEN),
      new Promise((_, reject) => setTimeout(() => reject(new Error("connect timed out")), 2000)),
    ]);
    assert.equal(opened.opened, true);
    opened.socket.close();
  } finally {
    await relay.close();
  }
});

function sendUnmaskedPong(port) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1");
    const key = crypto.randomBytes(16).toString("base64");
    let seenHeader = false;
    socket.on("error", reject);
    socket.on("connect", () => {
      socket.write(
        "GET / HTTP/1.1\r\n" +
          "Host: 127.0.0.1:" + port + "\r\n" +
          "Upgrade: websocket\r\n" +
          "Connection: Upgrade\r\n" +
          "Sec-WebSocket-Key: " + key + "\r\n" +
          "Sec-WebSocket-Version: 13\r\n" +
          "Authorization: Bearer " + TOKEN + "\r\n\r\n",
      );
    });
    socket.on("data", (chunk) => {
      if (seenHeader) return;
      if (!chunk.toString("utf8").includes("\r\n\r\n")) return;
      seenHeader = true;
      socket.write(Buffer.from([0x8a, 0x00]));
      setTimeout(() => {
        socket.destroy();
        resolve();
      }, 50);
    });
  });
}

function connect(url, token) {
  return new Promise((resolve) => {
    const ws = new WebSocket(url, {
      headers: { Authorization: "Bearer " + token },
    });
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    ws.on("open", () => finish({ opened: true, socket: ws, status: 101 }));
    ws.on("unexpected-response", (_req, res) => {
      res.resume();
      finish({ opened: false, status: res.statusCode, socket: ws });
    });
    ws.on("error", () => finish({ opened: false, status: 0, socket: ws }));
  });
}
