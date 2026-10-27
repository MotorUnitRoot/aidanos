import test from "node:test";
import assert from "node:assert/strict";
import { closeSync, constants as fsConstants, openSync, readSync, writeSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile, execFileSync, spawn } from "node:child_process";
import crypto from "node:crypto";
import net from "node:net";
import { once } from "node:events";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import * as Automerge from "@automerge/automerge";
import { INDEX_ID, noteId } from "../src/ids.mjs";
import {
  NOTE_TEMP_MANIFEST,
  foldInFailureLine,
  mirrorFailureLine,
  mirrorNoteFailureLine,
  rememberVaultRoot,
  saveNoteBatch,
  saveNoteFile,
  sweepStaleNoteTemps,
} from "../src/mirror.mjs";
import { isPrivateIPv4, listenHosts } from "../src/bind.mjs";
import { FATAL_FALLBACK_NAME, FILE_LOG_CAP, LOG_LINE_CAP, flushFileLog, installFileLog, logFatal, logSafe, pauseFileLog, redact, stampLine } from "../src/redact.mjs";
import { INDEX_TRACE_ENTRY_CAP, beginIndexRequest, emptyLateState, finishIndexReply, installIndexTrace, nextLoopLateLine, noteGitWork, noteMirror } from "../src/index-trace.mjs";
import { cbor } from "@automerge/automerge-repo";
import { describeSyncFrame, logSyncFrame } from "../src/sync-log.mjs";
import {
  LAN_WARNING,
  MAX_PAYLOAD,
  SAVE_WAIT_MS,
  SAVE_WAIT_TIMEOUT_LINE,
  SHUTDOWN_DEADLINE_MS,
  SHUTDOWN_TIMEOUT_LINE,
  SLOW_SAVE_NOTE_NAME,
  slowSaveNoteBody,
  loadToken,
  nodeRequirement,
  parseArgs,
  payloadLimit,
  relayIdFile,
  relayMarkerId,
  relayMarkerText,
  startRelay,
  startupLines,
  warmSyncEngine,
} from "../src/server.mjs";

const TOKEN = "aidanos-test-token-0123456789abcdef";

const exec = promisify(execFile);

async function tempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), "aidanos-relay-"));
}

async function realTempDir() {
  return fs.realpath(await tempDir());
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

test("a file log is not a synchronous stderr write", async () => {
  const dir = await tempDir();
  const file = path.join(dir, "relay.log");
  const fd = openSync(file, "a");
  const installed = installFileLog(fd);
  const finished = new Promise((resolve) => installed.stream.once("finish", resolve));
  try {
    logSafe([], "LISTENING 127.0.0.1 3757");
  } finally {
    installed.restore();
  }
  installed.stream.end();
  await finished;
  closeSync(fd);
  const text = await fs.readFile(file, "utf8");
  assert.match(text, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z LISTENING 127\.0\.0\.1 3757\n$/);
});

test("a refusal then exit leaves its reason in the stderr file", async () => {
  const dir = await tempDir();
  const file = path.join(dir, "stderr.log");
  const fd = openSync(file, "w");
  const server = fileURLToPath(new URL("../src/server.mjs", import.meta.url));
  const env = { ...process.env, AIDANOS_RELAY_TOKEN: "too-short" };
  delete env.AIDANOS_RELAY_TOKEN_FILE;
  const child = spawn(process.execPath, [server], {
    env,
    stdio: ["ignore", "ignore", fd],
  });
  const [code] = await once(child, "exit");
  closeSync(fd);
  assert.equal(code, 1);
  const text = await fs.readFile(file, "utf8");
  assert.match(text, /The relay token must be at least 32 characters\./);
});

test("a stalled log stays under the cap and drops the rest once", async () => {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const accepted = new Promise((resolve) => server.once("connection", resolve));
  const writer = net.connect(port, "127.0.0.1");
  const reader = await accepted;
  await once(writer, "connect");
  reader.pause();
  const fd = writer._handle.fd;
  const cap = 32 * 1024;
  const installed = installFileLog(fd, { cap });
  const chunks = [];
  reader.on("data", (chunk) => chunks.push(chunk));
  reader.on("error", () => {});
  try {
    const line = "x".repeat(200);
    for (let i = 0; i < 4000 && installed.dropped === 0; i += 1) logSafe([], line);
    assert.ok(installed.dropped > 0, "the cap was never hit");
    for (let i = 0; i < 200; i += 1) logSafe([], line);
    assert.ok(installed.stream.writableLength <= cap, "buffered " + installed.stream.writableLength);
    assert.ok(installed.held <= cap, "held " + installed.held);
    const dropped = installed.dropped;
    const finished = once(installed.stream, "finish");
    const ended = once(reader, "end");
    reader.resume();
    installed.restore();
    installed.stream.end();
    await finished;
    writer.end();
    await ended;
    const text = Buffer.concat(chunks).toString("utf8");
    const notices = text.split("\n").filter((entry) => entry.endsWith(" lines dropped"));
    assert.equal(notices.length, 1, text.slice(-400));
    assert.match(notices[0], new RegExp(dropped + " lines dropped$"));
  } finally {
    installed.restore();
    reader.destroy();
    writer.destroy();
    server.close();
  }
});

test("a fatal log writes queued lines first", async () => {
  const dir = await tempDir();
  const file = path.join(dir, "stderr.log");
  const fd = openSync(file, "w");
  const installed = installFileLog(fd);
  try {
    logSafe([], "queued-one");
    logSafe([], "queued-two");
    logFatal([], "fatal-line");
  } finally {
    installed.restore();
    closeSync(fd);
  }
  const text = await fs.readFile(file, "utf8");
  const lines = text.trim().split("\n");
  assert.match(lines[0], /queued-one$/);
  assert.match(lines[1], /queued-two$/);
  assert.match(lines[2], /fatal-line$/);
});

function fullFifo(dir) {
  const fifo = path.join(dir, "stderr.pipe");
  execFileSync("mkfifo", [fifo]);
  const reader = openSync(fifo, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK);
  const fd = openSync(fifo, fsConstants.O_WRONLY | fsConstants.O_NONBLOCK);
  return {
    fd,
    // Nothing is polling the read end, so a full pipe stays full while the
    // fatal write retries.
    fill() {
      const chunk = Buffer.alloc(64 * 1024, 0x61);
      let blocked = false;
      try {
        for (;;) writeSync(fd, chunk);
      } catch (error) {
        assert.equal(error.code, "EAGAIN");
        blocked = true;
      }
      assert.equal(blocked, true);
      try {
        writeSync(fd, Buffer.from("x"));
        assert.fail("the pipe accepted another byte");
      } catch (error) {
        assert.equal(error.code, "EAGAIN");
      }
    },
    read() {
      const chunks = [];
      const buf = Buffer.alloc(64 * 1024);
      for (;;) {
        let n = 0;
        try {
          n = readSync(reader, buf, 0, buf.length, null);
        } catch (error) {
          if (error.code === "EAGAIN") break;
          throw error;
        }
        if (!n) break;
        chunks.push(Buffer.from(buf.subarray(0, n)));
      }
      return Buffer.concat(chunks).toString("utf8");
    },
    close() {
      closeSync(fd);
      closeSync(reader);
    },
  };
}

test("a flush writes the queued lines", async () => {
  const dir = await tempDir();
  const file = path.join(dir, "stderr.log");
  const fd = openSync(file, "w");
  const installed = installFileLog(fd);
  try {
    pauseFileLog();
    logSafe([], "queued-alpha");
    logSafe([], "queued-beta");
    assert.equal((await fs.readFile(file, "utf8")).includes("queued-alpha"), false);
    flushFileLog();
    const text = await fs.readFile(file, "utf8");
    const alpha = text.indexOf("queued-alpha");
    const beta = text.indexOf("queued-beta");
    assert.ok(alpha !== -1 && beta !== -1 && alpha < beta, text);
  } finally {
    installed.restore();
    closeSync(fd);
  }
});

test("a flush writes the queued lines when the stream hides its buffer", async () => {
  const dir = await tempDir();
  const file = path.join(dir, "stderr.log");
  const fd = openSync(file, "w");
  const installed = installFileLog(fd);
  try {
    pauseFileLog();
    logSafe([], "hidden-alpha");
    logSafe([], "hidden-beta");
    assert.equal((await fs.readFile(file, "utf8")).includes("hidden-alpha"), false);
    // Assigning null goes through Node's setter and leaves an empty array,
    // which is still "there". Shadow the getter so the flush has no queue.
    const state = installed.stream._writableState;
    Object.defineProperty(state, "buffered", {
      configurable: true,
      get() {
        return undefined;
      },
    });
    assert.equal(Array.isArray(state.buffered), false);
    flushFileLog();
    delete state.buffered;
    const text = await fs.readFile(file, "utf8");
    const alpha = text.indexOf("hidden-alpha");
    const beta = text.indexOf("hidden-beta");
    assert.ok(alpha !== -1 && beta !== -1 && alpha < beta, text);
  } finally {
    installed.restore();
    closeSync(fd);
  }
});

test("a fatal log writes the drop notice before the fatal line", async () => {
  const dir = await tempDir();
  const file = path.join(dir, "stderr.log");
  const fd = openSync(file, "w");
  const installed = installFileLog(fd, { cap: 1024 });
  try {
    const line = "x".repeat(200);
    for (let i = 0; i < 100 && installed.dropped === 0; i += 1) logSafe([], line);
    assert.ok(installed.dropped > 0, "the cap was never hit");
    logFatal([], "fatal-after-drop");
    const text = await fs.readFile(file, "utf8");
    const noticeAt = text.indexOf(installed.dropped + " lines dropped");
    const fatalAt = text.indexOf("fatal-after-drop");
    assert.ok(noticeAt !== -1, text.slice(-500));
    assert.ok(fatalAt !== -1 && noticeAt < fatalAt, text.slice(-500));
  } finally {
    installed.restore();
    closeSync(fd);
  }
});

test("a drained log is not written again by a fatal line", async () => {
  const dir = await tempDir();
  const file = path.join(dir, "stderr.log");
  const fd = openSync(file, "w");
  const installed = installFileLog(fd);
  try {
    for (let i = 0; i < 100; i += 1) logSafe([], "drained-" + i);
    const ready = Date.now() + 5000;
    while (installed.held !== 0 || installed.stream.writableLength !== 0) {
      if (Date.now() > ready) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(installed.held, 0);
    logFatal([], "fatal-after-drain");
  } finally {
    installed.restore();
    closeSync(fd);
  }
  const lines = (await fs.readFile(file, "utf8")).trim().split("\n");
  const counts = new Map();
  for (const line of lines) {
    const match = line.match(/drained-(\d+)$/);
    if (!match) continue;
    counts.set(match[1], (counts.get(match[1]) || 0) + 1);
  }
  assert.equal(counts.size, 100);
  for (const count of counts.values()) assert.equal(count, 1);
  assert.equal(lines.filter((line) => line.endsWith("fatal-after-drain")).length, 1);
  assert.equal(lines.length, 101);
});

test("logged lines do not accumulate after they drain", { timeout: 120000 }, async () => {
  const redactUrl = new URL("../src/redact.mjs", import.meta.url).href;
  const script = `
    import { openSync, closeSync } from "node:fs";
    import { installFileLog, logSafe } from ${JSON.stringify(redactUrl)};
    const fd = openSync("/dev/null", "w");
    const installed = installFileLog(fd);
    const line = "n".repeat(48);
    async function pump(count) {
      let i = 0;
      while (i < count) {
        const end = Math.min(count, i + 2000);
        for (; i < end; i += 1) logSafe([], line);
        if (installed.held > 256 * 1024 || installed.stream.writableLength > 256 * 1024) {
          await new Promise((resolve) => {
            const timer = setTimeout(resolve, 5000);
            installed.stream.once("drain", () => {
              clearTimeout(timer);
              resolve();
            });
          });
        } else {
          await new Promise((resolve) => setImmediate(resolve));
        }
      }
    }
    async function untilQuiet() {
      const start = Date.now();
      while (installed.held !== 0 || installed.stream.writableLength !== 0) {
        if (Date.now() - start > 20000) return;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
    await pump(100000);
    await untilQuiet();
    global.gc();
    const before = process.memoryUsage();
    await pump(1000000);
    await untilQuiet();
    global.gc();
    const after = process.memoryUsage();
    console.log(JSON.stringify({
      dropped: installed.dropped,
      held: installed.held,
      heap: after.heapUsed - before.heapUsed,
      rss: after.rss - before.rss,
    }));
    installed.restore();
    closeSync(fd);
  `;
  const child = spawn(process.execPath, ["--expose-gc", "--input-type=module", "-e", script], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const [code] = await once(child, "exit");
  assert.equal(code, 0, stderr || stdout);
  const stats = JSON.parse(stdout);
  assert.equal(stats.dropped, 0, stdout);
  assert.equal(stats.held, 0, stdout);
  assert.ok(stats.heap < 8 * 1024 * 1024, "heap grew " + stats.heap);
  assert.ok(stats.rss < 12 * 1024 * 1024, "rss grew " + stats.rss);
});

test("a fatal line on a full pipe lands in the pipe or the fallback file", async () => {
  const dir = await realTempDir();
  const pipe = fullFifo(dir);
  const marker = "fatal-on-a-full-pipe";
  const installed = installFileLog(pipe.fd, { cap: 32 * 1024, fallbackDir: dir });
  let elapsed = 0;
  try {
    pauseFileLog();
    logSafe([], "queued before fatal");
    pipe.fill();
    const started = Date.now();
    assert.doesNotThrow(() => logFatal([], marker));
    elapsed = Date.now() - started;
  } finally {
    installed.restore();
  }
  assert.ok(elapsed < 500, "fatal write took " + elapsed + "ms");
  const piped = pipe.read();
  pipe.close();
  const fallbackFile = path.join(dir, FATAL_FALLBACK_NAME);
  let fallback = "";
  try {
    const st = await fs.lstat(fallbackFile);
    assert.equal(st.isSymbolicLink(), false);
    assert.equal(st.isFile(), true);
    assert.equal(st.mode & 0o777, 0o600);
    fallback = await fs.readFile(fallbackFile, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const inPipe = piped.includes(marker);
  const inFile = fallback.includes(marker);
  assert.ok(inPipe || inFile, "fatal line missing from the pipe and " + fallbackFile);
  if (!inPipe) assert.ok(elapsed >= 50, "gave up on EAGAIN in " + elapsed + "ms");
});

test("a fatal fallback does not follow a symlink", async () => {
  const dir = await realTempDir();
  const target = path.join(dir, "target.log");
  await fs.writeFile(target, "untouched\n");
  const linkDir = path.join(dir, "state");
  await fs.mkdir(linkDir);
  await fs.symlink(target, path.join(linkDir, FATAL_FALLBACK_NAME));
  const pipe = fullFifo(dir);
  const marker = "fatal-skipped-symlink";
  const installed = installFileLog(pipe.fd, { cap: 32 * 1024, fallbackDir: linkDir });
  try {
    pipe.fill();
    const started = Date.now();
    assert.doesNotThrow(() => logFatal([], marker));
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 500, "symlink fallback took " + elapsed + "ms");
    assert.ok(elapsed >= 70, "symlink fallback skipped the retry in " + elapsed + "ms");
  } finally {
    installed.restore();
    pipe.close();
  }
  const linkStat = await fs.lstat(path.join(linkDir, FATAL_FALLBACK_NAME));
  assert.equal(linkStat.isSymbolicLink(), true);
  assert.equal(await fs.readFile(target, "utf8"), "untouched\n");
});

test("a fatal fallback refuses a symlink one level up", async () => {
  const root = await realTempDir();
  const realParent = path.join(root, "real");
  await fs.mkdir(realParent);
  const linkParent = path.join(root, "via-link");
  await fs.symlink(realParent, linkParent);
  const state = path.join(linkParent, "state");
  await fs.mkdir(state);
  const pipe = fullFifo(root);
  const marker = "fatal-skipped-parent-symlink";
  const installed = installFileLog(pipe.fd, { cap: 32 * 1024, fallbackDir: state });
  let piped = "";
  try {
    pipe.fill();
    assert.doesNotThrow(() => logFatal([], marker));
    piped = pipe.read();
  } finally {
    installed.restore();
    pipe.close();
  }
  const fallen = path.join(realParent, "state", FATAL_FALLBACK_NAME);
  await assert.rejects(fs.lstat(fallen), { code: "ENOENT" });
  assert.equal(piped.includes(marker), false);
});

test("a fatal fallback refuses a hard link", async () => {
  const dir = await realTempDir();
  const other = path.join(dir, "other.log");
  await fs.writeFile(other, "keep-this-secret\n");
  await fs.chmod(other, 0o640);
  await fs.link(other, path.join(dir, FATAL_FALLBACK_NAME));
  const before = await fs.lstat(other);
  const pipe = fullFifo(dir);
  const marker = "fatal-skipped-hard-link";
  const installed = installFileLog(pipe.fd, { cap: 32 * 1024, fallbackDir: dir });
  try {
    pipe.fill();
    assert.doesNotThrow(() => logFatal([], marker));
  } finally {
    installed.restore();
    pipe.close();
  }
  const after = await fs.lstat(other);
  assert.equal(after.mode & 0o777, before.mode & 0o777);
  assert.equal(after.nlink, 2);
  assert.equal(await fs.readFile(other, "utf8"), "keep-this-secret\n");
  assert.equal((await fs.readFile(path.join(dir, FATAL_FALLBACK_NAME), "utf8")).includes(marker), false);
});

test("a fatal fallback stays within 1 MiB", async () => {
  const dir = await realTempDir();
  const file = path.join(dir, FATAL_FALLBACK_NAME);
  const filled = openSync(file, "w", 0o600);
  writeSync(filled, Buffer.alloc(FILE_LOG_CAP, 0x61));
  closeSync(filled);
  const pipe = fullFifo(dir);
  const marker = "fatal-over-cap";
  const installed = installFileLog(pipe.fd, { cap: 32 * 1024, fallbackDir: dir });
  try {
    pipe.fill();
    assert.doesNotThrow(() => logFatal([], marker));
  } finally {
    installed.restore();
    pipe.close();
  }
  const st = await fs.lstat(file);
  assert.equal(st.isSymbolicLink(), false);
  assert.equal(st.mode & 0o777, 0o600);
  assert.ok(st.size <= FILE_LOG_CAP, "fatal.log is " + st.size);
  assert.ok(st.size < FILE_LOG_CAP, "fatal.log kept the previous megabyte");
  const text = await fs.readFile(file, "utf8");
  assert.equal(text.startsWith("fatal log restarted\n"), true);
  assert.equal(text.includes(marker), true);
  assert.equal(text.includes("aaa"), false);
});

test("a fatal fallback redacts a vault path and a note file name", async () => {
  const dir = await realTempDir();
  const pipe = fullFifo(dir);
  const planted = "/Users/ada/Vault/notes/secret-plan.md";
  const noteName = "shopping-list.md";
  const docId = "01abc234-def0-4567-8901-23456789abcd";
  const installed = installFileLog(pipe.fd, { cap: 32 * 1024, fallbackDir: dir });
  let piped = "";
  try {
    pipe.fill();
    assert.doesNotThrow(() => logFatal([], "save failed", planted, "note=" + noteName, "doc=" + docId));
    piped = pipe.read();
  } finally {
    installed.restore();
    pipe.close();
  }
  const text = await fs.readFile(path.join(dir, FATAL_FALLBACK_NAME), "utf8");
  assert.equal(text.includes(planted), false, text);
  assert.equal(text.includes("secret-plan.md"), false, text);
  assert.equal(text.includes(noteName), false, text);
  assert.equal(text.includes(docId), true, text);
  assert.equal(piped.includes(planted), false);
});

async function signalFlushesLastLine(signal) {
  const dir = await tempDir();
  const vault = path.join(dir, "vault");
  const data = path.join(dir, "data");
  await fs.mkdir(vault);
  await fs.mkdir(data);
  const file = path.join(dir, "stderr.log");
  const fd = openSync(file, "w");
  const server = fileURLToPath(new URL("../src/server.mjs", import.meta.url));
  const env = { ...process.env, AIDANOS_RELAY_TOKEN: TOKEN };
  delete env.AIDANOS_RELAY_TOKEN_FILE;
  delete env.AIDANOS_RELAY_GIT_URL;
  delete env.AIDANOS_RELAY_GIT_TOKEN;
  delete env.AIDANOS_RELAY_TEST_HANG_CLOSE;
  delete env.AIDANOS_RELAY_TEST_SHUTDOWN_MS;
  const child = spawn(process.execPath, [server, "--vault", vault, "--data", data, "--port", "0"], {
    env,
    stdio: ["ignore", "pipe", fd],
  });
  let stdout = "";
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("no LISTENING\n" + stdout)), 20000);
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (!stdout.includes("LISTENING")) return;
      clearTimeout(timer);
      resolve();
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error("exited " + code + " before LISTENING\n" + stdout));
    });
  });
  try {
    await ready;
  } catch (error) {
    closeSync(fd);
    child.kill("SIGKILL");
    throw error;
  }
  child.kill(signal);
  const [code, delivered] = await once(child, "exit");
  closeSync(fd);
  assert.equal(delivered, null);
  assert.equal(code, 0);
  const text = await fs.readFile(file, "utf8");
  const lines = text.split("\n").filter((entry) => entry.trim() !== "");
  assert.match(lines[lines.length - 1] || "", /relay log closed$/);
}

