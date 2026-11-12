import test from "node:test";
import { tlsOptions, fetch } from "./harness/production-tls.mjs";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { noServeFixture } from "./harness/fixture-env.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
test("built npm and Docker production file sets require TLS and contain no reset implementation or test/dev entry", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aidanos-production-artifact-"));
  const staging = path.join(dir, "staging");
  await fs.mkdir(staging);
  for (const name of ["src", "scripts", "Acknowledgements.txt", "Dockerfile", ".dockerignore", "README.md"]) {
    await fs.cp(path.join(root, name), path.join(staging, name), { recursive: true });
  }
  const manifest = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"));
  // Private, unpublished source has no version; a staging-only version enables
  // npm's real pack operation without changing its production files allowlist.
  manifest.version = "0.0.0-artifact-test";
  await fs.writeFile(path.join(staging, "package.json"), JSON.stringify(manifest));
  const user = path.join(dir, "user.npmrc"), global = path.join(dir, "global.npmrc");
  await fs.writeFile(user, ""); await fs.writeFile(global, "");
  const packed = JSON.parse(execFileSync("npm", ["pack", staging, "--ignore-scripts", "--json", "--pack-destination", dir], {
    cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    env: { PATH: process.env.PATH, HOME: dir, TMPDIR: os.tmpdir(), NPM_CONFIG_USERCONFIG: user,
      NPM_CONFIG_GLOBALCONFIG: global, NPM_CONFIG_CACHE: path.join(dir, "cache"), NPM_CONFIG_OFFLINE: "true" },
  }))[0];
  const files = packed.files.map((entry) => entry.path);
  assert(files.includes("src/server.mjs"));
  assert(!files.some((name) => /(^|\/)test\/|reset|dev-plaintext|\.(?:key|pem|crt)$/.test(name)));
  const docker = await fs.readFile(path.join(root, "Dockerfile"), "utf8");
  assert.match(docker, /COPY --chown=node:node src \.\/src/);
  assert(!docker.split("\n").some((line) => /^COPY\b/.test(line) && /\btest\b|COPY \. /.test(line)));
  assert.match(await fs.readFile(path.join(root, ".dockerignore"), "utf8"), /^test$/m);
  for (const name of files.filter((name) => name.startsWith("src/") && name.endsWith(".mjs"))) {
    const text = await fs.readFile(path.join(staging, name), "utf8");
    assert.doesNotMatch(text, /resetAdminToken|RESET_ADMIN_TOKEN|allowReset|resetAllowed|function rotate\(|function emptyDirectory\(|["']\/reset["']|devPlaintext|--dev-plaintext|http\.createServer/);
  }
  execFileSync("tar", ["-xf", path.join(dir, packed.filename), "-C", dir], { stdio: ["ignore", "pipe", "pipe"], env: { PATH: process.env.PATH, HOME: dir, TMPDIR: os.tmpdir() } });
  await fs.symlink(path.join(root, "node_modules"), path.join(dir, "package", "node_modules"), "dir");
  const production = await import(pathToFileURL(path.join(dir, "package", "src", "server.mjs")));
  assert.equal(production.resetAllowed, undefined);
  const fake = await noServeFixture();
  assert.throws(() => production.parseArgs(["--dev-plaintext"]), /Unknown argument/);
  assert.equal(production.startDevRelay, undefined);
  await assert.rejects(production.startRelay({ token: "artifact-sync-fixture-0123456789abcdef",
    vault: path.join(dir, "plaintext-vault"), data: path.join(dir, "plaintext-data"), port: 0, gitUrl: "",
    devPlaintext: true, allowPlaintext: true, testMode: true,
    env: { ...fake.env, NODE_ENV: "development", AIDANOS_RELAY_DEV_PLAINTEXT: "1", AIDANOS_RELAY_ALLOW_PLAINTEXT: "1" } }), /requires TLS/);
  await assert.rejects(fs.stat(path.join(dir, "plaintext-vault")), { code: "ENOENT" });
  const relay = await production.startRelay({ ...tlsOptions, token: "artifact-sync-fixture-0123456789abcdef", vault: path.join(dir, "vault"),
    data: path.join(dir, "data"), port: 0, gitUrl: "", testMode: true, allowReset: true,
    resetAdminToken: "artifact-admin-fixture-0123456789abcdef", env: { ...fake.env, AIDANOS_RELAY_ALLOW_RESET: "1" } });
  try {
    const sentinel = path.join(relay.vault, "keep.md"); await fs.writeFile(sentinel, "keep\n");
    const response = await fetch(relay.healthURL.replace("/health", "/reset"), { method: "POST",
      headers: { authorization: "Bearer artifact-admin-fixture-0123456789abcdef" } });
    assert.equal(response.status, 404); assert.equal(await fs.readFile(sentinel, "utf8"), "keep\n");
  } finally { await relay.close(); }
});
