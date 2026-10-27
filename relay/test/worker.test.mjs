import { spawn } from "node:child_process";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { Worker } from "node:worker_threads";
import * as Automerge from "@automerge/automerge";
import { decode, encode } from "@automerge/automerge-repo/helpers/cbor.js";
import WebSocket from "ws";
import {
  CLOSE_BYTES,
  GLOBAL_BYTES,
  PAUSE_BYTES,
  PAUSE_LIMIT_MS,
  acceptWorkerMessage,
  createLogBudget,
  frameToTransfer,
  LOG_FORWARD_CAP,
  trimmedWorkerEnv,
  workerExecArgv,
  workerTestHook,
} from "../src/channel.mjs";
import { LOG_LINE_CAP } from "../src/redact.mjs";
import { planBudget } from "../src/budget.mjs";
import { INDEX_ID, noteId } from "../src/ids.mjs";
import { startRelay } from "../src/server.mjs";
import { createWorkerHost } from "../src/worker-host.mjs";
import { writeStorageBytes } from "../src/storage-safe.mjs";

// node --test does not set this. Hooks exist only while it is "test".
if (!process.env.NODE_ENV) process.env.NODE_ENV = "test";

const TOKEN = "aidanos-test-token-0123456789abcdef";
const STORAGE_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

async function tempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), "relay-worker-"));
}

function joinFrame(senderId, extra = {}) {
  return encode({
    type: "join",
    senderId,
    supportedProtocolVersions: ["1"],
    peerMetadata: { storageId: STORAGE_ID, isEphemeral: false, ...extra },
  });
}

function requestFrame(senderId, documentId, payload) {
  return encode({
    type: "request",
    senderId,
    targetId: "aidanos-relay",
    documentId,
    data: payload || Buffer.from([1, 2, 3, 4]),
  });
}

function openSocket(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers: { Authorization: "Bearer " + TOKEN } });
    const timer = setTimeout(() => {
      ws.terminate();
      reject(new Error("socket open timed out"));
    }, 3000);
    ws.on("open", () => {
      clearTimeout(timer);
      resolve(ws);
    });
    ws.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

function onceMessage(ws, predicate, ms = 3000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off("message", onMessage);
      reject(new Error("message timed out"));
    }, ms);
    function onMessage(data) {
      let message;
      try {
        message = decode(data);
      } catch {
        return;
      }
      if (!predicate(message)) return;
      clearTimeout(timer);
      ws.off("message", onMessage);
      resolve(message);
    }
    ws.on("message", onMessage);
  });
}

function onceClose(ws, ms = 8000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("close timed out")), ms);
    ws.once("close", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

async function waitFor(predicate, ms, label) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(label || "timed out");
}

function waitLine(child, label, ms, stderr) {
  return new Promise((resolve, reject) => {
    let buf = "";
    const timer = setTimeout(() => {
      child.stdout.off("data", onData);
      reject(new Error(label + (stderr() ? "\n" + stderr() : "")));
    }, ms);
    function onData(chunk) {
      buf += chunk;
      if (buf.includes(label)) {
        clearTimeout(timer);
        child.stdout.off("data", onData);
        resolve(buf);
      }
    }
    child.stdout.on("data", onData);
  });
}

test("a copied frame keeps its bytes when the pool is reused", () => {
  const shared = new ArrayBuffer(64);
  const first = new Uint8Array(shared, 0, 32);
  const second = new Uint8Array(shared, 32, 32);
  first.fill(1);
  second.fill(2);
  const copyA = frameToTransfer(first);
  const copyB = frameToTransfer(second);
  first.fill(9);
  second.fill(8);
  assert.equal(copyA.byteLength, 32);
  assert.equal(copyB.byteLength, 32);
  assert.equal(new Uint8Array(copyA)[0], 1);
  assert.equal(new Uint8Array(copyB)[0], 2);
  assert.equal(new Uint8Array(copyA)[31], 1);
  assert.notEqual(copyA, shared);
  assert.notEqual(copyB, shared);
});

test("worker log lines are scrubbed and capped before they are forwarded", async () => {
  const dir = await tempDir();
  const vault = path.join(dir, "vault");
  const data = path.join(dir, "data");
  await fs.mkdir(vault);
  await fs.mkdir(data);
  const raw = "vault=/Users/ada/Vault/notes/secret.md " + "z".repeat(LOG_LINE_CAP);
  const lines = [];
  const host = createWorkerHost({
    vault,
    dataDir: data,
    peerId: "aidanos-relay",
    mirrorDebounceMs: 60_000,
    test: { testLogLine: raw },
    onLog(line) {
      lines.push(line);
    },
  });
  try {
    await host.start();
    const forwarded = lines.find((line) => line.includes("[truncated]"));
    assert.ok(forwarded, lines.join("\n"));
    assert.equal(forwarded.includes("/Users/ada"), false, forwarded);
    assert.equal(forwarded.includes("secret.md"), false, forwarded);
    assert.match(forwarded, /\[path\]/);
    assert.ok(Buffer.byteLength(forwarded) <= LOG_LINE_CAP + Buffer.byteLength("[truncated]"));
    assert.equal(workerTestHook({ testLogLine: raw }, { NODE_ENV: "production" }), null);
  } finally {
    await host.stop();
  }
});

test("worker log forwarding counts only bytes the parent has not taken", () => {
  assert.equal(LOG_FORWARD_CAP, 1024 * 1024);
  const budget = createLogBudget(100);
  const line = "y".repeat(60);
  assert.equal(budget.take(line), line);
  assert.equal(budget.pending, 60);
  assert.equal(budget.take(line), null);
  assert.equal(budget.dropped, 1);
  assert.equal(budget.pending, 60);
  const notice = budget.ack(60);
  assert.equal(notice, "1 lines dropped");
  assert.equal(budget.pending, Buffer.byteLength(notice));
  assert.equal(budget.take(line), line);
  assert.equal(budget.pending, Buffer.byteLength(notice) + 60);
  assert.equal(budget.take(line), null);
  assert.equal(budget.ack(60), null);
  const again = budget.take(line);
  assert.equal(again, line);
  assert.equal(budget.pending, Buffer.byteLength(notice) + 60);
  budget.unsent(again);
  assert.equal(budget.pending, Buffer.byteLength(notice));
  const huge = createLogBudget(10);
  assert.equal(huge.take("0123456789ABC"), null);
  assert.equal(huge.pending, 0);
  assert.equal(huge.dropped, 1);
});

