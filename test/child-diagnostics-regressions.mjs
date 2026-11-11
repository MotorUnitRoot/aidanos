import { PassThrough } from "node:stream";
import { once } from "node:events";
import process from "node:process";
import { captureChildLog, childStartupError, fixtureEnv, spawnWithLog } from "./child-diagnostics.mjs";

export async function runDiagnosticSecurityRegressions(assert) {
  const sync = "SYNTHETIC_SYNC_ONLY_0123456789abcdef", admin = "SYNTHETIC_ADMIN_ONLY_9876543210abcdef";
  const child = captureChildLog({ stdout: new PassThrough(), stderr: new PassThrough() }, { secrets: [sync, admin] });
  child.stdout.write(sync.slice(0, 13));
  assert(!child._log().includes(sync.slice(0, 13)), "partial known fixture token leaked");
  child.stderr.write("stderr cause " + admin + "\n");
  child.stdout.write(sync.slice(13) + "\nAuthorization: Bear");
  child.stdout.write("er SYNTHETIC_HEADER_ONLY\n");
  child.stderr.write("github_pat_SYNTHETIC_PATTERN_ONLY\n-----BEGIN PRIVATE KEY-----\nSYNTHETIC_ONLY");
  child.stderr.write("\n-----END PRIVATE KEY-----\n");
  const message = childStartupError(child, "failure " + sync).message;
  for (const raw of [sync, admin, "SYNTHETIC_HEADER_ONLY", "github_pat_SYNTHETIC_PATTERN_ONLY", "SYNTHETIC_ONLY"]) {
    assert(!child._log().includes(raw) && !message.includes(raw), "fixture credential leaked from diagnostic boundary");
  }
  assert(message.includes("stderr cause") && message.includes("secrets redacted"), "safe cause disappeared");
  const env = fixtureEnv({ PORT: "12345", AIDANOS_RELAY_TLS_KEY: "SYNTHETIC_PRIVATE_PATH", UNKNOWN_SECRET: sync },
    { PATH: process.env.PATH, GITHUB_TOKEN: sync, NODE_OPTIONS: "SYNTHETIC_INJECT", HTTPS_PROXY: admin });
  assert(env.GITHUB_TOKEN === "" && !env.NODE_OPTIONS && !env.HTTPS_PROXY && !env.UNKNOWN_SECRET && !env.AIDANOS_RELAY_TLS_KEY,
    "ambient credential/configuration or TLS key path reached child environment");
  assert(env.PORT === "12345" && env.AIDANOS_HOST === "127.0.0.1", "explicit nonsecret fixture config was lost");
  const launched = spawnWithLog(process.execPath, ["-e", "process.stdout.write(process.env.AIDANOS_VAULT_GIT_TOKEN)"], {
    env: { AIDANOS_VAULT_GIT_TOKEN: sync }, stdio: ["ignore", "pipe", "pipe"],
  });
  const [code] = await once(launched, "close");
  assert(code === 0 && !launched._log().includes(sync), "actual fixture child diagnostic leaked its synthetic token");
  child.stdout.end(); child.stderr.end();
}