test("a SIGTERM flushes the last log line", async () => {
  await signalFlushesLastLine("SIGTERM");
});

test("a SIGINT flushes the last log line", async () => {
  await signalFlushesLastLine("SIGINT");
});

async function hungCloseExits(first, second, deadlineMs) {
  const dir = await tempDir();
  const vault = path.join(dir, "vault");
  const data = path.join(dir, "data");
  await fs.mkdir(vault);
  await fs.mkdir(data);
  const file = path.join(dir, "stderr.log");
  const fd = openSync(file, "w");
  const server = fileURLToPath(new URL("../src/server.mjs", import.meta.url));
  const env = { ...process.env, NODE_ENV: "test", AIDANOS_RELAY_TOKEN: TOKEN, AIDANOS_RELAY_TEST_HANG_CLOSE: "1" };
  delete env.AIDANOS_RELAY_TOKEN_FILE;
  delete env.AIDANOS_RELAY_GIT_URL;
  delete env.AIDANOS_RELAY_GIT_TOKEN;
  delete env.AIDANOS_RELAY_TEST_SHUTDOWN_MS;
  if (deadlineMs) env.AIDANOS_RELAY_TEST_SHUTDOWN_MS = String(deadlineMs);
  const child = spawn(process.execPath, [server, "--vault", vault, "--data", data, "--port", "0"], {
    env,
    stdio: ["ignore", "pipe", fd],
  });
  let stdout = "";
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("no LISTENING\n" + stdout)), 20000);
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (!stdout.includes("LISTENING")) return;
      clearTimeout(timer);
      resolve();
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error("exited " + code + " before LISTENING\n" + stdout));
    });
  });
  try {
    await ready;
  } catch (error) {
    closeSync(fd);
    child.kill("SIGKILL");
    throw error;
  }
  const started = Date.now();
  child.kill(first);
  if (second) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    child.kill(second);
  }
  const [code, delivered] = await once(child, "exit");
  const elapsed = Date.now() - started;
  closeSync(fd);
  const text = await fs.readFile(file, "utf8");
  const lines = text.split("\n").filter((entry) => entry.trim() !== "");
  return { code, delivered, elapsed, last: lines[lines.length - 1] || "", text };
}

test("a hung close exits after the shutdown deadline", { timeout: 20000 }, async () => {
  assert.equal(SHUTDOWN_DEADLINE_MS, 5000);
  const result = await hungCloseExits("SIGTERM", "", 400);
  assert.equal(result.delivered, null);
  assert.equal(result.code, 1, result.text);
  assert.match(result.last, new RegExp(SHUTDOWN_TIMEOUT_LINE + "$"));
  assert.ok(result.elapsed >= 300, "exited in " + result.elapsed + "ms");
  assert.ok(result.elapsed < 2500, "exited in " + result.elapsed + "ms");
});

test("a second signal exits a hung close", { timeout: 20000 }, async () => {
  const result = await hungCloseExits("SIGTERM", "SIGINT", 0);
  assert.equal(result.delivered, null);
  assert.equal(result.code, 1, result.text);
  assert.match(result.last, new RegExp(SHUTDOWN_TIMEOUT_LINE + "$"));
  assert.ok(result.elapsed < 3000, "second signal waited " + result.elapsed + "ms");
});