test("worker messages with a bad id, kind, or close code are dropped", () => {
  const open = (id) => id === 4;
  assert.equal(acceptWorkerMessage({ v: 1, kind: "msg", conn: 9, data: new ArrayBuffer(1) }, open), "drop");
  assert.equal(acceptWorkerMessage({ v: 1, kind: "close", conn: 4, code: 1003 }, open), "drop");
  assert.equal(acceptWorkerMessage({ v: 1, kind: "close", conn: 4, code: 1008 }, open), "socket");
  assert.equal(acceptWorkerMessage({ v: 1, kind: "nope" }, open), "drop");
  assert.equal(acceptWorkerMessage({ v: 1, kind: "msg", conn: 4, data: Buffer.from([1]) }, open), "drop");
});

test("test hooks and the worker env stay off outside the test process", () => {
  assert.equal(workerTestHook({ testCrash: true, testBusyMs: 5000 }, { NODE_ENV: "production" }), null);
  assert.equal(workerTestHook({ testCrash: true }, { NODE_ENV: "test" }).crash, true);
  const env = trimmedWorkerEnv({
    PATH: "/usr/bin",
    HOME: "/home/ada",
    NODE_ENV: "test",
    AIDANOS_RELAY_TOKEN: TOKEN,
    AIDANOS_RELAY_ALLOW_RESET: "1",
    GITHUB_TOKEN: "ghp-secret",
    OTHER: "dropped",
  });
  assert.equal(env.PATH, "/usr/bin");
  assert.equal(env.HOME, "/home/ada");
  assert.equal(env.NODE_ENV, "test");
  assert.equal(env.OTHER, undefined);
  assert.equal(env.GITHUB_TOKEN, undefined);
  assert.equal(Object.keys(env).some((key) => key.startsWith("AIDANOS_")), false);
  assert.deepEqual(workerExecArgv({ CI: "" }, ["--cpu-prof", "--cpu-prof-dir", "/tmp/p"]), []);
  assert.deepEqual(
    workerExecArgv({ CI: "true" }, ["--cpu-prof", "--inspect", "--cpu-prof-dir", "/tmp/p"]),
    ["--cpu-prof", "--cpu-prof-dir", "/tmp/p"],
  );
});

test("the worker is a file next to the server and eval is off", async () => {
  const source = await fs.readFile(new URL("../src/worker-host.mjs", import.meta.url), "utf8");
  assert.match(source, /eval:\s*false/);
  assert.match(source, /new URL\("\.\/worker\.mjs", import\.meta\.url\)/);
  assert.match(source, /tidiness, not a wall/);
});

test("storage bytes are written with mode 0600 and a symlink is left untouched", async () => {
  const root = await tempDir();
  const file = path.join(root, "note");
  await writeStorageBytes(root, file, Buffer.from("first"));
  const info = await fs.stat(file);
  assert.equal(info.mode & 0o777, 0o600);
  assert.equal(await fs.readFile(file, "utf8"), "first");
  const target = path.join(root, "target");
  await fs.writeFile(target, "keep-me");
  const link = path.join(root, "link");
  await fs.symlink(target, link);
  await assert.rejects(writeStorageBytes(root, link, Buffer.from("nope")), /storage path refused/);
  assert.equal(await fs.readFile(target, "utf8"), "keep-me");
  assert.equal((await fs.lstat(link)).isSymbolicLink(), true);
  await writeStorageBytes(root, file, Buffer.from("second"));
  assert.equal(await fs.readFile(file, "utf8"), "second");
  const temps = (await fs.readdir(root)).filter((name) => name.startsWith(".tmp-"));
  assert.equal(temps.length, 0);
  const tmpDir = path.join(root, ".relay-tmp");
  const tmpInfo = await fs.lstat(tmpDir);
  assert.equal(tmpInfo.isDirectory(), true);
  assert.equal(tmpInfo.mode & 0o777, 0o700);
  const leftover = (await fs.readdir(tmpDir)).filter((name) => name.startsWith(".tmp-"));
  assert.equal(leftover.length, 0);
});

test("a symlinked storage folder is refused before markers are written", async () => {
  const dir = await tempDir();
  const real = path.join(dir, "real");
  await fs.mkdir(real);
  const data = path.join(dir, "data");
  await fs.symlink(real, data);
  await assert.rejects(
    startRelay({
      token: TOKEN,
      vault: path.join(dir, "vault"),
      data,
      port: 0,
      gitUrl: "",
    }),
    /storage path refused/,
  );
  assert.deepEqual(await fs.readdir(real), []);
});

test("two back-to-back frames arrive intact", async () => {
  const dir = await tempDir();
  const relay = await startRelay({
    token: TOKEN,
    vault: path.join(dir, "vault"),
    data: path.join(dir, "data"),
    port: 0,
    gitUrl: "",
    mirrorDebounceMs: 60_000,
    testEcho: true,
  });
  try {
    const ws = await openSocket(relay.url);
    const peer = onceMessage(ws, (message) => message.type === "peer");
    ws.send(joinFrame("echo-1"));
    await peer;
    const first = requestFrame("echo-1", noteId("notes/one.md"), Buffer.from("frame-one"));
    const second = requestFrame("echo-1", noteId("notes/two.md"), Buffer.from("frame-two-different"));
    ws.send(first);
    ws.send(second);
    await waitFor(() => relay.echoedFrames().length >= 2, 3000, "echoes");
    const echoes = relay.echoedFrames();
    assert.deepEqual(echoes[0], Buffer.from(first));
    assert.deepEqual(echoes[1], Buffer.from(second));
    ws.close();
  } finally {
    await relay.close();
  }
});

