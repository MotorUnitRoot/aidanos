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
import { redact } from "../src/redact.mjs";
import { startRelay } from "../src/server.mjs";

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
});

test("redact removes the token and the git url", () => {
  const token = "super-secret-token-value";
  const text = "push failed https://x-access-token:" + token + "@github.com/acme/vault.git " + token;
  const cleaned = redact(text, [token, "https://github.com/acme/vault.git"]);
  assert.equal(cleaned.includes(token), false);
  assert.equal(cleaned.includes("github.com"), false);
});

test("relay rejects a bad token and accepts the real one", async () => {
  const dir = await tempDir();
  const relay = await startRelay({
    token: "aidanos-test-token",
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
    const opened = await connect(relay.url, "aidanos-test-token");
    assert.equal(opened.opened, true);
    opened.socket.close();
  } finally {
    await relay.close();
  }
});

test("a bad frame does not stop the relay", async () => {
  const dir = await tempDir();
  const relay = await startRelay({
    token: "aidanos-test-token",
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
    const opened = await connect(relay.url, "aidanos-test-token");
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
    token: "aidanos-test-token",
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
    token: "aidanos-test-token",
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
    token: "aidanos-test-token",
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

function importDoc(repo, docId, value) {
  return repo.import(Automerge.save(Automerge.from(value)), { docId });
}

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
          "Authorization: Bearer aidanos-test-token\r\n\r\n",
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