async function spawnRelay(dir, envExtra = {}) {
  const vault = path.join(dir, "vault");
  const data = path.join(dir, "data");
  await fs.mkdir(vault, { recursive: true });
  await fs.mkdir(data, { recursive: true });
  const stderr = path.join(dir, "stderr.log");
  const fd = openSync(stderr, "w");
  const server = fileURLToPath(new URL("../src/server.mjs", import.meta.url));
  const env = { ...process.env, AIDANOS_RELAY_TOKEN: TOKEN, ...envExtra };
  delete env.AIDANOS_RELAY_TOKEN_FILE;
  delete env.AIDANOS_RELAY_GIT_URL;
  delete env.AIDANOS_RELAY_GIT_TOKEN;
  delete env.AIDANOS_RELAY_TEST_HANG_CLOSE;
  if (!Object.prototype.hasOwnProperty.call(envExtra, "NODE_ENV")) delete env.NODE_ENV;
  if (!Object.prototype.hasOwnProperty.call(envExtra, "AIDANOS_RELAY_ALLOW_RESET")) delete env.AIDANOS_RELAY_ALLOW_RESET;
  for (const name of [
    "AIDANOS_RELAY_TEST_SLOW_SAVE",
    "AIDANOS_RELAY_TEST_SAVE_STAGED",
    "AIDANOS_RELAY_TEST_SAVE_HOLD_MS",
    "AIDANOS_RELAY_TEST_SAVE_WAIT_MS",
    "AIDANOS_RELAY_TEST_SHUTDOWN_MS",
    "AIDANOS_RELAY_TEST_HOLD_NOTE_MS",
  ]) {
    if (!Object.prototype.hasOwnProperty.call(envExtra, name)) delete env[name];
  }
  const child = spawn(process.execPath, [server, "--vault", vault, "--data", data, "--port", "0"], {
    env,
    stdio: ["ignore", "pipe", fd],
  });
  let stdout = "";
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("no LISTENING\n" + stdout)), 20000);
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
        if (!stdout.includes("LISTENING")) return;
        clearTimeout(timer);
        resolve();
      });
      child.once("exit", (code) => {
        clearTimeout(timer);
        reject(new Error("exited " + code + " before LISTENING\n" + stdout));
      });
    });
  } catch (error) {
    closeSync(fd);
    child.kill("SIGKILL");
    throw error;
  }
  const port = Number((stdout.match(/LISTENING 127\.0\.0\.1 (\d+)/) || [])[1]);
  return { child, vault, data, port, stderr, fd };
}

async function waitForPath(file) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      await fs.stat(file);
      return;
    } catch (error) {
      if (!error || error.code !== "ENOENT") throw error;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  throw new Error("missing " + file);
}

test("a slow save in flight at SIGTERM finishes and the file is whole", { timeout: 20000 }, async () => {
  assert.equal(SAVE_WAIT_MS, 12000);
  assert.equal(SHUTDOWN_DEADLINE_MS, 5000);
  const dir = await tempDir();
  const staged = path.join(dir, "staged");
  const body = slowSaveNoteBody();
  const started = await spawnRelay(dir, {
    NODE_ENV: "test",
    AIDANOS_RELAY_TEST_SLOW_SAVE: "1",
    AIDANOS_RELAY_TEST_SAVE_STAGED: staged,
    AIDANOS_RELAY_TEST_SAVE_HOLD_MS: "900",
    AIDANOS_RELAY_TEST_SHUTDOWN_MS: "400",
  });
  try {
    await waitForPath(staged);
  } catch (error) {
    closeSync(started.fd);
    started.child.kill("SIGKILL");
    throw error;
  }
  const began = Date.now();
  started.child.kill("SIGTERM");
  const [code] = await once(started.child, "exit");
  const elapsed = Date.now() - began;
  closeSync(started.fd);
  const note = await fs.readFile(path.join(started.vault, SLOW_SAVE_NOTE_NAME), "utf8");
  const names = await fs.readdir(started.vault);
  const text = await fs.readFile(started.stderr, "utf8");
  assert.equal(code, 0, text);
  assert.equal(note, body);
  assert.equal(note, await fs.readFile(staged, "utf8"));
  assert.equal(names.some((name) => name.endsWith(".tmp")), false);
  assert.equal(text.includes(SAVE_WAIT_TIMEOUT_LINE), false, text);
  assert.equal(text.includes(SHUTDOWN_TIMEOUT_LINE), false, text);
  assert.match(text, /relay log closed/);
  assert.ok(elapsed >= 700, "exited in " + elapsed + "ms");
  assert.ok(elapsed < 5000, "exited in " + elapsed + "ms");
});

test("a save that outlasts the shutdown bound is logged before close", { timeout: 20000 }, async () => {
  const dir = await tempDir();
  const staged = path.join(dir, "staged");
  const body = slowSaveNoteBody();
  const started = await spawnRelay(dir, {
    NODE_ENV: "test",
    AIDANOS_RELAY_TEST_SLOW_SAVE: "1",
    AIDANOS_RELAY_TEST_SAVE_STAGED: staged,
    AIDANOS_RELAY_TEST_SAVE_HOLD_MS: "2000",
    AIDANOS_RELAY_TEST_SAVE_WAIT_MS: "150",
    AIDANOS_RELAY_TEST_SHUTDOWN_MS: "400",
  });
  try {
    await waitForPath(staged);
  } catch (error) {
    closeSync(started.fd);
    started.child.kill("SIGKILL");
    throw error;
  }
  const began = Date.now();
  started.child.kill("SIGTERM");
  const [code] = await once(started.child, "exit");
  const elapsed = Date.now() - began;
  closeSync(started.fd);
  const text = await fs.readFile(started.stderr, "utf8");
  let note = "";
  try {
    note = await fs.readFile(path.join(started.vault, SLOW_SAVE_NOTE_NAME), "utf8");
  } catch (error) {
    if (!error || error.code !== "ENOENT") throw error;
  }
  assert.equal(code, 1, text);
  assert.match(text, new RegExp(SAVE_WAIT_TIMEOUT_LINE));
  assert.match(text, /relay log closed/);
  assert.notEqual(note, body);
  const names = await fs.readdir(started.vault);
  assert.equal(names.some((name) => name.endsWith(".tmp")), false, names.join(","));
  assert.ok(elapsed < 1500, "waited out the save in " + elapsed + "ms");
});

