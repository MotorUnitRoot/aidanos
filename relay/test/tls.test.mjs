import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { X509Certificate, createHash } from "node:crypto";
import { relayChildEnv } from "../src/child-env.mjs";
import { checkServerIdentity } from "node:tls";
import { WebSocket } from "ws";
import { loadRelayTLS, pairingRecord } from "../src/tls.mjs";
import { parseArgs, startRelay } from "../src/server.mjs";
import { localTLSFixture } from "./harness/tls-fixture.mjs";
import { noServeFixture } from "./harness/fixture-env.mjs";
import { parseDevArgs, startDevRelay } from "./harness/dev-plaintext.mjs";
const fixture = await localTLSFixture();
const config = { ...fixture, forbidden: [] };
const pin = (cert) => "sha256/" + createHash("sha256").update(new X509Certificate(cert).publicKey.export({ type: "spki", format: "der" })).digest("base64");

test("production refuses sync without TLS regardless of legacy dev options or environment", async () => {
  await assert.rejects(loadRelayTLS({}), /requires TLS/);
  assert.throws(() => parseArgs(["--dev-plaintext"]), /Unknown argument/);
  const f = await noServeFixture();
  await assert.rejects(startRelay({ token: "tls-sync-fixture-0123456789abcdef", port: 0, gitUrl: "",
    vault: path.join(f.dir, "vault"), data: path.join(f.dir, "data"), devPlaintext: true, allowPlaintext: true,
    env: { ...f.env, NODE_ENV: "development", AIDANOS_RELAY_DEV_PLAINTEXT: "1" } }), /requires TLS/);
  await assert.rejects(fs.stat(path.join(f.dir, "vault")), { code: "ENOENT" });
});
test("excluded disposable dev entry requires its explicit flag and never exposes network or reset", async () => {
  assert.throws(() => parseDevArgs([]), /explicit --dev-plaintext/);
  assert.equal(parseDevArgs(["--dev-plaintext", "--port", "0"]).port, 0);
  assert.throws(() => startDevRelay({}), /explicit --dev-plaintext/);
  assert.throws(() => startDevRelay({ lan: true }, { devPlaintext: true }), /loopback-only/);
  const f = await noServeFixture();
  const relay = await startDevRelay({ token: "dev-sync-fixture-0123456789abcdef", port: 0, gitUrl: "",
    vault: path.join(f.dir, "vault"), data: path.join(f.dir, "data"), env: f.env,
    testMode: true, allowReset: true, resetAdminToken: "dev-admin-fixture-0123456789abcdef" }, { devPlaintext: true });
  try {
    assert.match(relay.url, /^ws:\/\/127\.0\.0\.1:/);
    assert.equal((await fetch(relay.healthURL.replace("/health", "/reset"), { method: "POST" })).status, 404);
  } finally { await relay.close(); }
});
test("TLS private key is relay-owned 0600, outside notes/code, and never a symlink", async () => {
  await fs.chmod(fixture.keyFile, 0o644);
  await assert.rejects(loadRelayTLS(config), /0600/);
  await fs.chmod(fixture.keyFile, 0o600);
  assert((await loadRelayTLS(config)).context);
  const link = path.join(fixture.dir, "linked.key"); await fs.symlink(fixture.keyFile, link);
  await assert.rejects(loadRelayTLS({ ...config, keyFile: link }), /0600|refused/);
  await assert.rejects(loadRelayTLS({ ...config, forbidden: [fixture.dir] }), /outside/);
  await assert.rejects(loadRelayTLS({ ...config, name: "wrong.fixture.ts.net" }), /exact relay name/);
  await assert.rejects(loadRelayTLS({ ...config, keyFile: path.join(fixture.dir, "rotated.key") }), /exact relay name/);
});
test("TLS refuses a hardlinked alias in the forbidden vault and nonregular keys before reading", async () => {
  const vault = path.join(fixture.dir, "hardlink-vault"); await fs.mkdir(vault);
  const alias = path.join(vault, "alias.key"); await fs.link(fixture.keyFile, alias);
  try {
    assert.equal((await fs.lstat(fixture.keyFile)).nlink, 2);
    await assert.rejects(loadRelayTLS({ ...config, forbidden: [vault] }), /single-link/);
  } finally { await fs.unlink(alias); }
  assert.equal((await fs.lstat(fixture.keyFile)).nlink, 1);
  assert((await loadRelayTLS({ ...config, forbidden: [vault] })).context);
  const directory = path.join(fixture.dir, "directory-key"); await fs.mkdir(directory);
  await assert.rejects(loadRelayTLS({ ...config, keyFile: directory }), /regular single-link/);
});
test("local CA rotation changes the SPKI; pairing data binds exact name, port, IPv4 and pin", async () => {
  const first = await loadRelayTLS(config);
  const second = await loadRelayTLS({ ...config, certFile: path.join(fixture.dir, "rotated.crt"), keyFile: path.join(fixture.dir, "rotated.key") });
  assert.equal(first.spki, pin(await fs.readFile(fixture.certFile))); assert.notEqual(first.spki, second.spki);
  assert.deepEqual(pairingRecord({ name: fixture.name, port: 3750, ip: "100.100.1.20", spki: first.spki }),
    { version: 1, address: "wss://relay.fixture.ts.net:3750/", ipv4: "100.100.1.20", spki: first.spki });
  for (const ip of ["127.0.0.1", "192.168.1.2", "100.63.1.2"]) assert.throws(() => pairingRecord({ name: fixture.name, port: 3750, ip, spki: first.spki }));
});
test("direct Node TLS serves sync; default production trust refuses test CA and a trusted-CA wrong pin still fails", async () => {
  const f = await noServeFixture();
  const relay = await startRelay({ env: f.env, token: "tls-sync-fixture-0123456789abcdef", port: 0, gitUrl: "",
    vault: path.join(f.dir, "vault"), data: path.join(f.dir, "data"), tlsName: fixture.name, tlsCertFile: fixture.certFile, tlsKeyFile: fixture.keyFile });
  const connect = (extra) => new Promise((resolve) => {
    const ws = new WebSocket(relay.url, { agent: false, servername: fixture.name, headers: { host: fixture.name + ":" + relay.port,
      authorization: "Bearer tls-sync-fixture-0123456789abcdef" }, ...extra });
    ws.on("open", () => { ws.terminate(); resolve("open"); });
    ws.on("error", () => resolve("refused"));
    ws.on("unexpected-response", (_req, res) => { res.resume(); ws.terminate(); resolve(res.statusCode); });
  });
  try {
    assert.equal(await connect({}), "refused", "default production trust must not trust fixture CA");
    const approved = (await loadRelayTLS(config)).spki;
    const pinned = (wanted) => (_host, cert) => checkServerIdentity(fixture.name, cert) || (pin(cert.raw) === wanted ? undefined : new Error("pairing pin mismatch"));
    assert.equal(await connect({ ca: fixture.ca, checkServerIdentity: pinned(approved) }), "open");
    assert.equal(await connect({ ca: fixture.ca, checkServerIdentity: pinned("sha256/" + "A".repeat(43) + "=") }), "refused");
    await fs.writeFile(f.status, '{"AllowFunnel":{"fixture:443":true}}\n');
    assert.equal(await connect({ ca: fixture.ca, checkServerIdentity: pinned(approved) }), 503);
  } finally { await relay.close(); }
});

test("production children and native trust policy exclude TLS secrets and test anchors", async () => {
  const env = relayChildEnv({ PATH: "/usr/bin", HOME: "/fixture", TMPDIR: "/fixture/tmp", AIDANOS_RELAY_TOKEN: "SYNTHETIC_SYNC", AIDANOS_RELAY_TLS_KEY_FILE: "SYNTHETIC_PATH", NODE_EXTRA_CA_CERTS: "SYNTHETIC_CA" });
  assert.deepEqual(Object.keys(env).sort(), ["HOME", "PATH", "TAILSCALE_BE_CLI", "TMPDIR"]);
  const production = await fs.readFile(new URL("../../native/AidanCore/Sources/AidanCore/RelayTLS.swift", import.meta.url), "utf8");
  assert.doesNotMatch(production, /SecTrustSetAnchorCertificates|fixture\.ts\.net|SYNTHETIC_CA/);
  assert.match(production, /SecTrustEvaluateWithError/); assert.match(production, /fingerprint == pairing\.spki/);
});
