import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { WebSocket } from "ws";
import { startRelay } from "../src/server.mjs";
import { assertNoServe } from "../src/exposure-safety.mjs";
import { noServeFixture } from "./harness/fixture-env.mjs";
const token = "production-sync-fixture-0123456789abcdef";
const options = (f) => ({ env: f.env, token, vault: path.join(f.dir, "vault"), data: path.join(f.dir, "data"), port: 0, gitUrl: "" });
const upgrade = (url, headers = {}) => new Promise((resolve, reject) => {
  const ws = new WebSocket(url, { headers: { authorization: "Bearer " + token, ...headers } });
  ws.on("unexpected-response", (_req, res) => { resolve(res.statusCode); res.resume(); ws.terminate(); });
  ws.on("open", () => { resolve(101); ws.terminate(); }); ws.on("error", reject);
});
test("production fails closed when Tailscale is absent, unreadable or configured, before writing folders", async () => {
  assert.throws(() => assertNoServe(() => null), /Serve\/Funnel/);
  for (const status of [null, "CLI_ERROR", "broken JSON", '{"AllowFunnel":{"node:443":false}}', '{"Services":{"unknown":{}}}']) {
    const f = await noServeFixture();
    if (status === null) await fs.unlink(f.executable); else await fs.writeFile(f.status, status + "\n");
    await assert.rejects(startRelay(options(f)), /Serve\/Funnel/);
    await assert.rejects(fs.stat(path.join(f.dir, "vault")), { code: "ENOENT" });
  }
});
test("every production HTTP and sync route refuses forwarding hints, including empty hints", async () => {
  const f = await noServeFixture(), relay = await startRelay(options(f));
  try {
    for (const name of ["Forwarded", "X-Forwarded-For", "X-Forwarded-Anything", "Tailscale-User-Login"]) {
      for (const route of ["/health", "/reset", "/unknown"]) {
        assert.equal((await fetch(relay.healthURL.replace("/health", route), { headers: { [name]: "" } })).status, 403);
      }
      assert.equal(await upgrade(relay.url, { [name]: "" }), 403);
    }
    assert.equal((await fetch(relay.healthURL)).status, 200);
    assert.equal(await upgrade(relay.url), 101);
  } finally { await relay.close(); }
});
test("production rechecks Serve configuration and missing CLI before health and sync without losing notes", async () => {
  const f = await noServeFixture(), relay = await startRelay(options(f));
  try {
    const sentinel = path.join(relay.vault, "keep.md"); await fs.writeFile(sentinel, "keep\n");
    for (const status of ['{"TCP":{"443":{"TCPForward":"127.0.0.1:3750"}}}', "CLI_ERROR", null]) {
      if (status === null) await fs.unlink(f.executable); else await fs.writeFile(f.status, status + "\n");
      assert.equal((await fetch(relay.healthURL)).status, 503);
      assert.equal(await upgrade(relay.url), 503);
      assert.equal(await fs.readFile(sentinel, "utf8"), "keep\n");
    }
  } finally { await relay.close(); }
});