test("a busy worker still answers join and health, and the main thread stays under 200ms", async () => {
  const dir = await tempDir();
  const seen = [];
  const write = console.error;
  console.error = (text) => {
    seen.push(String(text));
    write(text);
  };
  const relay = await startRelay({
    token: TOKEN,
    vault: path.join(dir, "vault"),
    data: path.join(dir, "data"),
    port: 0,
    gitUrl: "",
    mirrorDebounceMs: 60_000,
    testBusyMs: 5000,
  });
  try {
    const first = await openSocket(relay.url);
    const peer = onceMessage(first, (message) => message.type === "peer");
    first.send(joinFrame("busy-1"));
    await peer;
    first.send(requestFrame("busy-1", noteId("notes/busy.md")));
    await waitFor(() => relay.workerHolding(), 3000, "the worker did not hold");
    const marked = seen.length;
    let maxLag = 0;
    const sampler = setInterval(() => {
      const started = performance.now();
      setTimeout(() => {
        maxLag = Math.max(maxLag, performance.now() - started - 20);
      }, 20);
    }, 20);
    const joinStarted = performance.now();
    const second = await openSocket(relay.url);
    const secondPeer = onceMessage(second, (message) => message.type === "peer");
    second.send(joinFrame("busy-2"));
    await secondPeer;
    const joinMs = performance.now() - joinStarted;
    const healthStarted = performance.now();
    const health = await fetch(relay.healthURL);
    const healthMs = performance.now() - healthStarted;
    const body = await health.json();
    assert.ok(joinMs < 1000, "join " + joinMs);
    assert.ok(healthMs < 1000, "health " + healthMs);
    assert.ok(health.status === 200 || health.status === 503);
    if (health.status === 503) {
      assert.ok(["warming", "worker silent", "worker crash loop"].includes(body.status), body.status);
    }
    await waitFor(() => relay.workerHolding() === false, 8000, "the hold did not end");
    clearInterval(sampler);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.ok(maxLag < 200, "lag " + maxLag);
    const late = seen.slice(marked).filter((line) => line.includes("event loop late") && line.includes("thread=main"));
    assert.equal(late.length, 0, late.join("\n"));
    first.close();
    second.close();
  } finally {
    console.error = write;
    await relay.close();
  }
});

test("a worker crash closes with 1011, restarts, and keeps the note", async () => {
  const dir = await tempDir();
  const vault = path.join(dir, "vault");
  const id = noteId("notes/keep.md");
  const relay = await startRelay({
    token: TOKEN,
    vault,
    data: path.join(dir, "data"),
    port: 0,
    gitUrl: "",
    mirrorDebounceMs: 60_000,
    testCrash: true,
  });
  try {
    relay.repo.import(Automerge.save(Automerge.from({ kind: "index", paths: { "notes/keep.md": id } })), { docId: INDEX_ID });
    relay.repo.import(Automerge.save(Automerge.from({ kind: "note", text: "whole note" })), { docId: id });
    await relay.mirrorNow();
    await relay.repo.flush();
    assert.equal(await fs.readFile(path.join(vault, "notes", "keep.md"), "utf8"), "whole note");
    const ws = await openSocket(relay.url);
    const peer = onceMessage(ws, (message) => message.type === "peer");
    const closed = onceClose(ws);
    ws.send(joinFrame("crash-1"));
    await peer;
    ws.send(requestFrame("crash-1", id));
    assert.equal(await closed, 1011);
    await waitFor(async () => (await fetch(relay.healthURL)).status !== 200, 3000, "health stayed up");
    await waitFor(async () => (await fetch(relay.healthURL)).status === 200, 8000, "worker did not restart");
    const handle = await relay.repo.find(id);
    assert.equal(handle.doc().text, "whole note");
    assert.equal(await fs.readFile(path.join(vault, "notes", "keep.md"), "utf8"), "whole note");
  } finally {
    await relay.close();
  }
});

test("two crashes on one document refuse later frames for it", async () => {
  const dir = await tempDir();
  const seen = [];
  const write = console.error;
  console.error = (text) => seen.push(String(text));
  const id = noteId("notes/poison.md");
  const relay = await startRelay({
    token: TOKEN,
    vault: path.join(dir, "vault"),
    data: path.join(dir, "data"),
    port: 0,
    gitUrl: "",
    mirrorDebounceMs: 60_000,
    testCrash: true,
  });
  try {
    for (let n = 0; n < 2; n += 1) {
      await waitFor(async () => (await fetch(relay.healthURL)).status === 200, 8000, "not ready");
      const ws = await openSocket(relay.url);
      const peer = onceMessage(ws, (message) => message.type === "peer");
      const closed = onceClose(ws);
      ws.send(joinFrame("poison-" + n));
      await peer;
      ws.send(requestFrame("poison-" + n, id));
      assert.equal(await closed, 1011);
    }
    await waitFor(async () => (await fetch(relay.healthURL)).status === 200, 8000, "not ready after crashes");
    const third = await openSocket(relay.url);
    const peer = onceMessage(third, (message) => message.type === "peer");
    const closed = onceClose(third);
    third.send(joinFrame("poison-2"));
    await peer;
    third.send(requestFrame("poison-2", id));
    assert.equal(await closed, 1008);
    const health = await fetch(relay.healthURL);
    const body = await health.json();
    assert.equal(health.status, 200);
    assert.equal(body.status, "ok");
    assert.equal(relay.refusedDocs().includes(id), true);
    const poison = seen.filter((line) => line.includes("poison document"));
    assert.ok(poison.length >= 1, seen.join("\n"));
    assert.equal(poison.some((line) => line.includes(id)), false, poison.join("\n"));
  } finally {
    console.error = write;
    await relay.close();
  }
});

test("five worker crashes in ten minutes stay down", async () => {
  const dir = await tempDir();
  const relay = await startRelay({
    token: TOKEN,
    vault: path.join(dir, "vault"),
    data: path.join(dir, "data"),
    port: 0,
    gitUrl: "",
    mirrorDebounceMs: 60_000,
    testCrashOnBoot: true,
  });
  try {
    await waitFor(async () => {
      const response = await fetch(relay.healthURL);
      if (response.status === 200) return false;
      const body = await response.json();
      return body.status === "worker crash loop";
    }, 40_000, "crash loop did not stick");
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const again = await fetch(relay.healthURL);
    const body = await again.json();
    assert.equal(again.status, 503);
    assert.equal(body.status, "worker crash loop");
    assert.equal(body.status.includes("/"), false);
  } finally {
    await relay.close();
  }
});