test("a worker temp held past the save wait is unlinked and the process exits 1", { timeout: 20000 }, async () => {
  const dir = await tempDir();
  const started = await spawnRelay(dir, {
    NODE_ENV: "test",
    AIDANOS_RELAY_TEST_HOLD_NOTE_MS: "8000",
    AIDANOS_RELAY_TEST_SAVE_WAIT_MS: "400",
    AIDANOS_RELAY_TEST_SHUTDOWN_MS: "4000",
  });
  const body = slowSaveNoteBody();
  try {
    const deadline = Date.now() + 5000;
    let found = false;
    while (Date.now() < deadline) {
      const names = await fs.readdir(started.vault);
      if (names.some((name) => name.endsWith(".tmp"))) {
        found = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    if (!found) throw new Error("worker temp did not appear");
  } catch (error) {
    closeSync(started.fd);
    started.child.kill("SIGKILL");
    throw error;
  }
  const began = Date.now();
  started.child.kill("SIGTERM");
  const [code] = await once(started.child, "exit");
  const elapsed = Date.now() - began;
  closeSync(started.fd);
  const text = await fs.readFile(started.stderr, "utf8");
  let note = "";
  try {
    note = await fs.readFile(path.join(started.vault, "held-note.md"), "utf8");
  } catch (error) {
    if (!error || error.code !== "ENOENT") throw error;
  }
  const names = await fs.readdir(started.vault);
  assert.equal(code, 1, text);
  assert.match(text, new RegExp(SAVE_WAIT_TIMEOUT_LINE));
  assert.match(text, /relay log closed/);
  assert.notEqual(note, body);
  assert.equal(names.some((name) => name.endsWith(".tmp")), false, names.join(","));
  assert.ok(elapsed < 6000, "exited in " + elapsed + "ms");
});

test("a second signal during the save wait exits immediately", { timeout: 20000 }, async () => {
  const dir = await tempDir();
  const staged = path.join(dir, "staged");
  const body = slowSaveNoteBody();
  const started = await spawnRelay(dir, {
    NODE_ENV: "test",
    AIDANOS_RELAY_TEST_SLOW_SAVE: "1",
    AIDANOS_RELAY_TEST_SAVE_STAGED: staged,
    AIDANOS_RELAY_TEST_SAVE_HOLD_MS: "8000",
  });
  try {
    await waitForPath(staged);
  } catch (error) {
    closeSync(started.fd);
    started.child.kill("SIGKILL");
    throw error;
  }
  const began = Date.now();
  started.child.kill("SIGTERM");
  await new Promise((resolve) => setTimeout(resolve, 150));
  started.child.kill("SIGINT");
  const [code] = await once(started.child, "exit");
  const elapsed = Date.now() - began;
  closeSync(started.fd);
  const text = await fs.readFile(started.stderr, "utf8");
  let note = "";
  try {
    note = await fs.readFile(path.join(started.vault, SLOW_SAVE_NOTE_NAME), "utf8");
  } catch (error) {
    if (!error || error.code !== "ENOENT") throw error;
  }
  assert.equal(code, 1, text);
  assert.match(text, new RegExp(SHUTDOWN_TIMEOUT_LINE));
  assert.equal(text.includes("relay log closed"), false, text);
  assert.notEqual(note, body);
  assert.ok(elapsed < 2000, "second signal waited " + elapsed + "ms");
});

test("an index trace window drops the oldest entries past the cap", async () => {
  assert.equal(INDEX_TRACE_ENTRY_CAP, 10000);
  finishIndexReply();
  const lines = [];
  await installIndexTrace((line) => lines.push(line));
  beginIndexRequest({ handles: {} });
  try {
    for (let i = 0; i < 30; i += 1) noteGitWork(0);
    for (let i = 0; i < INDEX_TRACE_ENTRY_CAP; i += 1) noteMirror(0);
    finishIndexReply();
  } finally {
    finishIndexReply();
  }
  const steps = lines.filter((line) => line.startsWith("index steps"));
  assert.equal(steps.length, 1);
  assert.match(steps[0], /git=0x 0\.0ms/);
  assert.match(steps[0], new RegExp("mirror=" + INDEX_TRACE_ENTRY_CAP + "x "));
});

test("index trace turns off when automerge internals are missing", async () => {
  const lines = [];
  await installIndexTrace((line) => lines.push(line), {
    load: async () => ({ wasm: { Automerge: { prototype: {} } }, ApiHandler: {} }),
  });
  assert.deepEqual(lines, ["index trace off"]);
  const dir = await tempDir();
  const relay = await startRelay({
    token: TOKEN,
    vault: path.join(dir, "vault"),
    data: path.join(dir, "data"),
    port: 0,
    gitUrl: "",
  });
  try {
    const health = await fetch(relay.healthURL);
    assert.equal(health.status, 200);
    const id = noteId("notes/trace-off.md");
    await importDoc(relay.repo, id, { kind: "note", text: "still syncing" });
    const handle = await relay.repo.find(id);
    assert.equal(handle.doc().text, "still syncing");
  } finally {
    await relay.close();
  }
});

test("event loop late lines collapse to one per burst", () => {
  const state = emptyLateState();
  assert.equal(nextLoopLateLine(state, 250, 0), null);
  assert.equal(nextLoopLateLine(state, 400, 100), null);
  assert.equal(nextLoopLateLine(state, 50, 200), "event loop late 400ms x2");
  assert.equal(nextLoopLateLine(state, 40, 300), null);
  assert.equal(nextLoopLateLine(emptyLateState(), 11165, 0), "event loop late 11165ms");
  const held = emptyLateState();
  assert.equal(nextLoopLateLine(held, 300, 0), null);
  assert.equal(nextLoopLateLine(held, 900, 500), null);
  assert.equal(nextLoopLateLine(held, 450, 1000), "event loop late 900ms x3");
  assert.equal(nextLoopLateLine(held, 200, 1100), null);
  assert.equal(nextLoopLateLine(held, 20, 1200), "event loop late 200ms");
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
  const planted = "save failed /Users/ada/Vault/notes/secret-plan.md note=shopping-list.md doc=01abc234-def0-4567-8901-23456789abcd";
  const locations = redact(planted, []);
  assert.equal(locations.includes("/Users/ada"), false);
  assert.equal(locations.includes("secret-plan.md"), false);
  assert.equal(locations.includes("shopping-list.md"), false);
  assert.equal(locations.includes("01abc234-def0-4567-8901-23456789abcd"), true);
});

test("note names with spaces, unicode, and quotes are scrubbed", () => {
  const spaced = redact("wrote Secret Plan.md today", []);
  assert.equal(spaced.includes("Secret"), false, spaced);
  assert.equal(spaced.includes("Plan.md"), false, spaced);
  assert.equal(spaced.includes(".md"), false, spaced);
  const quoted = redact("see 'Secret Plan.md' now", []);
  assert.equal(quoted, "see '[note]' now");
  const double = redact('open "Café Notes.md" next', []);
  assert.equal(double, 'open "[note]" next');
  const unicode = redact("保存 計画.md", []);
  assert.equal(unicode.includes("計画"), false, unicode);
  assert.equal(unicode.includes("保存"), false, unicode);
  assert.equal(unicode, "[note]");
  const upper = redact("left Shopping List.MD here", []);
  assert.equal(upper.includes("Shopping"), false, upper);
  assert.equal(upper.includes(".MD"), false, upper);
});

test("path prefixes and relative paths are scrubbed", () => {
  const equals = redact("path=/Users/ada/Vault/notes", []);
  assert.equal(equals.includes("/Users"), false, equals);
  assert.equal(equals.includes("ada"), false, equals);
  assert.equal(equals, "path=[path]");
  const vault = redact("vault:/Users/ada/Vault", []);
  assert.equal(vault.includes("/Users"), false, vault);
  assert.equal(vault, "vault:[path]");
  const bracket = redact("see [/Users/ada/Vault/notes]", []);
  assert.equal(bracket.includes("/Users"), false, bracket);
  assert.equal(bracket, "see [[path]]");
  const relative = redact("read notes/draft.txt next", []);
  assert.equal(relative.includes("notes/draft.txt"), false, relative);
  assert.equal(relative.includes("draft"), false, relative);
  assert.equal(relative, "read [path] next");
  const upperPath = redact("open Notes/File.MD", []);
  assert.equal(upperPath.includes("Notes"), false, upperPath);
  assert.equal(upperPath.includes("File"), false, upperPath);
  assert.equal(upperPath, "open [path]");
});

test("a log line drops a partial token at the 8 KB cut", () => {
  assert.equal(LOG_LINE_CAP, 8 * 1024);
  const secret = "/Users/ada/Vault/secret-plan.md";
  const over = "a".repeat(LOG_LINE_CAP) + secret;
  const capped = redact(over, []);
  assert.equal(capped.includes(secret), false, capped);
  assert.equal(capped.includes("/Users"), false, capped);
  assert.equal(capped.includes("aaaa"), false, capped);
  assert.ok(Buffer.byteLength(capped) <= LOG_LINE_CAP + Buffer.byteLength("[truncated]"));
  const prefix = "path=/Users/ada/Vault/notes " + "b ".repeat(LOG_LINE_CAP);
  const scrubbed = redact(prefix, []);
  assert.equal(scrubbed.includes("/Users"), false, scrubbed);
  assert.equal(scrubbed.includes("[path]"), true, scrubbed);
  assert.equal(scrubbed.includes("[truncated]"), true, scrubbed);
  assert.ok(Buffer.byteLength(scrubbed) <= LOG_LINE_CAP + Buffer.byteLength("[truncated]"));

  let head = "";
  while (Buffer.byteLength(head) < LOG_LINE_CAP - 8) head += "safe ";
  const crossing = head + "PrivateFolder/plan.md Secret Plan.md " + "tail ".repeat(2000);
  const crossed = redact(crossing, []);
  assert.equal(crossed.includes("Private"), false, crossed.slice(0, 80));
  assert.equal(crossed.includes("Secret"), false, crossed.slice(0, 80));
  assert.equal(crossed.includes("Plan"), false, crossed.slice(0, 80));
  assert.equal(crossed.includes("[truncated]"), true);
  assert.ok(Buffer.byteLength(crossed) <= LOG_LINE_CAP + Buffer.byteLength("[truncated]"));

  let words = "";
  while (Buffer.byteLength(words) < LOG_LINE_CAP - 4) words += "ok ";
  const partial = redact(words + "PrivateFolderExtra", []);
  assert.equal(partial.includes("Private"), false, partial.slice(-40));
  assert.equal(partial.endsWith("[truncated]"), true);
});

test("slash tokens stay only for stack frames, ratios, and the fixed list", () => {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
  const install = path.join(repoRoot, "relay", "src", "x.mjs");
  assert.equal(redact("fail " + install + ":4:8", []), "fail relay/src/x.mjs:4:8");
  assert.equal(redact("at file://" + install + ":4:8", []), "at relay/src/x.mjs:4:8");
  const shaped = path.join("/tmp", "not-the-repo", "relay", "src", "x.mjs");
  const masked = redact("fail " + shaped + ":1:1", []);
  assert.equal(masked.includes("relay/src"), false, masked);
  assert.equal(masked.includes("x.mjs"), false, masked);
  assert.equal(masked.startsWith("fail [path]"), true, masked);
  const relativeFrame = redact("at relay/src/x.mjs:1:1", []);
  assert.equal(relativeFrame.includes("relay/src"), false, relativeFrame);
  assert.equal(relativeFrame.startsWith("at [path]"), true, relativeFrame);
  assert.equal(
    redact("at node:internal/modules/cjs/loader:198:15", []),
    "at node:internal/modules/cjs/loader:198:15",
  );
  const bareNode = redact("at node:internal/modules/cjs/loader", []);
  assert.equal(bareNode.includes("modules/cjs"), false, bareNode);
  assert.equal(redact("batch 2/5 done", []), "batch 2/5 done");
  assert.equal(redact("HTTP/1.1 200", []), "HTTP/1.1 200");
  assert.equal(redact("12 KB/s now", []), "12 KB/s now");
  assert.equal(redact("slow MB/s", []), "slow MB/s");
  assert.equal(redact("type application/json", []), "type application/json");
  assert.equal(redact("type text/plain", []), "type text/plain");
  assert.equal(redact("notes/secret.md", []).includes("notes"), false);
  assert.equal(redact("step 3x/1.2ms", []).includes("3x/"), false);
});

test("note suffixes, windows paths, and encoded slashes are scrubbed", () => {
  const txt = redact("wrote Secret Plan.txt today", []);
  assert.equal(txt.includes("Secret"), false, txt);
  assert.equal(txt.includes(".txt"), false, txt);
  const markdown = redact("wrote Secret Plan.markdown today", []);
  assert.equal(markdown.includes("Secret"), false, markdown);
  assert.equal(markdown.includes(".markdown"), false, markdown);
  const mdx = redact("wrote Secret Plan.mdx today", []);
  assert.equal(mdx.includes("Secret"), false, mdx);
  assert.equal(mdx.includes(".mdx"), false, mdx);
  const drive = redact("open C:\\Users\\ada\\Vault\\plan.md", []);
  assert.equal(drive.includes("Users"), false, drive);
  assert.equal(drive.includes("plan"), false, drive);
  assert.equal(drive, "open [path]");
  const unc = redact("open \\\\server\\share\\plan.md", []);
  assert.equal(unc.includes("server"), false, unc);
  assert.equal(unc.includes("share"), false, unc);
  assert.equal(unc, "open [path]");
  const encoded = redact("open notes%2Fplan.md next", []);
  assert.equal(encoded.includes("notes"), false, encoded);
  assert.equal(encoded.includes("%2F"), false, encoded);
  assert.equal(encoded, "open [path] next");
  const lower = redact("open notes%2fplan.md next", []);
  assert.equal(lower.includes("notes"), false, lower);
  assert.equal(lower, "open [path] next");
});

test("fold-in, mirror, and foreign-folder lines keep their wording", () => {
  const err = Object.assign(new Error("EACCES: permission denied, open '/vault/day.md'"), { code: "EACCES" });
  const id = "AbC123xyz";
  const fold = foldInFailureLine(id, err);
  assert.equal(fold, "fold-in failed for AbC123xyz EACCES");
  assert.equal(redact(fold, []), fold);
  const note = mirrorNoteFailureLine(id, err);
  assert.equal(note, "mirror failed for AbC123xyz EACCES");
  assert.equal(redact(note, []), note);
  const outer = mirrorFailureLine(err);
  assert.equal(outer, "mirror failed: EACCES");
  assert.equal(redact(outer, []), outer);
  const hashed = foldInFailureLine("day.md", err);
  assert.equal(hashed.includes("day.md"), false, hashed);
  assert.equal(redact(hashed, []), hashed);
  assert.match(hashed, /^fold-in failed for [a-f0-9]{12} EACCES$/);
  const oldFold = redact("fold-in failed for day.md EACCES", []);
  assert.equal(oldFold.includes("day.md"), false, oldFold);
  const oldForeign = redact("This folder is not the relay's notes (log/2026-10-23.md). Pass an empty folder", []);
  assert.equal(oldForeign.includes("2026-10-23"), false, oldForeign);
  const oldConflict = redact("conflict copy kept for Secret Plan.md after merge", []);
  assert.equal(oldConflict.includes("Secret"), false, oldConflict);
  const oldWrote = redact("wrote Secret Plan.md today", []);
  assert.equal(oldWrote.includes("Secret"), false, oldWrote);
});

test("a location scrub is linear on adversarial input", () => {
  const piece = "(a/".repeat(200) + "a/a/a/".repeat(100) + " Secret Plan.txt Name.markdown Name.mdx "
    + "C:\\Users\\ada\\plan.md \\\\server\\share\\notes notes%2Fplan.md " + " ".repeat(800);
  assert.ok(piece.length < LOG_LINE_CAP, piece.length);
  let input = "";
  while (Buffer.byteLength(input) < 1024 * 1024) input += piece + "\n";
  assert.ok(Buffer.byteLength(input) >= 1024 * 1024);
  const started = performance.now();
  const cleaned = redact(input, []);
  const elapsed = performance.now() - started;
  assert.ok(elapsed < 100, "scrubbed in " + elapsed + "ms");
  assert.equal(cleaned.includes("(a/"), false);
  assert.equal(cleaned.includes("a/a/a/"), false);
  assert.equal(cleaned.includes("Secret"), false);
  assert.equal(cleaned.includes("Users"), false);
  assert.equal(cleaned.includes("server"), false);
  assert.equal(cleaned.includes("%2F"), false);
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
    await fs.writeFile(path.join(vault, ".gitignore"), "# keep\n.*.tmp\nuser.tmp\n");
    await fs.writeFile(path.join(vault, "day.md"), "today\n");
    await fs.writeFile(path.join(vault, "day.md.leftover.recover"), "secret\n");
    await fs.writeFile(path.join(vault, ".day.md.99999.tmp"), "secret-temp\n");
    await fs.writeFile(path.join(vault, ".cache.tmp"), "user-temp\n");
    const result = await relay.backupNow();
    assert.equal(result.pushed, true);
    const listed = await git(["--git-dir", bare, "log", "--oneline", "main"]);
    assert.match(listed.stdout, /Backup notes/);
    const ignore = await fs.readFile(path.join(vault, ".gitignore"), "utf8");
    assert.match(ignore, /\.aidanos\//);
    assert.match(ignore, /^\*\.recover$/m);
    assert.match(ignore, /^# keep$/m);
    assert.match(ignore, /^user\.tmp$/m);
    assert.match(ignore, /^\.\*\.md\.\*\.tmp$/m);
    assert.doesNotMatch(ignore, /^\.\*\.tmp$/m);
    const exclude = await fs.readFile(path.join(vault, ".git", "info", "exclude"), "utf8");
    assert.match(exclude, /^\*\.recover$/m);
    const tree = await git(["--git-dir", bare, "ls-tree", "-r", "--name-only", "main"]);
    assert.doesNotMatch(tree.stdout, /\.recover/);
    assert.doesNotMatch(tree.stdout, /\.day\.md\.99999\.tmp/);
    assert.match(tree.stdout, /^\.cache\.tmp$/m);
  } finally {
    await relay.close();
  }
});

function deadPid() {
  for (let pid = 1 << 22; pid < (1 << 22) + 2000; pid += 1) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error && error.code === "ESRCH") return pid;
    }
  }
  return 0;
}

