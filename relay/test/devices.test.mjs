import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import {
  deviceFilePath,
  issueDevice,
  parseDeviceRecord,
  readDeviceFile,
  restoreSharedKey,
  retireSharedKey,
  revokeDevice,
} from "../src/devices.mjs";
import { connectionAllowed, parseArgs, startRelay, startupLines } from "../src/server.mjs";

// Assertions below never interpolate a key into a message. A failure prints
// true/false, not the key.

const TOKEN = "aidanos-test-token-0123456789abcdef";
const exec = promisify(execFile);
const serverPath = fileURLToPath(new URL("../src/server.mjs", import.meta.url));

async function tempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), "aidanos-devices-"));
}

function keyFromAnnouncement(stdout) {
  const marker = "It is shown once.\n";
  const at = String(stdout).indexOf(marker);
  if (at < 0) throw new Error("the one-time line was missing");
  const key = String(stdout)
    .slice(at + marker.length)
    .split("\n")[0];
  if (!key || key.length < 32) throw new Error("the one-time line was missing");
  return key;
}

async function runNode(args, env) {
  try {
    const result = await exec(process.execPath, [serverPath, ...args], {
      env: { PATH: process.env.PATH || "", HOME: process.env.HOME || "", ...env },
      timeout: 20000,
    });
    return { stdout: String(result.stdout), stderr: String(result.stderr), failed: false };
  } catch (error) {
    const stdout = String(error.stdout || "");
    const stderr = String(error.stderr || "");
    for (const value of Object.values(env)) {
      if (value && String(value).length >= 32 && (stdout.includes(value) || stderr.includes(value))) {
        throw new Error("a key appeared where it must not");
      }
    }
    return { stdout, stderr, failed: true };
  }
}

function connect(url, token) {
  return new Promise((resolve) => {
    const ws = new WebSocket(url, { headers: { Authorization: "Bearer " + token } });
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    ws.on("open", () => finish({ opened: true, socket: ws, status: 101 }));
    ws.on("unexpected-response", (_req, res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        finish({ opened: false, status: res.statusCode, body: Buffer.concat(chunks).toString("utf8"), socket: ws });
      });
    });
    ws.on("error", () => {
      setTimeout(() => finish({ opened: false, status: 0, body: "", socket: ws }), 50);
    });
  });
}

function decision(record, presented) {
  return connectionAllowed({ sharedToken: TOKEN, record, presented });
}

async function relayDirs() {
  const dir = await tempDir();
  return { dir, vault: path.join(dir, "vault"), data: path.join(dir, "data") };
}

async function boot(dir, extra = {}) {
  return startRelay({
    token: TOKEN,
    vault: dir.vault,
    data: dir.data,
    port: 0,
    gitUrl: "",
    mirrorDebounceMs: 1000,
    ...extra,
  });
}

test("an unknown key is refused and a device key is accepted", async () => {
  const dirs = await relayDirs();
  const relay = await boot(dirs);
  const seen = [];
  const write = console.error;
  console.error = (line) => seen.push(String(line));
  try {
    const mac = await issueDevice(dirs.data, "Mac");
    const record = await readDeviceFile(dirs.data);
    const unknown = mac.key.slice(0, -1) + (mac.key.endsWith("a") ? "b" : "a");
    assert.equal(decision(record, unknown).ok, false);
    assert.equal(decision(record, unknown).refusal, "unknown");
    assert.equal(decision(record, mac.key).ok, true);
    assert.equal(decision(record, mac.key).refusal, "");
    const stored = await fs.readFile(deviceFilePath(dirs.data), "utf8");
    assert.equal(stored.includes(mac.key), false);
    assert.equal(stored.includes(TOKEN), false);
    assert.equal((await fs.stat(deviceFilePath(dirs.data))).mode & 0o777, 0o600);
    const refused = await connect(relay.url, unknown);
    assert.equal(refused.opened, false);
    assert.equal(refused.status, 401);
    assert.equal(refused.body === "unauthorized", true);
    const opened = await connect(relay.url, mac.key);
    assert.equal(opened.opened, true);
    opened.socket.close();
    const logs = seen.join("\n");
    assert.equal(logs.includes(mac.key), false);
    assert.equal(logs.includes(unknown), false);
    assert.equal(logs.includes(TOKEN), false);
  } finally {
    console.error = write;
    await relay.close();
  }
});