test("a worker out of memory does not take down the accept thread", async () => {
  const dir = await tempDir();
  const relay = await startRelay({
    token: TOKEN,
    vault: path.join(dir, "vault"),
    data: path.join(dir, "data"),
    port: 0,
    gitUrl: "",
    mirrorDebounceMs: 60_000,
    testOom: true,
  });
  try {
    const ws = await openSocket(relay.url);
    const peer = onceMessage(ws, (message) => message.type === "peer");
    const closed = onceClose(ws, 15000);
    ws.send(joinFrame("oom-1"));
    await peer;
    ws.send(requestFrame("oom-1", noteId("notes/oom.md")));
    assert.equal(await closed, 1011);
    const during = await fetch(relay.healthURL);
    assert.ok(during.status === 200 || during.status === 503);
    await waitFor(async () => (await fetch(relay.healthURL)).status === 200, 15000, "worker did not return");
  } finally {
    await relay.close();
  }
});

test("a mirror write onto a symlink or a hard link is refused", async () => {
  const dir = await tempDir();
  const vault = path.join(dir, "vault");
  const seen = [];
  const write = console.error;
  console.error = (text) => seen.push(String(text));
  const id = noteId("notes/hello.md");
  const relay = await startRelay({
    token: TOKEN,
    vault,
    data: path.join(dir, "data"),
    port: 0,
    gitUrl: "",
    mirrorDebounceMs: 60_000,
  });
  try {
    relay.repo.import(Automerge.save(Automerge.from({ kind: "index", paths: { "notes/hello.md": id } })), { docId: INDEX_ID });
    const handle = relay.repo.import(Automerge.save(Automerge.from({ kind: "note", text: "Hello" })), { docId: id });
    await relay.mirrorNow();
    const file = path.join(vault, "notes", "hello.md");
    const linked = path.join(vault, "notes", "also.md");
    await fs.link(file, linked);
    handle.change((doc) => {
      Automerge.updateText(doc, ["text"], "Hello changed");
    });
    await relay.mirrorNow();
    assert.equal(await fs.readFile(file, "utf8"), "Hello");
    assert.equal(await fs.readFile(linked, "utf8"), "Hello");
    assert.ok((await fs.stat(file)).nlink > 1);
    await fs.unlink(linked);
    const target = path.join(dir, "outside.txt");
    await fs.writeFile(target, "secret-target");
    await fs.unlink(file);
    await fs.symlink(target, file);
    await relay.mirrorNow();
    assert.equal(await fs.readFile(target, "utf8"), "secret-target");
    assert.equal((await fs.lstat(file)).isSymbolicLink(), true);
    assert.equal(seen.some((line) => line.includes("mirror failed for " + id)), true, seen.join("\n"));
    assert.equal(seen.some((line) => line.includes("notes/hello.md")), false);
  } finally {
    console.error = write;
    await relay.close();
  }
});

test("the mirror poll writes a note without an explicit flush", async () => {
  const dir = await tempDir();
  const vault = path.join(dir, "vault");
  const id = noteId("notes/polled.md");
  const relay = await startRelay({
    token: TOKEN,
    vault,
    data: path.join(dir, "data"),
    port: 0,
    gitUrl: "",
    mirrorDebounceMs: 50,
  });
  try {
    relay.repo.import(Automerge.save(Automerge.from({ kind: "index", paths: { "notes/polled.md": id } })), { docId: INDEX_ID });
    relay.repo.import(Automerge.save(Automerge.from({ kind: "note", text: "from the poll" })), { docId: id });
    const file = path.join(vault, "notes", "polled.md");
    await waitFor(async () => {
      const text = await fs.readFile(file, "utf8").catch(() => "");
      return text === "from the poll";
    }, 3000, "the poll did not write the note");
  } finally {
    await relay.close();
  }
});

test("a mirror failure does not kill the worker", async () => {
  const dir = await tempDir();
  const vault = path.join(dir, "vault");
  const seen = [];
  const write = console.error;
  console.error = (text) => seen.push(String(text));
  const id = noteId("notes/hello.md");
  const relay = await startRelay({
    token: TOKEN,
    vault,
    data: path.join(dir, "data"),
    port: 0,
    gitUrl: "",
    mirrorDebounceMs: 60_000,
  });
  try {
    relay.repo.import(Automerge.save(Automerge.from({ kind: "index", paths: { "notes/hello.md": id } })), { docId: INDEX_ID });
    const handle = relay.repo.import(Automerge.save(Automerge.from({ kind: "note", text: "Hello" })), { docId: id });
    await relay.mirrorNow();
    const record = path.join(vault, ".aidanos", "written.json");
    await fs.rm(record, { force: true });
    await fs.mkdir(record);
    handle.change((doc) => {
      Automerge.updateText(doc, ["text"], "Hello changed");
    });
    await relay.mirrorNow();
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(seen.some((line) => line.includes("worker fatal")), false);
    assert.equal(seen.some((line) => line.includes("mirror failed")), true);
    assert.equal((await fetch(relay.healthURL)).status, 200);
    await fs.rm(record, { recursive: true, force: true });
    handle.change((doc) => {
      Automerge.updateText(doc, ["text"], "Hello restored");
    });
    await relay.mirrorNow();
    assert.equal(await fs.readFile(path.join(vault, "notes", "hello.md"), "utf8"), "Hello restored");
  } finally {
    console.error = write;
    await relay.close();
  }
});

