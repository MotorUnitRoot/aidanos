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
import { planBudget } from "../src/budget.mjs";
import { INDEX_ID, noteId } from "../src/ids.mjs";
import { startRelay } from "../src/server.mjs";
import { writeStorageBytes } from "../src/storage-safe.mjs";

// node --test does not set this. Hooks exist only while it is "test".
if (!process.env.NODE_ENV) process.env.NODE_ENV = "test";

const TOKEN = "aidanos-test-token-0123456789abcdef";
const STORAGE_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

async function tempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), "relay-worker-"));
}

function joinFrame(senderId) {
  return encode({
    type: "join",
    senderId,
    supportedProtocolVersions: ["1"],
    peerMetadata: { storageId: STORAGE_ID, isEphemeral: false },
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
    AIDANOS_RELAY_TOKEN: TOKEN,
    AIDANOS_RELAY_ALLOW_RESET: "1",
    OTHER: "kept",
  });
  assert.equal(env.PATH, "/usr/bin");
  assert.equal(env.OTHER, "kept");
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
    assert.equal(seen.some((line) => line.includes("refused document " + id)), true);
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
    assert.equal(seen.some((line) => line.includes("mirror write refused")), true);
    assert.equal(seen.some((line) => line.includes("notes/hello.md")), false);
  } finally {
    console.error = write;
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
    const again = onceMessage(ws, (message) => message.type === "peer");
    ws.send(joinFrame("bad-1"));
    const message = await again;
    assert.equal(message.type, "peer");
    ws.close();
  } finally {
    await relay.close();
  }
});

test("a duplicate peer id closes the older socket", async () => {
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
    older.send(joinFrame("same-peer"));
    await firstPeer;
    const newer = await openSocket(relay.url);
    const secondPeer = onceMessage(newer, (message) => message.type === "peer");
    newer.send(joinFrame("same-peer"));
    await secondPeer;
    assert.equal(await closed, 1000);
    assert.equal(seen.some((line) => line.includes("closed the older sync connection for a duplicate peer id")), true);
    newer.close();
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
  process.env.AIDANOS_RELAY_TOKEN = TOKEN;
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
    assert.equal(text.includes("worker saw AIDANOS_ env"), false);
  } finally {
    console.error = write;
    if (previous == null) delete process.env.AIDANOS_RELAY_TOKEN;
    else process.env.AIDANOS_RELAY_TOKEN = previous;
    await relay.close();
  }
});

test("budget constants match the design", () => {
  assert.equal(PAUSE_BYTES, 8 * 1024 * 1024);
  assert.equal(CLOSE_BYTES, 16 * 1024 * 1024);
  assert.equal(GLOBAL_BYTES, 64 * 1024 * 1024);
  assert.equal(PAUSE_LIMIT_MS, 60_000);
});
