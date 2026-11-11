import { PassThrough } from "node:stream";
import { once } from "node:events";
import { randomBytes } from "node:crypto";
import process from "node:process";
import { captureChildLog, childStartupError, fixtureEnv, spawnWithLog, redactChildLog } from "./child-diagnostics.mjs";

export async function runDiagnosticSecurityRegressions(assert) {
  const sync = "SYNTHETIC_SYNC_ONLY_0123456789abcdef", admin = "SYNTHETIC_ADMIN_ONLY_9876543210abcdef";
  const child = captureChildLog({ stdout: new PassThrough(), stderr: new PassThrough() }, { secrets: [sync, admin] });
  child.stdout.write(sync.slice(0, 13));
  assert(!child._log().includes(sync.slice(0, 13)), "partial known fixture token leaked");
  child.stderr.write("stderr cause " + admin + "\n");
  child.stderr.write("stopped: write EACCES\n");
  child.stdout.write(sync.slice(13) + "\nAuthorization: Bear");
  child.stdout.write("er SYNTHETIC_HEADER_ONLY\n");
  child.stderr.write("github_pat_SYNTHETIC_PATTERN_ONLY\n-----BEGIN PRIVATE KEY-----\nSYNTHETIC_ONLY");
  child.stderr.write("\n-----END PRIVATE KEY-----\n");
  const message = childStartupError(child, "failure " + sync).message;
  for (const raw of [sync, admin, "SYNTHETIC_HEADER_ONLY", "github_pat_SYNTHETIC_PATTERN_ONLY", "SYNTHETIC_ONLY"]) {
    assert(!child._log().includes(raw) && !message.includes(raw), "fixture credential leaked from diagnostic boundary");
  }
  assert(message.includes("stopped: write EACCES") && message.includes("structured diagnostics"), "allowlisted cause disappeared");
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
  const unregistered = randomBytes(32).toString("hex");
  const noContext = captureChildLog({ stdout: new PassThrough(), stderr: new PassThrough() });
  noContext.stdout.write(unregistered.slice(0, 17)); noContext.stderr.write("unregistered short sentinel");
  noContext.stdout.write(unregistered.slice(17));
  const omittedError = childStartupError(noContext, "failure " + unregistered);
  for (const text of [noContext._log(), omittedError.message, omittedError.stack, String(omittedError)]) {
    assert(!text.includes(unregistered) && !text.includes("unregistered short sentinel"), "default capture exposed unregistered body text");
  }
  for (const context of [{}, { secrets: [] }, { secrets: [null] }, { secrets: [""] }]) {
    const malformed = captureChildLog({ stdout: new PassThrough(), stderr: new PassThrough() }, context);
    malformed.stdout.write("unregistered short sentinel");
    assert(!malformed._log().includes("unregistered short sentinel"), "empty/malformed context must not authorize body text");
    malformed.stdout.end(); malformed.stderr.end();
  }
  const patterns = [unregistered, randomBytes(48).toString("base64"), "ghz_SYNTHETIC_UNREGISTERED_ONLY", "github_pat_SYNTHETIC_UNREGISTERED_ONLY", "sk-SYNTHETIC_UNREGISTERED_ONLY", "Bearer SYNTHETIC_BEARER_UNREGISTERED", "https://fixtureuser:fixturepass@example.invalid/"];
  const shaped = captureChildLog({ stdout: new PassThrough(), stderr: new PassThrough() }, { fixtureOnly: true });
  for (const value of patterns) {
    const split = Math.floor(value.length / 2);
    shaped.stdout.write(value.slice(0, split)); shaped.stderr.write("safe diagnostic cause\n"); shaped.stdout.write(value.slice(split) + "\n");
  }
  for (const value of patterns) assert(!shaped._log().includes(value), "unregistered token-shaped fixture escaped pattern redaction");
  assert(shaped._log() === "", "fixtureOnly must not retain even apparently safe arbitrary body text");
  for (const value of patterns) assert(!redactChildLog(value).includes(value), "standalone pattern masking regressed");
  const external = "fixture input outside environment";
  const nonEnv = spawnWithLog(process.execPath, ["-e", "process.stdout.write(process.argv[1])", external], {
    fixtureSecrets: [external], stdio: ["ignore", "pipe", "pipe"],
  });
  const [externalCode] = await once(nonEnv, "close");
  assert(externalCode === 0 && !nonEnv._log().includes(external), "explicit non-environment fixture secret escaped capture");
  for (const fake of [noContext, shaped]) { fake.stdout.end(); fake.stderr.end(); }

  // Real spawn, read between writes before newline/completion. No secret registry.
  const opaque = "q7V!";
  const pieces = [unregistered.slice(0, 11), unregistered.slice(11) + "\n", opaque, "\n"];
  const source = "const p=JSON.parse(process.argv[1]);let i=0;process.stdin.on('data',()=>process.stdout.write(p[i++]));process.stdin.on('end',()=>process.exit(0));";
  const streamed = spawnWithLog(process.execPath, ["-e", source, JSON.stringify(pieces)], { stdio: ["pipe", "pipe", "pipe"] });
  for (let index = 0; index < pieces.length; index += 1) {
    const arrived = once(streamed.stdout, "data"); streamed.stdin.write("next"); await arrived;
    assert(streamed._log() === "" && streamed._diagnostics().length === 0, "mid-chunk arbitrary data affected structured diagnostics");
    const error = childStartupError(streamed, opaque + unregistered);
    for (const text of [error.message, error.stack, String(error)]) {
      assert(!text.includes(opaque) && !text.includes(unregistered.slice(0, 11)) && !text.includes(unregistered), "mid-chunk prefix or short opaque value escaped");
    }
  }
  const finished = once(streamed, "close"); streamed.stdin.end();
  const [streamedCode] = await finished;
  assert(streamedCode === 0 && streamed._log() === "server exited 0\n", "only typed exit metadata may follow arbitrary child output");
  await runEnumDiagnosticRegressions(assert);
}