test("a save-wait timeout unlinks a temp the worker still holds", async () => {
  const dir = await tempDir();
  const vault = path.join(dir, "vault");
  const body = "whole-note-line\n".repeat(256);
  const relay = await startRelay({
    token: TOKEN,
    vault,
    data: path.join(dir, "data"),
    port: 0,
    gitUrl: "",
    mirrorDebounceMs: 60_000,
    testHoldNoteMs: 8000,
    env: { ...process.env, NODE_ENV: "test", AIDANOS_RELAY_TEST_SAVE_WAIT_MS: "300" },
  });
  try {
    await waitFor(async () => {
      const names = await fs.readdir(vault);
      return names.some((name) => name.endsWith(".tmp"));
    }, 5000, "worker temp");
    const result = await relay.stopAcceptingAndDrainSaves();
    assert.equal(result, "timeout");
    const names = await fs.readdir(vault);
    assert.equal(names.some((name) => name.endsWith(".tmp")), false, names.join(","));
    let note = "";
    try {
      note = await fs.readFile(path.join(vault, "held-note.md"), "utf8");
    } catch (error) {
      if (!error || error.code !== "ENOENT") throw error;
    }
    assert.notEqual(note, body);
  } finally {
    await relay.close();
  }
});

test("shutdown asks the worker to finish an in-flight save", async () => {
  const dir = await tempDir();
  const vault = path.join(dir, "vault");
  const relay = await startRelay({
    token: TOKEN,
    vault,
    data: path.join(dir, "data"),
    port: 0,
    gitUrl: "",
    mirrorDebounceMs: 60_000,
    testSaveHoldMs: 400,
  });
  try {
    const id = noteId("notes/held.md");
    relay.repo.import(Automerge.save(Automerge.from({ kind: "index", paths: { "notes/held.md": id } })), { docId: INDEX_ID });
    const handle = relay.repo.import(Automerge.save(Automerge.from({ kind: "note", text: "Hello" })), { docId: id });
    await relay.mirrorNow();
    assert.equal(await fs.readFile(path.join(vault, "notes", "held.md"), "utf8"), "Hello");
    handle.change((doc) => {
      Automerge.updateText(doc, ["text"], "Hello finished");
    });
    const started = Date.now();
    await Promise.all([relay.mirrorNow(), relay.stopAcceptingAndDrainSaves()]);
    const elapsed = Date.now() - started;
    assert.ok(elapsed >= 300, "drain returned in " + elapsed + "ms");
    assert.equal(await fs.readFile(path.join(vault, "notes", "held.md"), "utf8"), "Hello finished");
  } finally {
    await relay.close();
  }
});

test("the directory helper works from a worker thread", async () => {
  const dir = await tempDir();
  const reply = await new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./probes/dirfd-worker.mjs", import.meta.url), {
      workerData: { dir },
    });
    const timer = setTimeout(() => {
      worker.terminate();
      reject(new Error("dirfd worker timed out"));
    }, 5000);
    worker.once("message", (msg) => {
      clearTimeout(timer);
      resolve(msg);
    });
    worker.once("error", reject);
  });
  assert.equal(reply.ok, true);
  assert.match(reply.link, /relay-worker-/);
  assert.equal(await fs.readFile(path.join(dir, "from-worker.txt"), "utf8"), "from-worker");
});

test("the byte budget pauses the biggest senders and closes a flood", () => {
  const now = 10_000;
  const paused = planBudget([{ id: 1, bytes: PAUSE_BYTES, paused: false }], now);
  assert.deepEqual(paused.close, []);
  assert.deepEqual(paused.pause, [1]);
  const closed = planBudget([{ id: 1, bytes: CLOSE_BYTES, paused: false }], now);
  assert.deepEqual(closed.close, [1]);
  const stale = planBudget([{ id: 2, bytes: 10, paused: true, pausedAt: now - PAUSE_LIMIT_MS }], now);
  assert.deepEqual(stale.close, [2]);
  // Each sender stays under the 8 MB pause and the 16 MB close.
  // Together they pass 64 MB, so the biggest are paused and an idle socket is not.
  const mb = 1024 * 1024;
  const entries = [
    { id: "big", bytes: 7 * mb + 500_000, paused: false },
    { id: "mid", bytes: 7 * mb, paused: false },
    { id: "idle", bytes: 0, paused: false },
  ];
  for (let n = 0; n < 10; n += 1) entries.push({ id: "s" + n, bytes: 6 * mb, paused: false });
  const global = planBudget(entries, now);
  const total = entries.reduce((sum, entry) => sum + entry.bytes, 0);
  assert.ok(total > GLOBAL_BYTES);
  assert.equal(global.close.length, 0);
  assert.deepEqual(global.pause, ["big", "mid"]);
  assert.equal(global.pause.includes("idle"), false);
  const stillOpen = total - (7 * mb + 500_000) - 7 * mb;
  assert.ok(stillOpen <= GLOBAL_BYTES);
});