test("a removed device key is refused and the other device still works", async () => {
  const dirs = await relayDirs();
  const relay = await boot(dirs);
  const mac = await issueDevice(dirs.data, "Mac");
  const phone = await issueDevice(dirs.data, "iPhone");
  assert.equal(mac.key === phone.key, false);
  await assert.rejects(issueDevice(dirs.data, "Mac"), /already has a key/);
  await revokeDevice(dirs.data, "Mac");
  const record = await readDeviceFile(dirs.data);
  assert.equal(decision(record, mac.key).ok, false);
  assert.equal(decision(record, mac.key).refusal, "removed");
  assert.equal(decision(record, phone.key).ok, true);
  try {
    const removed = await connect(relay.url, mac.key);
    assert.equal(removed.opened, false);
    assert.equal(removed.status, 401);
    assert.equal(removed.body === "unauthorized", true);
    const other = await connect(relay.url, phone.key);
    assert.equal(other.opened, true);
    other.socket.close();
    const shared = await connect(relay.url, TOKEN);
    assert.equal(shared.opened, true);
    shared.socket.close();
  } finally {
    await relay.close();
  }
  const stored = await fs.readFile(deviceFilePath(dirs.data), "utf8");
  assert.equal(stored.includes(mac.key), false);
  assert.equal(stored.includes(phone.key), false);
});

test("an unknown key and a removed key look the same on the wire", async () => {
  const dirs = await relayDirs();
  const relay = await boot(dirs);
  const mac = await issueDevice(dirs.data, "Mac");
  const phone = await issueDevice(dirs.data, "iPhone");
  await revokeDevice(dirs.data, "Mac");
  const unknown = phone.key.slice(0, -1) + (phone.key.endsWith("a") ? "b" : "a");
  try {
    const removed = await connect(relay.url, mac.key);
    const stranger = await connect(relay.url, unknown);
    assert.equal(removed.status, 401);
    assert.equal(stranger.status, 401);
    assert.equal(removed.body === stranger.body, true);
    assert.equal(removed.body === "unauthorized", true);
    assert.equal(removed.body.includes(mac.key), false);
    assert.equal(stranger.body.includes(unknown), false);
  } finally {
    await relay.close();
  }
});

test("retiring the shared key refuses it, and restoring accepts it again", async () => {
  const dirs = await relayDirs();
  const tokenFile = path.join(dirs.dir, "token");
  await fs.writeFile(tokenFile, TOKEN + "\n", { mode: 0o600 });
  const before = await fs.readFile(tokenFile);
  const relay = await boot(dirs);
  const phone = await issueDevice(dirs.data, "iPhone");
  assert.equal(decision(await readDeviceFile(dirs.data), TOKEN).ok, true);
  await assert.rejects(retireSharedKey(path.join(dirs.dir, "empty")), /at least one device/);
  await retireSharedKey(dirs.data);
  const retired = await readDeviceFile(dirs.data);
  assert.equal(decision(retired, TOKEN).ok, false);
  assert.equal(decision(retired, TOKEN).refusal, "retired");
  assert.equal(decision(retired, phone.key).ok, true);
  try {
    const shared = await connect(relay.url, TOKEN);
    assert.equal(shared.opened, false);
    assert.equal(shared.status, 401);
    assert.equal(shared.body === "unauthorized", true);
    const device = await connect(relay.url, phone.key);
    assert.equal(device.opened, true);
    device.socket.close();
    await restoreSharedKey(dirs.data);
    const again = await connect(relay.url, TOKEN);
    assert.equal(again.opened, true);
    again.socket.close();
  } finally {
    await relay.close();
  }
  assert.deepEqual(await fs.readFile(tokenFile), before);
  await fs.rm(deviceFilePath(dirs.data));
  const bare = await boot(dirs);
  try {
    const shared = await connect(bare.url, TOKEN);
    assert.equal(shared.opened, true);
    shared.socket.close();
    const old = await connect(bare.url, phone.key);
    assert.equal(old.opened, false);
    assert.equal(old.status, 401);
  } finally {
    await bare.close();
  }
});