test("a manifest line is durable before its temp exists", async () => {
  const dir = await tempDir();
  const vault = path.join(dir, "vault");
  const data = path.join(dir, "data");
  await fs.mkdir(vault);
  await fs.mkdir(data);
  const file = path.join(vault, "day.md");
  const tmp = path.join(vault, `.day.md.${process.pid}.tmp`);
  let saw = false;
  await saveNoteFile(file, "hello\n", undefined, {
    vault,
    stateDir: data,
    async afterManifest(prepared) {
      saw = true;
      assert.equal(prepared.length, 1);
      assert.equal(prepared[0].rel, `.day.md.${process.pid}.tmp`);
      const manifest = await fs.readFile(path.join(data, NOTE_TEMP_MANIFEST), "utf8");
      assert.equal(manifest, prepared[0].rel + "\n");
      await assert.rejects(fs.lstat(tmp), (error) => error && error.code === "ENOENT");
    },
  });
  assert.equal(saw, true);
  assert.equal(await fs.readFile(file, "utf8"), "hello\n");
  assert.equal((await fs.readFile(path.join(data, NOTE_TEMP_MANIFEST), "utf8")).trim(), "");
});

test("one manifest fsync records every temp in a pass before any temp exists", async () => {
  const dir = await tempDir();
  const vault = path.join(dir, "vault");
  const notes = path.join(vault, "notes");
  const data = path.join(dir, "data");
  await fs.mkdir(notes, { recursive: true });
  await fs.mkdir(data);
  const day = path.join(vault, "day.md");
  const plan = path.join(notes, "plan.md");
  const dayTmp = path.join(vault, `.day.md.${process.pid}.tmp`);
  const planTmp = path.join(notes, `.plan.md.${process.pid}.tmp`);
  let saw = false;
  const errors = await saveNoteBatch([
    { file: day, text: "day\n" },
    { file: plan, text: "plan\n" },
  ], {
    vault,
    stateDir: data,
    async afterManifest(prepared) {
      saw = true;
      assert.deepEqual(prepared.map((entry) => entry.rel), [
        `.day.md.${process.pid}.tmp`,
        `notes/.plan.md.${process.pid}.tmp`,
      ]);
      const manifest = await fs.readFile(path.join(data, NOTE_TEMP_MANIFEST), "utf8");
      assert.equal(manifest, prepared.map((entry) => entry.rel).join("\n") + "\n");
      await assert.rejects(fs.lstat(dayTmp), (error) => error && error.code === "ENOENT");
      await assert.rejects(fs.lstat(planTmp), (error) => error && error.code === "ENOENT");
    },
  });
  assert.equal(saw, true);
  assert.equal(errors.length, 0);
  assert.equal(await fs.readFile(day, "utf8"), "day\n");
  assert.equal(await fs.readFile(plan, "utf8"), "plan\n");
  assert.equal((await fs.readFile(path.join(data, NOTE_TEMP_MANIFEST), "utf8")).trim(), "");
});

test("a save keeps the vault real path recorded at claim", async () => {
  const dir = await tempDir();
  const real = path.join(dir, "real");
  const link = path.join(dir, "link");
  const missing = path.join(dir, "missing");
  const data = path.join(dir, "data");
  await fs.mkdir(real);
  await fs.mkdir(data);
  await fs.symlink(real, link);
  rememberVaultRoot(link);
  await fs.unlink(link);
  await fs.symlink(missing, link);
  const file = path.join(real, "day.md");
  await saveNoteFile(file, "hello\n", undefined, { vault: link, stateDir: data });
  assert.equal(await fs.readFile(file, "utf8"), "hello\n");
  const manifest = await fs.readFile(path.join(data, NOTE_TEMP_MANIFEST), "utf8");
  assert.equal(manifest.includes(".."), false, manifest);
  assert.equal(manifest.trim(), "");
});

test("a note temp is recorded when the vault path is a symlink", async () => {
  const dir = await tempDir();
  const real = path.join(dir, "real");
  const link = path.join(dir, "link");
  const data = path.join(dir, "data");
  await fs.mkdir(real);
  await fs.mkdir(data);
  await fs.symlink(real, link);
  const file = path.join(real, "day.md");
  await saveNoteFile(file, "hello\n", undefined, { vault: link, stateDir: data });
  assert.equal(await fs.readFile(file, "utf8"), "hello\n");
  const manifest = await fs.readFile(path.join(data, NOTE_TEMP_MANIFEST), "utf8");
  assert.equal(manifest.includes(".."), false, manifest);
  assert.equal(manifest.trim(), "");
});

test("an unclaimed folder keeps every temp, including a wrong vault", async () => {
  const dead = deadPid();
  assert.ok(dead > 1);
  const dir = await tempDir();
  const home = path.join(dir, "home");
  const poison = path.join(dir, "poison");
  await fs.mkdir(path.join(home, "Documents", "proj", ".cache"), { recursive: true });
  await fs.mkdir(poison);
  const note = path.join(home, `.secret-plan.md.${dead}.tmp`);
  const docx = path.join(home, `.report.docx.${dead}.tmp`);
  const dot = path.join(home, "Documents", "proj", ".cache", `.cache.${dead}.tmp`);
  const build = path.join(home, "Documents", "proj", `.build.${dead}.tmp`);
  await fs.writeFile(note, "note\n");
  await fs.writeFile(docx, "docx\n");
  await fs.writeFile(dot, "dot\n");
  await fs.writeFile(build, "build\n");
  const listed = [
    `.secret-plan.md.${dead}.tmp`,
    `.report.docx.${dead}.tmp`,
    `Documents/proj/.cache/.cache.${dead}.tmp`,
    `Documents/proj/.build.${dead}.tmp`,
    `../elsewhere/.secret.md.${dead}.tmp`,
  ];
  await fs.writeFile(path.join(poison, NOTE_TEMP_MANIFEST), listed.join("\n") + "\n");
  await sweepStaleNoteTemps(home, poison);
  await assert.rejects(
    startRelay({ token: TOKEN, vault: home, data: poison, port: 0, gitUrl: "" }),
    /not the relay's own folder/,
  );
  assert.equal(await fs.readFile(note, "utf8"), "note\n");
  assert.equal(await fs.readFile(docx, "utf8"), "docx\n");
  assert.equal(await fs.readFile(dot, "utf8"), "dot\n");
  assert.equal(await fs.readFile(build, "utf8"), "build\n");
  assert.equal(await fs.readFile(path.join(poison, NOTE_TEMP_MANIFEST), "utf8"), listed.join("\n") + "\n");
  await assert.rejects(fs.stat(path.join(home, ".aidanos", "relay-folder")));
});