test("pausing a flooding socket stops the process from buffering the rest", async () => {
  const dir = await tempDir();
  const relay = await startRelay({
    token: TOKEN,
    vault: path.join(dir, "vault"),
    data: path.join(dir, "data"),
    port: 0,
    gitUrl: "",
    mirrorDebounceMs: 60_000,
    testBusyMs: 8000,
  });
  let child = null;
  try {
    const ws = await openSocket(relay.url);
    const peer = onceMessage(ws, (message) => message.type === "peer");
    ws.send(joinFrame("flood-hold"));
    await peer;
    ws.send(requestFrame("flood-hold", noteId("notes/hold.md")));
    await waitFor(() => relay.workerHolding(), 3000, "hold");
    child = spawn(process.execPath, [new URL("./probes/flood-client.mjs", import.meta.url).pathname], {
      cwd: path.join(import.meta.dirname, ".."),
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        FLOOD_URL: relay.url,
        FLOOD_TOKEN: TOKEN,
        FLOOD_STORAGE: STORAGE_ID,
        FLOOD_DOC: noteId("notes/flood.md"),
        FLOOD_PAYLOAD: String(2 * 1024 * 1024),
        FLOOD_PRIME: "4",
        FLOOD_EXTRA: "16",
      },
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    await waitLine(child, "primed", 5000, () => stderr);
    await waitFor(() => relay.pausedSockets().length > 0, 3000, "not paused");
    const before = process.memoryUsage().rss;
    child.stdin.write("go\n");
    await waitLine(child, "flooded", 5000, () => stderr);
    await new Promise((resolve) => setTimeout(resolve, 300));
    const growth = process.memoryUsage().rss - before;
    assert.ok(relay.pausedSockets().length > 0, "pause did not hold");
    assert.ok(growth < 20 * 1024 * 1024, "rss grew " + growth);
    ws.close();
  } finally {
    if (child) child.kill("SIGKILL");
    await relay.close();
  }
});

test("three flooding sockets leave a fourth able to sync", async () => {
  const dir = await tempDir();
  const relay = await startRelay({
    token: TOKEN,
    vault: path.join(dir, "vault"),
    data: path.join(dir, "data"),
    port: 0,
    gitUrl: "",
    mirrorDebounceMs: 60_000,
    testBusyMs: 4000,
  });
  const sockets = [];
  try {
    const payload = Buffer.alloc(3 * 1024 * 1024, 3);
    for (let n = 0; n < 3; n += 1) {
      const ws = await openSocket(relay.url);
      sockets.push(ws);
      const peer = onceMessage(ws, (message) => message.type === "peer");
      ws.send(joinFrame("flood-" + n));
      await peer;
      const frame = requestFrame("flood-" + n, noteId("notes/flood-" + n + ".md"), payload);
      ws.send(frame);
      ws.send(frame);
      ws.send(frame);
    }
    await waitFor(
      () => relay.pausedSockets().length > 0 || sockets.some((ws) => ws.readyState === WebSocket.CLOSED),
      4000,
      "flood was not limited",
    );
    const fourth = await openSocket(relay.url);
    sockets.push(fourth);
    const peer = onceMessage(fourth, (message) => message.type === "peer", 5000);
    fourth.send(joinFrame("ok-4"));
    const message = await peer;
    assert.equal(message.type, "peer");
    const local = Automerge.from({ kind: "index", paths: {} });
    let syncState = Automerge.initSyncState();
    const [next, syncMessage] = Automerge.generateSyncMessage(local, syncState);
    syncState = next;
    const id = noteId("notes/fourth.md");
    fourth.send(encode({
      type: "request",
      senderId: "ok-4",
      targetId: message.senderId,
      documentId: id,
      data: syncMessage,
    }));
    const answer = await onceMessage(
      fourth,
      (entry) => entry.type === "sync" || entry.type === "request" || entry.type === "doc-unavailable",
      12_000,
    );
    assert.equal(typeof answer.type, "string");
  } finally {
    for (const ws of sockets) {
      try { ws.close(); } catch { /* already closed */ }
    }
    await relay.close();
  }
});

test("a bad worker message is dropped and the socket stays up", async () => {
  const dir = await tempDir();
  const relay = await startRelay({
    token: TOKEN,
    vault: path.join(dir, "vault"),
    data: path.join(dir, "data"),
    port: 0,
    gitUrl: "",
    mirrorDebounceMs: 60_000,
    testBadChannel: true,
  });
  try {
    const ws = await openSocket(relay.url);
    const peer = onceMessage(ws, (message) => message.type === "peer");
    ws.send(joinFrame("bad-1"));
    await peer;
    ws.send(requestFrame("bad-1", noteId("notes/bad.md")));
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(ws.readyState, WebSocket.OPEN);
    ws.send(requestFrame("bad-1", noteId("notes/other.md")));
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(ws.readyState, WebSocket.OPEN);
    ws.close();
  } finally {
    await relay.close();
  }
});

test("a duplicate peer id keeps the existing device", async () => {
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
    mirrorDebounceMs: 60_000,
  });
  try {
    const older = await openSocket(relay.url);
    const firstPeer = onceMessage(older, (message) => message.type === "peer");
    older.send(joinFrame("same-peer"));
    await firstPeer;
    const newer = await openSocket(relay.url);
    const closed = onceClose(newer);
    newer.send(joinFrame("same-peer"));
    assert.equal(await closed, 1008);
    assert.equal(older.readyState, WebSocket.OPEN);
    assert.equal(seen.some((line) => line.includes("kept the existing device for a duplicate peer id")), true);
    older.close();
  } finally {
    console.error = write;
    await relay.close();
  }
});

test("logs do not include the relay token", async () => {
  const dir = await tempDir();
  const seen = [];
  const write = console.error;
  console.error = (text) => seen.push(String(text));
  const previous = process.env.AIDANOS_RELAY_TOKEN;
  const previousGithub = process.env.GITHUB_TOKEN;
  process.env.AIDANOS_RELAY_TOKEN = TOKEN;
  process.env.GITHUB_TOKEN = "ghp-test-secret";
  const relay = await startRelay({
    token: TOKEN,
    vault: path.join(dir, "vault"),
    data: path.join(dir, "data"),
    port: 0,
    gitUrl: "",
    mirrorDebounceMs: 60_000,
  });
  try {
    const ws = await openSocket(relay.url);
    const peer = onceMessage(ws, (message) => message.type === "peer");
    ws.send(joinFrame("quiet"));
    await peer;
    ws.close();
    const text = seen.join("\n");
    assert.equal(text.includes(TOKEN), false);
    assert.equal(text.includes("ghp-test-secret"), false);
    assert.equal(text.includes("worker saw secret env"), false);
  } finally {
    console.error = write;
    if (previous == null) delete process.env.AIDANOS_RELAY_TOKEN;
    else process.env.AIDANOS_RELAY_TOKEN = previous;
    if (previousGithub == null) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = previousGithub;
    await relay.close();
  }
});

test("a second join on the same socket is closed", async () => {
  const dir = await tempDir();
  const relay = await startRelay({
    token: TOKEN,
    vault: path.join(dir, "vault"),
    data: path.join(dir, "data"),
    port: 0,
    gitUrl: "",
    mirrorDebounceMs: 60_000,
  });
  try {
    const ws = await openSocket(relay.url);
    const peer = onceMessage(ws, (message) => message.type === "peer");
    const closed = onceClose(ws);
    ws.send(joinFrame("once"));
    await peer;
    ws.send(joinFrame("twice"));
    assert.equal(await closed, 1008);
  } finally {
    await relay.close();
  }
});