test("the last device key cannot be removed while the shared key is off", async () => {
  const dirs = await relayDirs();
  const mac = await issueDevice(dirs.data, "Mac");
  const phone = await issueDevice(dirs.data, "iPhone");
  await revokeDevice(dirs.data, "Mac");
  await retireSharedKey(dirs.data);
  await assert.rejects(revokeDevice(dirs.data, "iPhone"), /last device key/);
  assert.equal(decision(await readDeviceFile(dirs.data), phone.key).ok, true);
  assert.equal(decision(await readDeviceFile(dirs.data), mac.key).refusal, "removed");
  const replacement = await issueDevice(dirs.data, "Mac");
  assert.equal(decision(await readDeviceFile(dirs.data), mac.key).refusal, "removed");
  assert.equal(decision(await readDeviceFile(dirs.data), replacement.key).ok, true);
  await revokeDevice(dirs.data, "iPhone");
  assert.equal(decision(await readDeviceFile(dirs.data), phone.key).refusal, "removed");
  assert.equal(decision(await readDeviceFile(dirs.data), replacement.key).ok, true);
});

test("a bad device name is refused without being repeated", async () => {
  const dirs = await relayDirs();
  const nasty = "Mac\n" + TOKEN;
  await assert.rejects(issueDevice(dirs.data, nasty), (error) => {
    assert.equal(error.message.includes(TOKEN), false);
    assert.equal(error.message.includes("\n"), false);
    assert.match(error.message, /Mac or iPhone/);
    return true;
  });
  await assert.rejects(fs.stat(deviceFilePath(dirs.data)));
});

test("a loose, linked, or broken device file refuses to start", async () => {
  const dirs = await relayDirs();
  const first = await boot(dirs);
  await first.close();
  await issueDevice(dirs.data, "Mac");
  await fs.chmod(deviceFilePath(dirs.data), 0o644);
  await assert.rejects(boot(dirs), /0600/);
  await fs.chmod(deviceFilePath(dirs.data), 0o600);

  const sentinel = "SENTINEL-SECRET-DO-NOT-READ";
  const target = path.join(dirs.data, "elsewhere");
  await fs.writeFile(target, sentinel + "\n", { mode: 0o600 });
  await fs.rm(deviceFilePath(dirs.data));
  await fs.symlink(target, deviceFilePath(dirs.data));
  await assert.rejects(boot(dirs), (error) => {
    assert.equal(error.message.includes(sentinel), false);
    assert.match(error.message, /regular file/);
    return true;
  });
  await fs.rm(deviceFilePath(dirs.data));

  await fs.writeFile(deviceFilePath(dirs.data), "{", { mode: 0o600 });
  await fs.chmod(deviceFilePath(dirs.data), 0o600);
  await assert.rejects(boot(dirs), (error) => {
    assert.equal(error.message.includes("{"), false);
    assert.match(error.message, /unreadable/);
    return true;
  });
  await fs.writeFile(deviceFilePath(dirs.data), JSON.stringify({ version: 2, shared: "active", devices: [] }), {
    mode: 0o600,
  });
  await fs.chmod(deviceFilePath(dirs.data), 0o600);
  assert.throws(() => parseDeviceRecord("{not json"), /unreadable/);
  await assert.rejects(boot(dirs), /will not guess/);
});