test("a startup sweep removes only a claimed manifest temp", async () => {
  const dead = deadPid();
  assert.ok(dead > 1);
  const dir = await tempDir();
  const vault = path.join(dir, "vault");
  const data = path.join(dir, "data");
  const outside = path.join(dir, "outside");
  const first = await startRelay({ token: TOKEN, vault, data, port: 0, gitUrl: "" });
  await first.close();

  const notes = path.join(vault, "notes");
  const dotDir = path.join(vault, "docs", ".cache");
  await fs.mkdir(notes);
  await fs.mkdir(dotDir, { recursive: true });
  await fs.mkdir(outside);
  const nested = path.join(notes, `.plan.md.${dead}.tmp`);
  const unlisted = path.join(notes, `.extra.md.${dead}.tmp`);
  const live = path.join(vault, `.held-note.md.${process.pid}.tmp`);
  const docx = path.join(vault, `.report.docx.${dead}.tmp`);
  const dot = path.join(dotDir, `.cache.${dead}.tmp`);
  const linked = path.join(vault, "real-secret.md");
  const link = path.join(notes, `.linked.md.${dead}.tmp`);
  const outsideTemp = path.join(outside, `.secret.md.${dead}.tmp`);
  await fs.writeFile(nested, "nested note\n");
  await fs.writeFile(unlisted, "not listed\n");
  await fs.writeFile(live, "still writing\n");
  await fs.writeFile(docx, "docx\n");
  await fs.writeFile(dot, "dot\n");
  await fs.writeFile(linked, "do not follow\n");
  await fs.symlink(linked, link);
  await fs.writeFile(outsideTemp, "outside note\n");
  await fs.symlink(outside, path.join(vault, "linked-dir"));
  let foreign = "";
  try {
    foreign = path.join(notes, `.foreign.md.${dead}.tmp`);
    await fs.writeFile(foreign, "other-user\n");
    await fs.chown(foreign, 65534, 65534);
  } catch {
    if (foreign) await fs.rm(foreign, { force: true });
    foreign = "";
  }

  const lines = [
    `notes/.plan.md.${dead}.tmp`,
    `notes/.extra.md.${dead}.tmp`,
    `.held-note.md.${process.pid}.tmp`,
    `.report.docx.${dead}.tmp`,
    `docs/.cache/.cache.${dead}.tmp`,
    `notes/.linked.md.${dead}.tmp`,
    `linked-dir/.secret.md.${dead}.tmp`,
    `../outside/.secret.md.${dead}.tmp`,
  ];
  if (foreign) lines.push(`notes/.foreign.md.${dead}.tmp`);
  const decoy = path.join(dir, "decoy-manifest");
  await fs.writeFile(decoy, lines.join("\n") + "\n");
  await fs.symlink(decoy, path.join(data, NOTE_TEMP_MANIFEST));
  await sweepStaleNoteTemps(vault, data);
  assert.equal(await fs.readFile(nested, "utf8"), "nested note\n");
  assert.equal((await fs.lstat(path.join(data, NOTE_TEMP_MANIFEST))).isSymbolicLink(), true);
  assert.equal(await fs.readFile(decoy, "utf8"), lines.join("\n") + "\n");

  await fs.unlink(path.join(data, NOTE_TEMP_MANIFEST));
  const recorded = lines.filter((line) => line !== `notes/.extra.md.${dead}.tmp`);
  await fs.writeFile(path.join(data, NOTE_TEMP_MANIFEST), recorded.join("\n") + "\n");
  const again = await startRelay({ token: TOKEN, vault, data, port: 0, gitUrl: "" });
  try {
    await assert.rejects(fs.lstat(nested), (error) => error && error.code === "ENOENT");
    assert.equal(await fs.readFile(unlisted, "utf8"), "not listed\n");
    assert.equal(await fs.readFile(live, "utf8"), "still writing\n");
    assert.equal(await fs.readFile(docx, "utf8"), "docx\n");
    assert.equal(await fs.readFile(dot, "utf8"), "dot\n");
    assert.equal(await fs.readFile(linked, "utf8"), "do not follow\n");
    assert.equal((await fs.lstat(link)).isSymbolicLink(), true);
    assert.equal(await fs.readFile(outsideTemp, "utf8"), "outside note\n");
    if (foreign) assert.equal(await fs.readFile(foreign, "utf8"), "other-user\n");
    const manifest = await fs.readFile(path.join(data, NOTE_TEMP_MANIFEST), "utf8");
    assert.equal(manifest.includes(`notes/.plan.md.${dead}.tmp`), false, manifest);
    assert.equal(manifest.includes(`notes/.extra.md.${dead}.tmp`), false, manifest);
    assert.equal(manifest.includes(`.held-note.md.${process.pid}.tmp`), true, manifest);
    assert.equal(manifest.includes(`.report.docx.${dead}.tmp`), true, manifest);
    assert.equal(manifest.includes(`docs/.cache/.cache.${dead}.tmp`), true, manifest);
    assert.equal(manifest.includes(`notes/.linked.md.${dead}.tmp`), true, manifest);
    assert.equal(manifest.includes(`linked-dir/.secret.md.${dead}.tmp`), true, manifest);
    assert.equal(manifest.includes(`../outside/.secret.md.${dead}.tmp`), true, manifest);
    if (foreign) assert.equal(manifest.includes(`notes/.foreign.md.${dead}.tmp`), true, manifest);
  } finally {
    await again.close();
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
  const vaultMarker = await fs.readFile(path.join(vault, ".aidanos", "relay-folder"), "utf8");
  assert.equal(relayMarkerId(vaultMarker).length > 0, true);
  assert.equal(await fs.readFile(path.join(data, "relay-folder"), "utf8"), vaultMarker);
  assert.equal(await fs.readFile(relayIdFile(vault), "utf8"), vaultMarker);
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

test("the relay message cap is 4 MB", async () => {
  assert.equal(MAX_PAYLOAD, 4 * 1024 * 1024);
  const dir = await tempDir();
  const relay = await startRelay({
    token: TOKEN,
    vault: path.join(dir, "vault"),
    data: path.join(dir, "data"),
    port: 0,
    gitUrl: "",
    mirrorDebounceMs: 1000,
  });
  function sendFrame(bytes, waitMs) {
    return new Promise((resolve) => {
      const ws = new WebSocket(relay.url, { headers: { Authorization: "Bearer " + TOKEN } });
      let settled = false;
      const finish = (code) => {
        if (settled) return;
        settled = true;
        resolve({ code });
      };
      ws.on("open", () => {
        ws.send(bytes);
      });
      ws.on("close", (code) => finish(code));
      ws.on("error", () => {});
      setTimeout(() => {
        const open = ws.readyState === WebSocket.OPEN;
        if (open) ws.close();
        finish(open ? 0 : -1);
      }, waitMs);
    });
  }
  try {
    // Larger than the measured 1.19 MB frame, and still under the cap.
    const under = await sendFrame(Buffer.alloc(2_000_000, 7), 800);
    assert.notEqual(under.code, 1009);
    const over = await sendFrame(Buffer.alloc(MAX_PAYLOAD + 1, 9), 2000);
    assert.equal(over.code, 1009);
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
  assert.equal(text.includes("several words"), false);
  assert.match(text, /openssl rand -base64 32/);
  assert.match(text, /chmod 600/);
  assert.match(text, /--vault/);
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
      peerMetadata: { storageId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", isEphemeral: false },
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

// The Apple runner spent 13.951s between an index request and its reply.
// That limit is a step count: a tiny index must not decode, receive,
// generate, or fully save more than a handful of times. Wall clock stays
// out of the assertion because a loaded runner can stretch a short call.
test("an index reply is a handful of steps", async () => {
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
    importDoc(relay.repo, INDEX_ID, { kind: "index", paths: { "notes/hello.md": "note-1" } });
    const local = Automerge.from({ kind: "index", paths: {} });
    let syncState = Automerge.initSyncState();
    await new Promise((resolve, reject) => {
      const ws = new WebSocket(relay.url, { headers: { Authorization: "Bearer " + TOKEN } });
      const timer = setTimeout(() => {
        ws.terminate();
        reject(new Error("no index steps\n" + seen.join("\n")));
      }, 3000);
      ws.on("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      ws.on("open", () => {
        ws.send(cbor.encode({
          type: "join",
          senderId: "phone-1",
          supportedProtocolVersions: ["1"],
          peerMetadata: { storageId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", isEphemeral: false },
        }));
      });
      ws.on("message", (data) => {
        let message;
        try {
          message = cbor.decode(data);
        } catch {
          return;
        }
        if (!message || message.type !== "peer") return;
        const [next, syncMessage] = Automerge.generateSyncMessage(local, syncState);
        syncState = next;
        if (!syncMessage) {
          clearTimeout(timer);
          ws.close();
          reject(new Error("the local index had nothing to request"));
          return;
        }
        ws.send(cbor.encode({
          type: "request",
          senderId: "phone-1",
          targetId: message.senderId,
          documentId: INDEX_ID,
          data: syncMessage,
        }));
        const wait = setInterval(() => {
          if (!seen.some((line) => line.includes("index steps "))) return;
          clearInterval(wait);
          clearTimeout(timer);
          ws.close();
          resolve();
        }, 20);
      });
    });
  } finally {
    console.error = write;
    await relay.close();
  }
  const line = seen.filter((entry) => entry.includes("index steps ")).pop();
  assert.ok(line, "missing index steps\n" + seen.join("\n"));
  const count = (name) => {
    const match = line.match(new RegExp("\\b" + name + "=(\\d+)x "));
    assert.ok(match, name + " missing in " + line);
    return Number(match[1]);
  };
  const changes = Number(line.match(/\bchanges=(\d+)/)[1]);
  const ops = Number(line.match(/\bops=(\d+)/)[1]);
  const bytes = Number(line.match(/\bbytes=(\d+)/)[1]);
  assert.ok(changes >= 1 && changes <= 20, line);
  assert.ok(ops >= 1 && ops <= 400, line);
  assert.ok(bytes >= 0 && bytes < 100_000, line);
  assert.equal(line.includes("state=ready"), true, line);
  assert.ok(count("decode") >= 1 && count("decode") <= 8, line);
  assert.ok(count("receive") >= 1 && count("receive") <= 4, line);
  assert.ok(count("generate") >= 1 && count("generate") <= 4, line);
  assert.ok(count("patches") <= 8, line);
  assert.ok(count("save") <= 4, line);
  assert.ok(count("saveSince") <= 4, line);
  assert.ok(count("loadIncremental") <= 4, line);
  assert.match(line, /\bother=\d+\.\d{3}s/);
  assert.match(line, /\bblocked=\d+\.\d{3}s/);
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

test("reset is off when NODE_ENV is production or unset", { timeout: 40000 }, async () => {
  for (const nodeEnv of ["production", ""]) {
    const dir = await tempDir();
    const extra = { AIDANOS_RELAY_ALLOW_RESET: "1" };
    if (nodeEnv) extra.NODE_ENV = nodeEnv;
    const started = await spawnRelay(dir, extra);
    const note = path.join(started.vault, "kept.md");
    await fs.writeFile(note, "keep-this-note\n");
    const marker = await fs.readFile(path.join(started.data, "relay-folder"), "utf8");
    try {
      const response = await fetch("http://127.0.0.1:" + started.port + "/reset", {
        method: "POST",
        headers: { authorization: "Bearer " + TOKEN },
      });
      assert.equal(response.status, 404, nodeEnv || "unset");
      assert.equal(await fs.readFile(note, "utf8"), "keep-this-note\n");
      assert.equal(await fs.readFile(path.join(started.data, "relay-folder"), "utf8"), marker);
    } finally {
      started.child.kill("SIGTERM");
      await once(started.child, "exit");
      closeSync(started.fd);
    }
  }
});

test("a reset warms the sync engine before devices are told it is ready", async () => {
  warmSyncEngine();
  const source = await fs.readFile(new URL("../src/server.mjs", import.meta.url), "utf8");
  const activate = source.slice(source.indexOf("async function activateSession"), source.indexOf("async function rotate"));
  const warm = activate.indexOf("warmSyncEngine()");
  const published = activate.indexOf("live = session");
  assert.ok(warm > 0 && published > warm);
  assert.match(activate, /finally/);
  assert.match(activate, /disposeSession\(session\)/);
  assert.match(activate, /sync engine warm in /);
  const rotate = source.slice(source.indexOf("async function rotate"), source.indexOf("function scheduleReset"));
  const call = rotate.indexOf("await activateSession(");
  const generation = rotate.indexOf("resetGeneration += 1");
  assert.ok(call > 0 && generation > call);
  assert.equal(rotate.includes("warmSyncEngine()"), false);
  assert.match(rotate, /reset ready in /);
  const start = source.slice(source.indexOf("export async function startRelay"));
  const listenAt = start.indexOf("await listen(");
  const activateAt = start.indexOf("await activateSession(", listenAt);
  assert.ok(listenAt > 0 && activateAt > listenAt);
  assert.match(source, /join answered in /);
  assert.match(source, /index request/);
  assert.match(source, /index reply in /);
});

test("a failed warm-up closes the session", async () => {
  const dir = await tempDir();
  const vault = path.join(dir, "vault");
  const data = path.join(dir, "data");
  await assert.rejects(
    () => startRelay({
      token: TOKEN,
      vault,
      data,
      port: 0,
      gitUrl: "",
      warm() {
        throw new Error("warm failed");
      },
    }),
    /warm failed/,
  );
  const relay = await startRelay({
    token: TOKEN,
    vault,
    data,
    port: 0,
    gitUrl: "",
  });
  try {
    const health = await fetch(relay.healthURL);
    assert.equal(health.status, 200);
  } finally {
    await relay.close();
  }
});

test("a warm-up timeout closes the session instead of leaving health down", async () => {
  const dir = await tempDir();
  const vault = path.join(dir, "vault");
  const data = path.join(dir, "data");
  await assert.rejects(
    () => startRelay({
      token: TOKEN,
      vault,
      data,
      port: 0,
      gitUrl: "",
      sessionTimeoutMs: 200,
      beforeOpenReady() {
        return new Promise(() => {});
      },
    }),
    (error) => error && error.code === "WARM_TIMEOUT",
  );
  const relay = await startRelay({
    token: TOKEN,
    vault,
    data,
    port: 0,
    gitUrl: "",
  });
  try {
    const health = await fetch(relay.healthURL);
    assert.equal(health.status, 200);
  } finally {
    await relay.close();
  }
});

test("a reset warm-up timeout keeps the old generation", { timeout: 40000 }, async () => {
  const dir = await tempDir();
  let opens = 0;
  const seen = [];
  const write = console.error;
  console.error = (...args) => {
    seen.push(args.join(" "));
    write(...args);
  };
  const relay = await startRelay({
    token: TOKEN,
    vault: path.join(dir, "vault"),
    data: path.join(dir, "data"),
    port: 0,
    gitUrl: "",
    allowReset: true,
    sessionTimeoutMs: 5000,
    beforeOpenReady() {
      opens += 1;
      if (opens > 1 && opens <= 4) return new Promise(() => {});
    },
  });
  try {
    const first = await fetch(relay.healthURL);
    const body = await first.json();
    assert.equal(first.status, 200);
    assert.equal(body.resetGeneration, 0);
    const accepted = await fetch(relay.healthURL.replace("/health", "/reset"), {
      method: "POST",
      headers: { Authorization: "Bearer " + TOKEN },
    });
    assert.equal(accepted.status, 200);
    const deadline = Date.now() + 25000;
    let again = null;
    let status = 0;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      const response = await fetch(relay.healthURL + "?n=" + Date.now());
      status = response.status;
      if (status !== 200) continue;
      again = await response.json();
      if (seen.some((line) => line.includes("kept generation"))) break;
    }
    assert.equal(status, 200);
    assert.equal(again.ok, true);
    assert.equal(again.resetGeneration, 0);
    assert.equal(seen.some((line) => line.includes("sync warm-up timed out")), true);
    assert.equal(seen.some((line) => line.includes("kept generation 0")), true);
  } finally {
    console.error = write;
    await relay.close();
  }
});

test("a late warm-up disposes only its own session", { timeout: 30000 }, async () => {
  const dir = await tempDir();
  let opens = 0;
  let releaseLate = null;
  const late = new Promise((resolve) => {
    releaseLate = resolve;
  });
  let abandoned = null;
  const abandonedDone = new Promise((resolve) => {
    abandoned = resolve;
  });
  const relay = await startRelay({
    token: TOKEN,
    vault: path.join(dir, "vault"),
    data: path.join(dir, "data"),
    port: 0,
    gitUrl: "",
    allowReset: true,
    sessionTimeoutMs: 5000,
    beforeOpenReady() {
      opens += 1;
      if (opens === 2) return late;
    },
    onAbandonedSession() {
      abandoned();
    },
  });
  try {
    const first = await fetch(relay.healthURL);
    const started = await first.json();
    assert.equal(first.status, 200);
    assert.equal(started.ok, true);
    assert.equal(started.resetGeneration, 0);
    const accepted = await fetch(relay.healthURL.replace("/health", "/reset"), {
      method: "POST",
      headers: { Authorization: "Bearer " + TOKEN },
    });
    assert.equal(accepted.status, 200);
    const deadline = Date.now() + 15000;
    let live = null;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      const response = await fetch(relay.healthURL + "?n=" + Date.now());
      if (response.status !== 200) continue;
      live = await response.json();
      if (live.resetGeneration === 1) break;
    }
    assert.equal(live && live.resetGeneration, 1);
    assert.equal(live.ok, true);
    assert.equal(live.status, "ok");
    const join = cbor.encode({
      type: "join",
      senderId: "phone-late",
      supportedProtocolVersions: ["1"],
      peerMetadata: { storageId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", isEphemeral: true },
    });
    const joined = await new Promise((resolve, reject) => {
      const ws = new WebSocket(relay.url, { headers: { Authorization: "Bearer " + TOKEN } });
      const timer = setTimeout(() => {
        ws.terminate();
        reject(new Error("the live socket did not get a peer"));
      }, 2500);
      ws.on("open", () => ws.send(join));
      ws.on("message", (data) => {
        let message;
        try {
          message = cbor.decode(data);
        } catch {
          return;
        }
        if (!message || message.type !== "peer") return;
        clearTimeout(timer);
        resolve({ ws, senderId: message.senderId });
      });
      ws.on("error", () => {});
    });
    const held = joined.ws;
    const targetId = joined.senderId;
    let heldClosed = false;
    held.on("close", () => {
      heldClosed = true;
    });
    releaseLate();
    const gaveUp = Symbol("late");
    const finished = await Promise.race([
      abandonedDone,
      new Promise((resolve) => setTimeout(() => resolve(gaveUp), 5000)),
    ]);
    assert.notEqual(finished, gaveUp, "the late warm-up never finished");
    assert.equal(heldClosed, false, "the already-connected socket closed");
    assert.equal(held.readyState, WebSocket.OPEN);
    const docId = noteId("notes/late-open.md");
    await importDoc(relay.repo, docId, { kind: "note", text: "still open" });
    let local = Automerge.init();
    let syncState = Automerge.initSyncState();
    const synced = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("the live socket did not sync")), 4000);
      function send() {
        const [next, syncMessage] = Automerge.generateSyncMessage(local, syncState);
        syncState = next;
        if (!syncMessage) return false;
        held.send(cbor.encode({
          type: "request",
          senderId: "phone-late",
          targetId,
          documentId: docId,
          data: syncMessage,
        }));
        return true;
      }
      held.on("message", (data) => {
        let message;
        try {
          message = cbor.decode(data);
        } catch {
          return;
        }
        if (!message || message.documentId !== docId || !message.data) return;
        const result = Automerge.receiveSyncMessage(local, syncState, message.data);
        local = result[0];
        syncState = result[1];
        if (local && local.text === "still open") {
          clearTimeout(timer);
          resolve(local.text);
          return;
        }
        send();
      });
      if (!send()) {
        clearTimeout(timer);
        reject(new Error("the local note had nothing to request"));
      }
    });
    assert.equal(synced, "still open");
    held.close();
    const peer = await expectPeer(relay.url, join);
    assert.equal(peer.type, "peer");
    const health = await fetch(relay.healthURL + "?after=1");
    const body = await health.json();
    assert.equal(health.status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.status, "ok");
    assert.equal(body.resetGeneration, 1);
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
    const acceptedBody = await accepted.json();
    assert.equal(acceptedBody.ok, true);
    assert.equal(acceptedBody.resetting, true);
    assert.equal(acceptedBody.resetGeneration, 1);
    const deadline = Date.now() + 5000;
    let booted = body.bootedAt;
    let generation = body.resetGeneration;
    while (Date.now() < deadline && (booted === body.bootedAt || generation !== acceptedBody.resetGeneration)) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      const again = await fetch(relay.healthURL + "?n=" + Date.now());
      const parsed = await again.json();
      if (again.status !== 200) continue;
      booted = parsed.bootedAt;
      generation = parsed.resetGeneration;
    }
    assert.notEqual(booted, body.bootedAt);
    assert.equal(generation, acceptedBody.resetGeneration);
    assert.equal(resets, 1);
    const [firstAgain, secondAgain] = await Promise.all([
      fetch(relay.healthURL.replace("/health", "/reset"), {
        method: "POST",
        headers: { Authorization: "Bearer " + TOKEN },
      }),
      fetch(relay.healthURL.replace("/health", "/reset"), {
        method: "POST",
        headers: { Authorization: "Bearer " + TOKEN },
      }),
    ]);
    assert.equal(firstAgain.status, 200);
    assert.equal(secondAgain.status, 200);
    const tickets = [(await firstAgain.json()).resetGeneration, (await secondAgain.json()).resetGeneration].sort(
      (left, right) => left - right,
    );
    assert.deepEqual(tickets, [acceptedBody.resetGeneration + 1, acceptedBody.resetGeneration + 2]);
    const laterTicket = tickets[1];
    const later = Date.now() + 5000;
    let finished = 0;
    let finishedStatus = 0;
    while (Date.now() < later) {
      const again = await fetch(relay.healthURL + "?n=" + Date.now());
      const parsed = await again.json();
      finishedStatus = again.status;
      finished = parsed.resetGeneration;
      if (finishedStatus === 200 && finished >= laterTicket) break;
      assert.ok(finished < laterTicket);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(finishedStatus, 200);
    assert.equal(finished, laterTicket);
    assert.equal(resets, 3);
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

test("relay refuses a notes folder", async () => {
  const dir = await tempDir();
  const vault = path.join(dir, "notes");
  await fs.mkdir(path.join(vault, "log"), { recursive: true });
  await fs.writeFile(path.join(vault, "log", "2026-10-23.md"), "# day\n");
  await fs.writeFile(path.join(vault, "readme.txt"), "notes\n");
  await fs.mkdir(path.join(vault, ".git"), { recursive: true });
  await fs.writeFile(path.join(vault, ".git", "config"), '[remote "origin"]\n\turl = /tmp/notes.git\n');
  const withRemote = "This folder is not the relay's own folder. It has a git remote. Pass an empty folder, or the folder the relay marked earlier.";
  await assert.rejects(
    startRelay({ token: TOKEN, vault, data: path.join(dir, "data"), port: 0, gitUrl: "" }),
    (error) => {
      assert.equal(error.message, withRemote);
      assert.equal(error.message.includes("2026-10-23"), false);
      assert.equal(error.message.includes("readme"), false);
      assert.equal(redact(error.message, []), error.message);
      return true;
    },
  );
  assert.equal(await fs.readFile(path.join(vault, "log", "2026-10-23.md"), "utf8"), "# day\n");
  await assert.rejects(fs.stat(path.join(vault, ".aidanos", "relay-folder")));
  await assert.rejects(fs.stat(path.join(dir, "data")));
  const plain = path.join(dir, "plain");
  await fs.mkdir(plain);
  await fs.writeFile(path.join(plain, "readme.txt"), "notes\n");
  const withFiles = "This folder is not the relay's own folder. It already has files, and it has no relay marker. Pass an empty folder, or the folder the relay marked earlier.";
  await assert.rejects(
    startRelay({ token: TOKEN, vault: plain, data: path.join(dir, "plain-data"), port: 0, gitUrl: "" }),
    (error) => {
      assert.equal(error.message, withFiles);
      assert.equal(error.message.includes("readme"), false);
      assert.equal(redact(error.message, []), error.message);
      return true;
    },
  );
});

test("relay ignores the old vault variables and accepts its own marked folder", async () => {
  const dir = await tempDir();
  const notes = path.join(dir, "notes");
  await fs.mkdir(path.join(notes, "log"), { recursive: true });
  await fs.writeFile(path.join(notes, "log", "2026-10-23.md"), "secret\n");
  const own = path.join(dir, "relay-vault");
  const data = path.join(dir, "data");
  const marker = relayMarkerText("aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee");
  await fs.mkdir(path.join(own, ".aidanos"), { recursive: true });
  await fs.mkdir(data, { recursive: true });
  await fs.writeFile(path.join(own, ".aidanos", "relay-folder"), marker);
  await fs.writeFile(path.join(data, "relay-folder"), marker);
  await fs.writeFile(relayIdFile(own), marker);
  await fs.writeFile(path.join(own, "day.md"), "kept\n");
  await fs.mkdir(path.join(own, ".git"), { recursive: true });
  await fs.writeFile(path.join(own, ".git", "config"), '[remote "origin"]\n\turl = /tmp/backup.git\n');
  const env = {
    AIDANOS_VAULT: notes,
    AIDANOS_VAULT_GIT_URL: "https://example.invalid/vault.git",
    AIDANOS_VAULT_GIT_TOKEN: "should-not-be-used-0123456789abcdef",
    AIDANOS_RELAY_VAULT: own,
  };
  const relay = await startRelay({
    token: TOKEN,
    env,
    data,
    port: 0,
    gitIntervalMs: 0,
  });
  try {
    const body = await (await fetch(relay.healthURL)).json();
    assert.equal(body.git, false);
    assert.equal(body.gitStatus, "off");
    assert.equal(await fs.readFile(path.join(notes, "log", "2026-10-23.md"), "utf8"), "secret\n");
    await assert.rejects(fs.stat(path.join(notes, ".aidanos", "relay-folder")));
    assert.equal(await fs.readFile(path.join(own, "day.md"), "utf8"), "kept\n");
    assert.equal(await fs.readFile(path.join(own, ".aidanos", "relay-folder"), "utf8"), marker);
  } finally {
    await relay.close();
  }
  await assert.rejects(
    startRelay({ token: TOKEN, env: { AIDANOS_VAULT: notes }, port: 0, gitUrl: "" }),
    /AIDANOS_RELAY_VAULT/,
  );
});

test("an old relay marker does not authorize a notes folder or a reset", async () => {
  const dir = await tempDir();
  const vault = path.join(dir, "notes");
  await fs.mkdir(path.join(vault, ".aidanos"), { recursive: true });
  await fs.writeFile(path.join(vault, ".aidanos", "relay-folder"), "relay\n");
  await fs.mkdir(path.join(vault, "log"), { recursive: true });
  await fs.writeFile(path.join(vault, "log", "2026-10-23.md"), "# day\n");
  await fs.mkdir(path.join(vault, ".git"), { recursive: true });
  await fs.writeFile(path.join(vault, ".git", "config"), '[remote "origin"]\n\turl = /tmp/notes.git\n');
  await fs.writeFile(path.join(vault, ".git", "HEAD"), "ref: refs/heads/main\n");
  await assert.rejects(
    startRelay({
      token: TOKEN,
      vault,
      data: path.join(dir, "data"),
      port: 0,
      gitUrl: "",
      allowReset: true,
    }),
    /notes|git remote/,
  );
  assert.equal(await fs.readFile(path.join(vault, "log", "2026-10-23.md"), "utf8"), "# day\n");
  assert.match(await fs.readFile(path.join(vault, ".git", "config"), "utf8"), /\[remote /);
  assert.equal(await fs.readFile(path.join(vault, ".git", "HEAD"), "utf8"), "ref: refs/heads/main\n");
  assert.equal(await fs.readFile(path.join(vault, ".aidanos", "relay-folder"), "utf8"), "relay\n");
  await assert.rejects(fs.stat(relayIdFile(vault)));
  await assert.rejects(fs.stat(path.join(dir, "data")));

  const own = path.join(dir, "own");
  const data = path.join(dir, "own-data");
  const relay = await startRelay({
    token: TOKEN,
    vault: own,
    data,
    port: 0,
    gitUrl: "",
    allowReset: true,
  });
  try {
    await fs.writeFile(path.join(own, ".aidanos", "relay-folder"), "relay\n");
    await fs.mkdir(path.join(own, "log"), { recursive: true });
    await fs.writeFile(path.join(own, "log", "keep.md"), "keep\n");
    await fs.mkdir(path.join(own, ".git"), { recursive: true });
    await fs.writeFile(path.join(own, ".git", "config"), '[remote "origin"]\n\turl = /tmp/own.git\n');
    await fs.writeFile(path.join(own, ".git", "HEAD"), "ref: refs/heads/main\n");
    const denied = await fetch(relay.healthURL.replace("/health", "/reset"), {
      method: "POST",
      headers: { Authorization: "Bearer " + TOKEN },
    });
    assert.equal(denied.status, 409);
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.equal(await fs.readFile(path.join(own, "log", "keep.md"), "utf8"), "keep\n");
    assert.match(await fs.readFile(path.join(own, ".git", "config"), "utf8"), /\[remote /);
    assert.equal(await fs.readFile(path.join(own, ".git", "HEAD"), "utf8"), "ref: refs/heads/main\n");
    assert.equal(await fs.readFile(path.join(own, ".aidanos", "relay-folder"), "utf8"), "relay\n");
  } finally {
    await relay.close();
  }
});

test("git does not see an unrelated secret", async () => {
  const dir = await tempDir();
  const vault = path.join(dir, "vault");
  const bare = path.join(dir, "empty.git");
  const bin = path.join(dir, "bin");
  const log = path.join(dir, "git-env.txt");
  const realGit = (await exec("which", ["git"])).stdout.trim();
  await fs.mkdir(bin);
  const script =
    "#!/bin/sh\nenv >> " + JSON.stringify(log) + "\nexec " + JSON.stringify(realGit) + ' "$@"\n';
  await fs.writeFile(path.join(bin, "git"), script, { mode: 0o755 });
  await git(["init", "--bare", "-b", "main", bare]);
  const previousPath = process.env.PATH;
  const previousSecret = process.env.UNRELATED_SECRET;
  const previousVaultToken = process.env.AIDANOS_VAULT_GIT_TOKEN;
  const previousSsh = process.env.SSH_AUTH_SOCK;
  process.env.PATH = bin + path.delimiter + (previousPath || "");
  process.env.UNRELATED_SECRET = "unrelated-secret-not-for-git";
  process.env.AIDANOS_VAULT_GIT_TOKEN = "hosted-vault-token-should-stay-out";
  process.env.SSH_AUTH_SOCK = "/tmp/ssh-agent-not-for-the-relay.sock";
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
    const seen = await fs.readFile(log, "utf8");
    assert.equal(seen.includes("unrelated-secret-not-for-git"), false);
    assert.equal(seen.includes("hosted-vault-token-should-stay-out"), false);
    assert.equal(seen.includes("SSH_AUTH_SOCK="), false);
    assert.equal(seen.includes("/tmp/ssh-agent-not-for-the-relay.sock"), false);
    assert.match(seen, /^PATH=/m);
  } finally {
    if (previousPath == null) delete process.env.PATH;
    else process.env.PATH = previousPath;
    if (previousSecret == null) delete process.env.UNRELATED_SECRET;
    else process.env.UNRELATED_SECRET = previousSecret;
    if (previousVaultToken == null) delete process.env.AIDANOS_VAULT_GIT_TOKEN;
    else process.env.AIDANOS_VAULT_GIT_TOKEN = previousVaultToken;
    if (previousSsh == null) delete process.env.SSH_AUTH_SOCK;
    else process.env.SSH_AUTH_SOCK = previousSsh;
    await relay.close();
  }
});

test("the id file beside the notes folder is not followed or overwritten", async () => {
  const dir = await tempDir();
  const vault = path.join(dir, "vault");
  const target = path.join(dir, "precious.txt");
  await fs.writeFile(target, "keep-me\n");
  await fs.symlink(target, relayIdFile(vault));
  await assert.rejects(
    startRelay({ token: TOKEN, vault, data: path.join(dir, "data"), port: 0, gitUrl: "" }),
    /symlink/,
  );
  assert.equal(await fs.readFile(target, "utf8"), "keep-me\n");
  assert.equal((await fs.lstat(relayIdFile(vault))).isSymbolicLink(), true);
  await assert.rejects(fs.stat(path.join(vault, ".aidanos", "relay-folder")));
  await assert.rejects(fs.stat(path.join(dir, "data", "relay-folder")));

  const other = path.join(dir, "other");
  const occupied = relayIdFile(other);
  await fs.writeFile(occupied, "not a marker\n");
  await assert.rejects(
    startRelay({ token: TOKEN, vault: other, data: path.join(dir, "other-data"), port: 0, gitUrl: "" }),
    /already exists/,
  );
  assert.equal(await fs.readFile(occupied, "utf8"), "not a marker\n");
  assert.equal((await fs.lstat(occupied)).isSymbolicLink(), false);

  const marked = path.join(dir, "marked");
  const markedData = path.join(dir, "marked-data");
  const vaultTarget = path.join(dir, "vault-target.txt");
  const dataTarget = path.join(dir, "data-target.txt");
  await fs.writeFile(vaultTarget, "vault-keep\n");
  await fs.writeFile(dataTarget, "data-keep\n");
  await fs.mkdir(path.join(marked, ".aidanos"), { recursive: true });
  await fs.mkdir(markedData, { recursive: true });
  await fs.symlink(vaultTarget, path.join(marked, ".aidanos", "relay-folder"));
  await fs.symlink(dataTarget, path.join(markedData, "relay-folder"));
  await assert.rejects(
    startRelay({ token: TOKEN, vault: marked, data: markedData, port: 0, gitUrl: "" }),
  );
  assert.equal(await fs.readFile(vaultTarget, "utf8"), "vault-keep\n");
  assert.equal(await fs.readFile(dataTarget, "utf8"), "data-keep\n");
  assert.equal((await fs.lstat(path.join(marked, ".aidanos", "relay-folder"))).isSymbolicLink(), true);
  assert.equal((await fs.lstat(path.join(markedData, "relay-folder"))).isSymbolicLink(), true);
});

test("reset recreates a data folder inside the notes folder", async () => {
  const dir = await tempDir();
  const vault = path.join(dir, "vault");
  const relay = await startRelay({
    token: TOKEN,
    vault,
    port: 0,
    gitUrl: "",
    allowReset: true,
  });
  try {
    const data = path.join(vault, ".aidanos", "relay");
    const marker = await fs.readFile(path.join(data, "relay-folder"), "utf8");
    assert.notEqual(relayMarkerId(marker), "");
    const first = await fetch(relay.healthURL);
    assert.equal(first.status, 200);
    const body = await first.json();
    assert.equal(body.ok, true);
    assert.equal(body.status, "ok");
    const id = noteId("notes/nested-reset.md");
    await importDoc(relay.repo, id, { kind: "note", text: "secret-before-reset" });
    await relay.repo.flush();
    const previous = relay.repo;
    const accepted = await fetch(relay.healthURL.replace("/health", "/reset"), {
      method: "POST",
      headers: { Authorization: "Bearer " + TOKEN },
    });
    assert.equal(accepted.status, 200);
    const deadline = Date.now() + 5000;
    let after = null;
    while (Date.now() < deadline) {
      const again = await fetch(relay.healthURL + "?n=" + Date.now());
      const parsed = await again.json();
      if (again.status === 200 && parsed.bootedAt !== body.bootedAt) {
        after = { status: again.status, body: parsed };
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.ok(after);
    assert.equal(after.status, 200);
    assert.equal(after.body.ok, true);
    assert.equal(after.body.status, "ok");
    assert.notEqual(relay.repo, previous);
    assert.equal(await relay.repo.storageSubsystem.loadDoc(id), null);
    await fs.stat(data);
    assert.equal(await fs.readFile(path.join(data, "relay-folder"), "utf8"), marker);
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

test("a failed reset makes health report sync down", async () => {
  const dir = await tempDir();
  const relay = await startRelay({
    token: TOKEN,
    vault: path.join(dir, "vault"),
    port: 0,
    gitUrl: "",
    allowReset: true,
    beforeReopen() {
      throw new Error("forced reset failure");
    },
  });
  try {
    const accepted = await fetch(relay.healthURL.replace("/health", "/reset"), {
      method: "POST",
      headers: { Authorization: "Bearer " + TOKEN },
    });
    assert.equal(accepted.status, 200);
    const deadline = Date.now() + 5000;
    let down = null;
    while (Date.now() < deadline) {
      const again = await fetch(relay.healthURL + "?n=" + Date.now());
      if (again.status !== 200) {
        down = { status: again.status, body: await again.json() };
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.ok(down);
    assert.notEqual(down.status, 200);
    assert.equal(down.body.ok, false);
    assert.equal(down.body.status, "sync down");
    await new Promise((resolve) => setTimeout(resolve, 400));
    const still = await fetch(relay.healthURL + "?n=" + Date.now());
    const stillBody = await still.json();
    assert.equal(still.status, 503);
    assert.equal(stillBody.ok, false);
    assert.equal(stillBody.status, "sync down");
    const opened = await Promise.race([
      connect(relay.url, TOKEN),
      new Promise((_, reject) => setTimeout(() => reject(new Error("connect timed out")), 2000)),
    ]);
    assert.equal(opened.opened, false);
  } finally {
    await relay.close();
  }
});

test("a token with spaces is refused before the relay listens", async () => {
  const spaced = "several words you can remember today";
  assert.ok(spaced.length >= 32);
  await assert.rejects(loadToken({ AIDANOS_RELAY_TOKEN: spaced }), /whitespace/);
  const dir = await tempDir();
  const file = path.join(dir, "token");
  await fs.writeFile(file, spaced + "\n", { mode: 0o600 });
  await assert.rejects(loadToken({ AIDANOS_RELAY_TOKEN_FILE: file }), /whitespace/);
  await fs.writeFile(file, TOKEN + "\n\n", { mode: 0o600 });
  await assert.rejects(loadToken({ AIDANOS_RELAY_TOKEN_FILE: file }), /whitespace/);
  await fs.writeFile(file, TOKEN + "\n", { mode: 0o600 });
  assert.equal(await loadToken({ AIDANOS_RELAY_TOKEN_FILE: file }), TOKEN);
  await assert.rejects(
    startRelay({ token: spaced, vault: path.join(dir, "vault"), port: 0, gitUrl: "" }),
    /whitespace/,
  );
  await assert.rejects(fs.stat(path.join(dir, "vault")));
});

test("zero or a nonsense payload cap stays at 4 MB", () => {
  assert.equal(payloadLimit(0), MAX_PAYLOAD);
  assert.equal(payloadLimit("0"), MAX_PAYLOAD);
  assert.equal(payloadLimit("nope"), MAX_PAYLOAD);
  assert.equal(payloadLimit(""), MAX_PAYLOAD);
  assert.equal(payloadLimit(undefined), MAX_PAYLOAD);
  assert.equal(payloadLimit(64), 64);
});

test("wrong reset guesses count toward the block", async () => {
  const dir = await tempDir();
  const relay = await startRelay({
    token: TOKEN,
    vault: path.join(dir, "vault"),
    data: path.join(dir, "data"),
    port: 0,
    gitUrl: "",
    allowReset: true,
    guessLimit: 2,
    guessBlockMs: 60_000,
  });
  try {
    const reset = (header) =>
      fetch(relay.healthURL.replace("/health", "/reset"), {
        method: "POST",
        headers: header ? { Authorization: header } : {},
      });
    assert.equal((await reset("Bearer nope")).status, 401);
    assert.equal((await reset("Bearer nope")).status, 401);
    assert.equal((await reset("Bearer " + TOKEN)).status, 401);
  } finally {
    await relay.close();
  }
});

test("a ../ storage id closes the connection and stays inside the data folder", async () => {
  const parent = await tempDir();
  const data = path.join(parent, "data");
  const relay = await startRelay({
    token: TOKEN,
    vault: path.join(parent, "vault"),
    data,
    port: 0,
    gitUrl: "",
    mirrorDebounceMs: 1000,
  });
  try {
    const before = new Set(await filesUnder(parent));
    const frame = cbor.encode({
      type: "join",
      senderId: "phone-1",
      supportedProtocolVersions: ["1"],
      peerMetadata: { storageId: "../", isEphemeral: false },
    });
    await expectClosed(relay.url, [frame]);
    await new Promise((resolve) => setTimeout(resolve, 300));
    for (const file of await filesUnder(parent)) {
      if (before.has(file)) continue;
      assert.equal(file.startsWith(data + path.sep), true, file);
    }
    await assert.rejects(fs.stat(path.join(parent, "sync-state")));
  } finally {
    await relay.close();
  }
});

test("a bad document id closes the connection and stays inside the data folder", async () => {
  const parent = await tempDir();
  const data = path.join(parent, "data");
  const relay = await startRelay({
    token: TOKEN,
    vault: path.join(parent, "vault"),
    data,
    port: 0,
    gitUrl: "",
    mirrorDebounceMs: 1000,
  });
  try {
    const before = new Set(await filesUnder(parent));
    const join = cbor.encode({
      type: "join",
      senderId: "phone-1",
      supportedProtocolVersions: ["1"],
      peerMetadata: { storageId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", isEphemeral: false },
    });
    const request = cbor.encode({
      type: "request",
      senderId: "phone-1",
      targetId: "aidanos-relay",
      documentId: "../",
      data: Buffer.from([1, 2, 3, 4]),
    });
    await expectClosed(relay.url, [join, request]);
    await new Promise((resolve) => setTimeout(resolve, 300));
    for (const file of await filesUnder(parent)) {
      if (before.has(file)) continue;
      assert.equal(file.startsWith(data + path.sep), true, file);
    }
    await assert.rejects(fs.stat(path.join(parent, "sync-state")));
  } finally {
    await relay.close();
  }
});

async function filesUnder(root) {
  const out = [];
  async function walk(dir) {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (error) {
      if (error && error.code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else out.push(full);
    }
  }
  await walk(root);
  return out;
}

function expectPeer(url, frame) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers: { Authorization: "Bearer " + TOKEN } });
    const timer = setTimeout(() => {
      ws.terminate();
      reject(new Error("the relay did not answer the join"));
    }, 2500);
    ws.on("open", () => ws.send(frame));
    ws.on("message", (data) => {
      let message;
      try {
        message = cbor.decode(data);
      } catch {
        return;
      }
      if (!message || message.type !== "peer") return;
      clearTimeout(timer);
      ws.close();
      resolve(message);
    });
    ws.on("error", () => {});
  });
}

function expectClosed(url, frames) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers: { Authorization: "Bearer " + TOKEN } });
    const timer = setTimeout(() => {
      ws.terminate();
      reject(new Error("connection stayed open"));
    }, 2500);
    ws.on("open", () => {
      for (const frame of frames) ws.send(frame);
    });
    ws.on("close", () => {
      clearTimeout(timer);
      resolve();
    });
    ws.on("error", () => {});
  });
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