test("the same device token replaces the older socket", async () => {
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
    mirrorDebounceMs: 60_000,
  });
  try {
    const older = await openSocket(relay.url);
    const firstPeer = onceMessage(older, (message) => message.type === "peer");
    const closed = onceClose(older);
    older.send(joinFrame("same-peer", { deviceToken: "device-token-1" }));
    await firstPeer;
    const newer = await openSocket(relay.url);
    const secondPeer = onceMessage(newer, (message) => message.type === "peer");
    newer.send(joinFrame("same-peer", { deviceToken: "device-token-1" }));
    await secondPeer;
    assert.equal(await closed, 1000);
    assert.equal(newer.readyState, WebSocket.OPEN);
    assert.equal(seen.some((line) => line.includes("closed the older sync connection for a duplicate peer id")), true);
    newer.close();
  } finally {
    console.error = write;
    await relay.close();
  }
});

async function waitReady(relay) {
  await waitFor(async () => (await fetch(relay.healthURL)).status === 200, 12_000, "not ready");
}

async function waitDown(relay) {
  await waitFor(async () => (await fetch(relay.healthURL)).status !== 200, 12_000, "did not crash");
}

async function crashRequest(relay, sender, id) {
  await waitReady(relay);
  const ws = await openSocket(relay.url);
  const peer = onceMessage(ws, (message) => message.type === "peer");
  const closed = onceClose(ws, 12_000);
  ws.send(joinFrame(sender));
  await peer;
  ws.send(requestFrame(sender, id));
  assert.equal(await closed, 1011);
  await waitDown(relay);
}

async function assertKeptAndOtherSyncs(relay, seen, id) {
  await waitReady(relay);
  assert.equal(relay.refusedDocs().includes(id), true);
  const poison = seen.filter((line) => line.includes("poison document"));
  assert.ok(poison.length >= 1, seen.join("\n"));
  assert.equal(poison.some((line) => line.includes(id)), false);
  const health = await fetch(relay.healthURL);
  const body = await health.json();
  assert.equal(health.status, 200);
  assert.equal(body.status, "ok");
  const bad = await openSocket(relay.url);
  const badPeer = onceMessage(bad, (message) => message.type === "peer");
  const badClosed = onceClose(bad);
  bad.send(joinFrame("after-bad"));
  await badPeer;
  bad.send(requestFrame("after-bad", id));
  assert.equal(await badClosed, 1008);
  const other = noteId("notes/other-ok.md");
  const ws = await openSocket(relay.url);
  const peer = onceMessage(ws, (message) => message.type === "peer");
  ws.send(joinFrame("after-ok"));
  await peer;
  const answer = onceMessage(
    ws,
    (entry) => entry.type === "sync" || entry.type === "request" || entry.type === "doc-unavailable",
    12_000,
  );
  ws.send(requestFrame("after-ok", other));
  const message = await answer;
  assert.equal(typeof message.type, "string");
  const again = await fetch(relay.healthURL);
  const againBody = await again.json();
  assert.equal(again.status, 200);
  assert.equal(againBody.status, "ok");
  ws.close();
}

test("a crash on the next tick refuses that document and leaves another syncing", async () => {
  const dir = await tempDir();
  const seen = [];
  const write = console.error;
  console.error = (text) => seen.push(String(text));
  const id = noteId("notes/delay.md");
  const relay = await startRelay({
    token: TOKEN,
    vault: path.join(dir, "vault"),
    data: path.join(dir, "data"),
    port: 0,
    gitUrl: "",
    mirrorDebounceMs: 60_000,
    testCrashDelay: "immediate",
    testCrashDoc: id,
  });
  try {
    await crashRequest(relay, "delay-0", id);
    await crashRequest(relay, "delay-1", id);
    await assertKeptAndOtherSyncs(relay, seen, id);
    assert.equal(seen.some((line) => line.includes("worker crash loop")), false);
  } finally {
    console.error = write;
    await relay.close();
  }
});

test("a crash after a timer refuses that document and leaves another syncing", async () => {
  const dir = await tempDir();
  const seen = [];
  const write = console.error;
  console.error = (text) => seen.push(String(text));
  const id = noteId("notes/timer.md");
  const relay = await startRelay({
    token: TOKEN,
    vault: path.join(dir, "vault"),
    data: path.join(dir, "data"),
    port: 0,
    gitUrl: "",
    mirrorDebounceMs: 60_000,
    testCrashDelay: "timer",
    testCrashDoc: id,
  });
  try {
    await crashRequest(relay, "timer-0", id);
    await crashRequest(relay, "timer-1", id);
    await assertKeptAndOtherSyncs(relay, seen, id);
    assert.equal(seen.some((line) => line.includes("worker crash loop")), false);
  } finally {
    console.error = write;
    await relay.close();
  }
});

test("a crash inside the storage save refuses that document", async () => {
  const dir = await tempDir();
  const seen = [];
  const write = console.error;
  console.error = (text) => seen.push(String(text));
  const id = noteId("notes/save.md");
  const relay = await startRelay({
    token: TOKEN,
    vault: path.join(dir, "vault"),
    data: path.join(dir, "data"),
    port: 0,
    gitUrl: "",
    mirrorDebounceMs: 60_000,
    testCrashSave: true,
    testCrashDoc: id,
  });
  try {
    for (let n = 0; n < 2; n += 1) {
      await waitReady(relay);
      try {
        await relay.repo.import(Automerge.save(Automerge.from({ kind: "note", text: "save-" + n })), { docId: id });
      } catch {
        // The worker exits inside the save.
      }
      await waitDown(relay);
    }
    await assertKeptAndOtherSyncs(relay, seen, id);
    assert.equal(seen.some((line) => line.includes("worker crash loop")), false);
  } finally {
    console.error = write;
    await relay.close();
  }
});

