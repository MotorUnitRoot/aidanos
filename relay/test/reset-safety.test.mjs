import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import http from "node:http";
import { WebSocket } from "ws";
import { trustedRelayHosts } from "../src/request-safety.mjs";
import path from "node:path";
import { assertNoServe, hasProxyHints, readServeStatus, resetTestMode } from "../src/reset-safety.mjs";
import { parseArgs, startRelay } from "../src/server.mjs";
import { parseHarnessArgs } from "./harness/server.mjs";

const TOKEN = "aidanos-test-token-0123456789abcdef";
const ADMIN_TOKEN = "aidanos-admin-fixture-9876543210abcdef";
const auth = { authorization: "Bearer " + ADMIN_TOKEN };
const tempDir = () => fs.mkdtemp(path.join(os.tmpdir(), "aidanos-reset-safety-"));

async function fakeTailscale(status) {
  const dir = await tempDir();
  const state = path.join(dir, "status.json");
  await fs.writeFile(state, status + "\n");
  await fs.writeFile(path.join(dir, "tailscale"), `#!/bin/sh
[ "$#" = 3 ] && [ "$1" = serve ] && [ "$2" = status ] && [ "$3" = --json ] || exit 8
IFS= read -r status < '${state}'
[ "$status" != CLI_ERROR ] || exit 9
printf '%s\n' "$status"
`, { mode: 0o700 });
  return { dir, state, env: { NODE_ENV: "test", PATH: dir } };
}

function options(dir, extra = {}) {
  return { token: TOKEN, vault: path.join(dir, "vault"), data: path.join(dir, "data"),
    port: 0, gitUrl: "", allowReset: true, resetAdminToken: ADMIN_TOKEN, testMode: true,
    env: { NODE_ENV: "test", PATH: "" }, ...extra };
}

test("reset needs the explicit harness flag AND NODE_ENV=test", () => {
  assert.throws(() => parseArgs(["--test-mode"]), /Unknown argument/);
  assert.throws(() => parseHarnessArgs([]), /requires --test-mode/);
  assert.equal(parseHarnessArgs(["--test-mode", "--port", "3757"]).port, 3757);
  assert.equal(resetTestMode(true, { NODE_ENV: "test" }), true);
  for (const flag of [undefined, false]) assert.equal(resetTestMode(flag, { NODE_ENV: "test" }), false);
  for (const env of [{}, { NODE_ENV: "production" }, { NODE_ENV: "development" }]) {
    assert.equal(resetTestMode(true, env), false);
  }
});

test("production and missing-test-mode requests cannot reset even with the opt-in variable", async () => {
  const cases = [
    { testMode: false, env: { NODE_ENV: "test", AIDANOS_RELAY_ALLOW_RESET: "1", PATH: "" } },
    { testMode: true, env: { NODE_ENV: "production", AIDANOS_RELAY_ALLOW_RESET: "1", PATH: "" } },
    { testMode: true, env: { AIDANOS_RELAY_ALLOW_RESET: "1", PATH: "" } },
    { testMode: true, allowReset: false, env: { NODE_ENV: "test", PATH: "" } },
  ];
  for (const extra of cases) {
    const dir = await tempDir();
    const relay = await startRelay(options(dir, extra));
    try {
      const sentinel = path.join(relay.vault, "keep.md");
      await fs.writeFile(sentinel, "keep fixture\n");
      const res = await fetch(relay.healthURL.replace("/health", "/reset"), { method: "POST", headers: auth });
      assert.equal(res.status, 404);
      assert.equal(await fs.readFile(sentinel, "utf8"), "keep fixture\n");
    } finally { await relay.close(); }
  }
});

test("all proxy hint names are refused, even empty or mixed-case headers", () => {
  assert.equal(hasProxyHints({ host: "localhost", authorization: "fixture" }), false);
  for (const name of ["Forwarded", "fOrWaRdEd", "X-Forwarded-For", "X-Forwarded-Host",
    "x-forwarded-proto", "X-Forwarded-Anything", "Tailscale-User-Login", "TAILSCALE-Anything"]) {
    assert.equal(hasProxyHints({ [name]: "" }), true, name);
  }
});

test("live reset route rejects proxy headers on an otherwise valid loopback test request", async () => {
  const dir = await tempDir();
  let resets = 0;
  const relay = await startRelay(options(dir, { onReset: () => { resets += 1; } }));
  try {
    const sentinel = path.join(relay.vault, "keep.md");
    await fs.writeFile(sentinel, "keep fixture\n");
    const url = relay.healthURL.replace("/health", "/reset");
    // Prove this is an enabled reset endpoint, not just a disabled-route 404.
    assert.equal((await fetch(url, { method: "POST" })).status, 401);
    for (const [name, value] of [["Forwarded", "for=127.0.0.1"], ["X-Forwarded-For", "127.0.0.1"],
      ["X-Forwarded-Proto", "https"], ["X-Forwarded-Host", "localhost"],
      ["Tailscale-User-Login", "fixture"], ["Tailscale-Anything", ""]]) {
      const res = await fetch(url, { method: "POST", headers: { ...auth, [name]: value } });
      assert.equal(res.status, 404, name);
      assert.equal(await fs.readFile(sentinel, "utf8"), "keep fixture\n");
    }
    assert.equal(resets, 0);
  } finally { await relay.close(); }
});