test("a notes reset keeps device keys and does not bring a removed key back", async () => {
  const dir = await tempDir();
  const vault = path.join(dir, "vault");
  const relay = await startRelay({
    token: TOKEN,
    vault,
    port: 0,
    gitUrl: "",
    allowReset: true,
    mirrorDebounceMs: 1000,
  });
  const data = path.join(vault, ".aidanos", "relay");
  const mac = await issueDevice(data, "Mac");
  const phone = await issueDevice(data, "iPhone");
  await revokeDevice(data, "Mac");
  try {
    await fs.writeFile(path.join(vault, "leftover.txt"), "still here");
    const before = await (await fetch(relay.healthURL)).json();
    const accepted = await fetch(relay.healthURL.replace("/health", "/reset"), {
      method: "POST",
      headers: { Authorization: "Bearer " + TOKEN },
    });
    assert.equal(accepted.status, 200);
    const deadline = Date.now() + 5000;
    let restarted = false;
    while (Date.now() < deadline) {
      const again = await fetch(relay.healthURL + "?n=" + Date.now());
      const body = await again.json();
      if (again.status === 200 && body.bootedAt !== before.bootedAt) {
        restarted = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(restarted, true);
    await assert.rejects(fs.stat(path.join(vault, "leftover.txt")));
    const stored = await fs.readFile(deviceFilePath(data), "utf8");
    assert.equal(stored.includes(mac.key), false);
    assert.equal(stored.includes(phone.key), false);
    assert.equal((await fs.stat(deviceFilePath(data))).mode & 0o777, 0o600);
    const removed = await connect(relay.url, mac.key);
    assert.equal(removed.status, 401);
    const live = await connect(relay.url, phone.key);
    assert.equal(live.opened, true);
    live.socket.close();
  } finally {
    await relay.close();
  }
});

test("too many unknown keys block the next device key as well", async () => {
  const dirs = await relayDirs();
  const relay = await boot(dirs, { guessLimit: 2, guessBlockMs: 60_000 });
  const mac = await issueDevice(dirs.data, "Mac");
  try {
    assert.equal((await connect(relay.url, "nope")).status, 401);
    const opened = await connect(relay.url, mac.key);
    assert.equal(opened.opened, true);
    opened.socket.close();
    assert.equal((await connect(relay.url, "nope")).status, 401);
    const again = await connect(relay.url, mac.key);
    assert.equal(again.opened, true);
    again.socket.close();
    assert.equal((await connect(relay.url, "nope")).status, 401);
    assert.equal((await connect(relay.url, "nope")).status, 401);
    const blocked = await connect(relay.url, mac.key);
    assert.equal(blocked.opened, false);
    assert.equal(blocked.status, 401);
  } finally {
    await relay.close();
  }
});

test("a hosted relay stays on 127.0.0.1 and will not add the home network", async () => {
  const lines = startupLines({ lan: false, port: 3750, behindProxy: true });
  assert.equal(lines.some((line) => line.includes("127.0.0.1")), true);
  assert.equal(lines.some((line) => line.includes("0.0.0.0")), false);
  assert.equal(lines.some((line) => line.includes("PHONE")), false);
  const dirs = await relayDirs();
  await assert.rejects(boot(dirs, { lan: true, behindProxy: true }), /127\.0\.0\.1/);
  const relay = await boot(dirs, { behindProxy: true, env: { AIDANOS_RELAY_BEHIND_PROXY: "1" } });
  try {
    assert.deepEqual(relay.hosts, ["127.0.0.1"]);
    assert.equal(relay.behindProxy, true);
    const health = await fetch(relay.healthURL);
    assert.equal(health.status, 200);
  } finally {
    await relay.close();
  }
});

test("device commands parse without reading a key from the command line", () => {
  assert.throws(() => parseArgs(["--token", "nope"]), /command line/);
  assert.throws(() => parseArgs(["--issue-device"]), /Mac or iPhone/);
  assert.throws(() => parseArgs(["--issue-device", "--vault"]), /Mac or iPhone/);
  assert.throws(() => parseArgs(["--issue-device", "Mac", "--revoke-device", "iPhone"]), /one device command/);
  const parsed = parseArgs(["--vault", "notes", "--data", "data", "--issue-device", "iPhone", "--behind-proxy"]);
  assert.equal(parsed.deviceCommand.action, "--issue-device");
  assert.equal(parsed.deviceCommand.name, "iPhone");
  assert.equal(parsed.behindProxy, true);
  assert.equal(parsed.vault, "notes");
});

test("the issue command shows a key once and does not change the shared-key file", async () => {
  const dirs = await relayDirs();
  const tokenFile = path.join(dirs.dir, "token");
  await fs.writeFile(tokenFile, TOKEN + "\n", { mode: 0o600 });
  const before = await fs.readFile(tokenFile);
  const env = { AIDANOS_RELAY_TOKEN_FILE: tokenFile };
  const args = ["--vault", dirs.vault, "--data", dirs.data, "--issue-device", "Mac"];
  assert.equal(args.some((part) => part.includes(TOKEN)), false);
  const issued = await runNode(args, env);
  if (issued.failed) {
    const detail = issued.stdout.includes("shown once") ? "output withheld" : issued.stderr.slice(0, 400);
    throw new Error("device command failed: " + detail);
  }
  const key = keyFromAnnouncement(issued.stdout);
  assert.equal(issued.stdout.includes("shown once"), true);
  assert.equal(issued.stderr.includes(key), false);
  assert.equal(issued.stderr.includes("issued a device key"), true);
  const stored = await fs.readFile(deviceFilePath(dirs.data), "utf8");
  assert.equal(stored.includes(key), false);
  assert.equal(stored.includes(TOKEN), false);
  const record = await readDeviceFile(dirs.data);
  assert.equal(record.devices[0].hash === key, false);
  const listed = await runNode(["--vault", dirs.vault, "--data", dirs.data, "--list-devices"], env);
  assert.equal(listed.failed, false);
  assert.equal(listed.stdout.includes("Mac active"), true);
  assert.equal(listed.stdout.includes(key), false);
  assert.equal(listed.stdout.includes(record.devices[0].hash), false);
  const retired = await runNode(["--vault", dirs.vault, "--data", dirs.data, "--retire-shared-key"], env);
  assert.equal(retired.failed, false);
  assert.equal(retired.stdout.length, 0);
  assert.equal(retired.stderr.includes("was not changed"), true);
  assert.equal(retired.stderr.includes(key), false);
  assert.equal(retired.stderr.includes(TOKEN), false);
  const restored = await runNode(["--vault", dirs.vault, "--data", dirs.data, "--restore-shared-key"], env);
  assert.equal(restored.failed, false);
  assert.equal(restored.stderr.includes(key), false);
  assert.deepEqual(await fs.readFile(tokenFile), before);
  const removed = await runNode(["--vault", dirs.vault, "--data", dirs.data, "--revoke-device", "Mac"], env);
  assert.equal(removed.failed, false);
  assert.equal(removed.stderr.includes(key), false);
  assert.equal(decision(await readDeviceFile(dirs.data), key).refusal, "removed");
});

test("the hosting note says what Colby has to do and does not open a public bind", async () => {
  const hosting = await fs.readFile(new URL("../../docs/native/HOSTING.md", import.meta.url), "utf8");
  assert.equal(hosting.includes("Colby"), true);
  assert.equal(hosting.includes("fresh"), true);
  assert.equal(hosting.includes("127.0.0.1"), true);
  assert.equal(hosting.includes("0.0.0.0"), false);
  assert.equal(hosting.includes("wss://"), true);
  assert.equal(hosting.includes("--behind-proxy"), true);
  assert.equal(hosting.includes("AIDANOS_RELAY_TOKEN="), false);
  const design = await fs.readFile(new URL("../../docs/native/DESIGN.md", import.meta.url), "utf8");
  assert.equal(design.includes("own key"), true);
  assert.equal(design.includes("--restore-shared-key"), true);
});
