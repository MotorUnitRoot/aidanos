import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { X509Certificate, createHash } from "node:crypto";
import { checkServerIdentity } from "node:tls";
import { WebSocket } from "ws";
import { loadRelayTLS, pairingRecord } from "../src/tls.mjs";
import { startRelay } from "../src/server.mjs";
import { localTLSFixture } from "./harness/tls-fixture.mjs";
import { noServeFixture } from "./harness/fixture-env.mjs";
const fixture = await localTLSFixture();
const config = { ...fixture, forbidden: [] };
const pin = (cert) => "sha256/" + createHash("sha256").update(new X509Certificate(cert).publicKey.export({ type: "spki", format: "der" })).digest("base64");

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