test("a busy worker crash mid-request and mid-save charges the document", async () => {
  const dir = await tempDir();
  const seen = [];
  const write = console.error;
  console.error = (text) => seen.push(String(text));
  const id = noteId("notes/busy-crash.md");
  const relay = await startRelay({
    token: TOKEN,
    vault: path.join(dir, "vault"),
    data: path.join(dir, "data"),
    port: 0,
    gitUrl: "",
    mirrorDebounceMs: 60_000,
    testCrashBusy: "request",
    testCrashDoc: id,
  });
  try {
    await crashRequest(relay, "busy-req", id);
    assert.equal(relay.refusedDocs().includes(id), false);
    const health = await (async () => {
      await waitReady(relay);
      return fetch(relay.healthURL);
    })();
    assert.equal(health.status, 200);
  } finally {
    console.error = write;
    await relay.close();
  }
  const saveDir = await tempDir();
  const saveSeen = [];
  console.error = (text) => saveSeen.push(String(text));
  const saveRelay = await startRelay({
    token: TOKEN,
    vault: path.join(saveDir, "vault"),
    data: path.join(saveDir, "data"),
    port: 0,
    gitUrl: "",
    mirrorDebounceMs: 60_000,
    testCrashBusy: "save",
    testCrashDoc: id,
  });
  try {
    await waitReady(saveRelay);
    try {
      await saveRelay.repo.import(Automerge.save(Automerge.from({ kind: "note", text: "busy-save" })), { docId: id });
    } catch {
      // The worker exits during the save spin.
    }
    await waitDown(saveRelay);
    await waitReady(saveRelay);
    const body = await (await fetch(saveRelay.healthURL)).json();
    assert.equal(body.status, "ok");
    assert.equal(saveSeen.some((line) => line.includes("worker crash loop")), false);
  } finally {
    console.error = write;
    await saveRelay.close();
  }
});

test("growing ArrayBuffer and Automerge memory trips the rss watchdog", async () => {
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
    mirrorDebounceMs: 60_000,
    testWasmOom: true,
    testRssHeadroom: 32 * 1024 * 1024,
  });
  try {
    await waitFor(() => seen.some((line) => line.includes("worker rss")), 20_000, "rss watchdog did not fire");
    await waitReady(relay);
    const health = await fetch(relay.healthURL);
    const body = await health.json();
    assert.equal(health.status, 200);
    assert.equal(body.status, "ok");
    const ws = await openSocket(relay.url);
    const peer = onceMessage(ws, (message) => message.type === "peer", 8000);
    ws.send(joinFrame("after-rss"));
    await peer;
    ws.close();
  } finally {
    console.error = write;
    await relay.close();
  }
});

test("a worker that stops answering pings is restarted", async () => {
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
    mirrorDebounceMs: 60_000,
    testHang: true,
  });
  try {
    await waitFor(
      () => seen.some((line) => /worker exited code=\d+, restart in \d+ms/.test(line)),
      20_000,
      "heartbeat did not restart the worker",
    );
    assert.equal(seen.some((line) => line.includes("worker heartbeat")), true);
  } finally {
    console.error = write;
    await relay.close();
  }
});

test("a torn storage temp is ignored and the index doc still loads", async () => {
  const dir = await tempDir();
  const vault = path.join(dir, "vault");
  const data = path.join(dir, "data");
  const id = noteId("notes/keep.md");
  const full = "index-note-survives";
  const first = await startRelay({
    token: TOKEN,
    vault,
    data,
    port: 0,
    gitUrl: "",
    mirrorDebounceMs: 60_000,
  });
  first.repo.import(Automerge.save(Automerge.from({ kind: "index", paths: { "notes/keep.md": id } })), { docId: INDEX_ID });
  first.repo.import(Automerge.save(Automerge.from({ kind: "note", text: full })), { docId: id });
  await first.repo.flush();
  await first.close();
  async function plant(directory) {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) await plant(fullPath);
    }
    await fs.writeFile(path.join(directory, ".tmp-999999-deadbeef"), Buffer.from("torn"));
  }
  await plant(data);
  const live = path.join(data, ".tmp-" + process.pid + "-aa");
  await fs.writeFile(live, Buffer.from("live-temp"));
  const second = await startRelay({
    token: TOKEN,
    vault,
    data,
    port: 0,
    gitUrl: "",
    mirrorDebounceMs: 60_000,
  });
  try {
    const index = await second.repo.find(INDEX_ID);
    assert.equal(index.doc().paths["notes/keep.md"], id);
    const note = await second.repo.find(id);
    assert.equal(note.doc().text, full);
    await assert.rejects(fs.lstat(path.join(data, ".relay-tmp", ".tmp-999999-deadbeef")), { code: "ENOENT" });
    const still = await fs.readFile(live, "utf8");
    assert.equal(still, "live-temp");
  } finally {
    await second.close();
  }
});

test("a recovery sibling is not folded into the shared note", async () => {
  const dir = await tempDir();
  const vault = path.join(dir, "vault");
  const seen = [];
  const write = console.error;
  console.error = (text) => seen.push(String(text));
  const id = noteId("notes/keep.md");
  const full = "version-one-" + "abc".repeat(40);
  const first = await startRelay({
    token: TOKEN,
    vault,
    data: path.join(dir, "data"),
    port: 0,
    gitUrl: "",
    mirrorDebounceMs: 60_000,
  });
  first.repo.import(Automerge.save(Automerge.from({ kind: "index", paths: { "notes/keep.md": id } })), { docId: INDEX_ID });
  first.repo.import(Automerge.save(Automerge.from({ kind: "note", text: full })), { docId: id });
  await first.mirrorNow();
  await first.repo.flush();
  await first.close();
  const file = path.join(vault, "notes", "keep.md");
  await fs.writeFile(file, "torn");
  await fs.writeFile(file + ".1.ab.recover", full);
  const second = await startRelay({
    token: TOKEN,
    vault,
    data: path.join(dir, "data"),
    port: 0,
    gitUrl: "",
    mirrorDebounceMs: 60_000,
  });
  try {
    const handle = await second.repo.find(id);
    assert.equal(handle.doc().text, full);
    assert.equal(seen.some((line) => line.includes("fold-in failed for " + id + " RECOVER")), true, seen.join("\n"));
    assert.equal(seen.some((line) => line.includes("keep.md")), false, seen.join("\n"));
  } finally {
    console.error = write;
    await second.close();
  }
});

test("budget constants match the design", () => {
  assert.equal(PAUSE_BYTES, 8 * 1024 * 1024);
  assert.equal(CLOSE_BYTES, 16 * 1024 * 1024);
  assert.equal(GLOBAL_BYTES, 64 * 1024 * 1024);
  assert.equal(PAUSE_LIMIT_MS, 60_000);
});