// Closed enum values survive registered-secret overlap; raw bodies never do.
export async function runEnumDiagnosticRegressions(assert) {
  const { default: os } = await import("node:os");
  for (const secret of ["EACC", "ACCE", "SYNTHETIC_OVERLAP_ONLY"]) {
    const child = captureChildLog({ stdout: new PassThrough(), stderr: new PassThrough() }, { secrets: [secret], fixtureOnly: true });
    child.stdout.write(secret.slice(0, 1));
    assert(child._log() === "", "unfinished fixture body must remain absent");
    child.stdout.write(secret.slice(1) + "\n");
    child.stderr.write(secret + "\nstopped: write EACC");
    assert(child._log() === "", "an unfinished enum must not be published");
    child.stderr.write("ES\n");
    assert(child._log() === "stopped: write EACCES\n", "errno must survive secret overlap exactly");
    const records = child._diagnostics();
    assert(records.length === 1 && records[0].code === "EACCES" && records[0].summary === "stopped: write EACCES", "typed errno was masked or changed");
    const error = childStartupError(child);
    const output = JSON.stringify([child._log(), records, error.message, error.stack]);
    assert(!output.split("EACCES").join("").includes(secret), "registered fixture escaped anywhere outside the approved errno");
    child.stdout.end(); child.stderr.end();
  }
  const child = captureChildLog({ stdout: new PassThrough(), stderr: new PassThrough() });
  for (const code of Object.keys(os.constants.errno)) {
    child.stdout.write("stopped: write " + code + "\n");
    assert(child._diagnostics().at(-1).code === code, "OS errno must match exactly without masking");
  }
  const count = child._diagnostics().length;
  for (const invalid of ["PARENT", "ERROR", "EACC", "EACCES_extra", "ERR_UNLISTED_DIAGNOSTIC", "EACCES opaque"]) {
    child.stdout.write("stopped: write " + invalid + "\n");
    assert(child._diagnostics().length === count, "non-enum error code must be dropped, not normalized or masked");
  }
  child.stdout.end(); child.stderr.end();
  const signal = captureChildLog({ stdout: new PassThrough(), stderr: new PassThrough() });
  for (const name of Object.keys(os.constants.signals)) {
    signal.signalCode = name;
    assert(signal._log() === "child signal " + name + "\n", "OS signal must survive exactly");
  }
  for (const invalid of ["SIGTERM_extra", "SIG_UNLISTED", "SIGTERM opaque", "", 9, undefined]) {
    signal.signalCode = invalid;
    assert(signal._log() === "", "non-enum signal must be dropped, not masked or coerced");
  }
  signal.stdout.end(); signal.stderr.end();
}