test("Serve preflight accepts only absent or empty configuration and fails closed", () => {
  for (const status of [null, "null", "{}", '{"TCP":{},"Web":{},"AllowFunnel":{},"Services":{}}']) {
    assert.doesNotThrow(() => assertNoServe(() => status));
  }
  for (const config of [{ TCP: { "443": { TCPForward: "127.0.0.1:3750" } } },
    { Web: { "node:443": { Handlers: { "/": { Proxy: "http://127.0.0.1:3750" } } } } },
    { AllowFunnel: { "node:443": true } }, { AllowFunnel: { "node:443": false } },
    { Services: { "svc:fixture": { TCP: { "443": {} } } } }, { NewConfig: true }, []]) {
    assert.throws(() => assertNoServe(() => JSON.stringify(config)), /Serve\/Funnel/);
  }
  for (const raw of ["", "broken JSON", "true", "0"]) {
    assert.throws(() => assertNoServe(() => raw), /Serve\/Funnel/);
  }
  assert.throws(() => assertNoServe(() => { throw new Error("fixture command error"); }), /refused/);
});

test("installed Serve command errors and configured proxying refuse startup before any folder write", async () => {
  for (const status of ['{"TCP":{"443":{"TCPForward":"127.0.0.1:3750"}}}', "CLI_ERROR", "broken JSON"]) {
    const fake = await fakeTailscale(status);
    const vault = path.join(fake.dir, "vault");
    await assert.rejects(startRelay(options(fake.dir, { env: fake.env })), /Serve\/Funnel/);
    await assert.rejects(fs.stat(vault), { code: "ENOENT" });
  }
  const broken = await tempDir();
  await fs.writeFile(path.join(broken, "tailscale"), "#!/missing-interpreter-for-fixture\n", { mode: 0o700 });
  assert.throws(() => readServeStatus({ PATH: broken }), /refused/);
  assert.equal(readServeStatus({ PATH: await tempDir() }), null);
});

test("Serve config or CLI failure introduced after startup also refuses reset without deleting", async () => {
  const fake = await fakeTailscale("{}");
  const relay = await startRelay(options(fake.dir, { env: fake.env }));
  try {
    const sentinel = path.join(relay.vault, "keep.md");
    await fs.writeFile(sentinel, "keep fixture\n");
    for (const config of ['{"AllowFunnel":{"node:443":true}}', "CLI_ERROR"]) {
      await fs.writeFile(fake.state, config + "\n");
      const res = await fetch(relay.healthURL.replace("/health", "/reset"), { method: "POST", headers: auth });
      assert.equal(res.status, 503);
      assert.equal(await fs.readFile(sentinel, "utf8"), "keep fixture\n");
    }
  } finally { await relay.close(); }
});


test("test reset rejects missing or shared sync/admin credentials at startup", async () => {
  for (const resetAdminToken of ["", "short", TOKEN]) {
    const dir = await tempDir();
    await assert.rejects(startRelay(options(dir, { resetAdminToken })), /separate admin credential/);
    await assert.rejects(fs.stat(path.join(dir, "vault")), { code: "ENOENT" });
  }
});

test("a header-stripping loopback proxy with the sync token cannot reset", async () => {
  const dir = await tempDir();
  const relay = await startRelay(options(dir));
  const target = new URL(relay.healthURL.replace("/health", "/reset"));
  const proxy = http.createServer((req, res) => {
    // Simulate the worst case: a local proxy strips all forwarding hints and
    // rewrites Host correctly. The *separate admin authority* must still stop it.
    const upstream = http.request(target, { method: "POST", headers: {
      host: target.host, authorization: req.headers.authorization || "",
    } }, (reply) => { res.writeHead(reply.statusCode); reply.pipe(res); });
    upstream.on("error", () => { res.writeHead(502); res.end(); });
    upstream.end();
  });
  try {
    await new Promise((resolve, reject) => {
      proxy.once("error", reject); proxy.listen(0, "127.0.0.1", resolve);
    });
    const sentinel = path.join(relay.vault, "keep.md");
    await fs.writeFile(sentinel, "keep fixture\n");
    const response = await fetch("http://127.0.0.1:" + proxy.address().port + "/reset", {
      method: "POST", headers: { authorization: "Bearer " + TOKEN },
    });
    assert.equal(response.status, 401);
    assert.equal(await fs.readFile(sentinel, "utf8"), "keep fixture\n");
  } finally {
    proxy.closeAllConnections();
    await new Promise((resolve) => proxy.close(resolve));
    await relay.close();
  }
});

test("foreign Host or any browser Origin fails closed for HTTP and WebSocket, with or without sync token", async () => {
  const dir = await tempDir();
  const relay = await startRelay(options(dir));
  const upgradeStatus = (headers) => new Promise((resolve, reject) => {
    const ws = new WebSocket(relay.url, { headers });
    ws.on("unexpected-response", (_req, res) => { res.resume(); ws.terminate(); resolve(res.statusCode); });
    ws.on("open", () => { ws.terminate(); resolve(101); });
    ws.on("error", reject);
  });
  try {
    for (const extra of [{ host: "foreign.example:3750" }, { origin: "https://foreign.example" }]) {
      for (const token of ["", TOKEN]) {
        const headers = { ...extra, ...(token ? { authorization: "Bearer " + token } : {}) };
        assert.equal((await fetch(relay.healthURL, { headers })).status, 403);
        assert.equal(await upgradeStatus(headers), 403);
      }
    }
    assert.equal((await fetch(relay.healthURL)).status, 200);
    assert.deepEqual(trustedRelayHosts("relay.tail.ts.net:443"), ["relay.tail.ts.net:443"]);
    for (const bad of ["*.ts.net:443", "evil.example:443", "node.ts.net:65536", "node.ts.net:0"]) {
      assert.throws(() => trustedRelayHosts(bad), /exact Tailscale/);
    }
  } finally { await relay.close(); }
});
