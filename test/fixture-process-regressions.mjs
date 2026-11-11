import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const output = (value) => String(value?.stdout ?? value ?? "");
// Exercise the ACTUAL caller helper, not an extracted approximation or outer runner.
export async function assertFixtureGitIsolation(assert, runGit) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aidanos-fixture-git-isolation-"));
  const ambientHome = path.join(dir, "ambient"), bin = path.join(dir, "bin");
  fs.mkdirSync(ambientHome); fs.mkdirSync(bin);
  const config = path.join(ambientHome, ".gitconfig");
  fs.writeFileSync(config, "[credential]\n\thelper = !fixture-global-helper-must-never-run\n");
  const planted = { HOME: ambientHome, XDG_CONFIG_HOME: ambientHome, GIT_CONFIG_GLOBAL: config,
    GIT_CONFIG_NOSYSTEM: "0", GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "credential.helper",
    GIT_CONFIG_VALUE_0: "!fixture-env-helper-must-never-run", GIT_ASKPASS: "/fixture-askpass",
    SSH_ASKPASS: "/fixture-ssh-askpass", GITHUB_TOKEN: "SYNTHETIC_AMBIENT_GITHUB_ONLY",
    AIDANOS_RELAY_TOKEN: "SYNTHETIC_AMBIENT_SYNC_ONLY", AIDANOS_RELAY_RESET_ADMIN_TOKEN: "SYNTHETIC_AMBIENT_ADMIN_ONLY",
    HTTPS_PROXY: "http://fixture.invalid", FIXTURE_UNKNOWN_SECRET: "SYNTHETIC_UNKNOWN_ONLY" };
  const saved = Object.fromEntries([...Object.keys(planted), "PATH"].map((key) => [key, process.env[key]]));
  try {
    Object.assign(process.env, planted);
    let visible = "";
    try { visible = output(await runGit(["config", "--global", "--get-all", "credential.helper"], dir)); }
    catch (error) { assert(error.status === 1 || error.code === 1, "fixture global-config query failed unexpectedly"); visible = output(error.stdout); }
    assert(!visible.trim(), "fixture Git can see the planted ambient global credential helper");
    const spy = ["#!" + process.execPath,
      "const e=process.env,a=process.argv.slice(2);",
      "process.stdout.write(JSON.stringify({",
      "forced:e.GIT_CONFIG_GLOBAL==='/dev/null'&&e.GIT_CONFIG_NOSYSTEM==='1'&&e.GIT_TERMINAL_PROMPT==='0',",
      "prefix:a[0]==='-c'&&a[1]==='credential.helper=',",
      "noSecrets:!['GITHUB_TOKEN','AIDANOS_RELAY_TOKEN','AIDANOS_RELAY_RESET_ADMIN_TOKEN','HTTPS_PROXY','FIXTURE_UNKNOWN_SECRET','GIT_ASKPASS','SSH_ASKPASS','GIT_CONFIG_COUNT','GIT_CONFIG_KEY_0','GIT_CONFIG_VALUE_0'].some(k=>Object.hasOwn(e,k)),",
      "home:!!e.HOME&&e.HOME!==" + JSON.stringify(ambientHome) + "&&e.HOME.startsWith(" + JSON.stringify(os.tmpdir() + path.sep) + ")",
      "}));", ""].join("\n");
    fs.writeFileSync(path.join(bin, "git"), spy, { mode: 0o700 });
    process.env.PATH = bin + path.delimiter + (saved.PATH || "/usr/bin:/bin");
    const seen = JSON.parse(output(await runGit(["status", "--porcelain"], dir)));
    assert(seen.forced && seen.prefix && seen.noSecrets && seen.home,
      "actual fixture Git helper did not enforce clean env, config, no askpass, helper reset and scratch HOME");
  } finally {
    for (const [key, value] of Object.entries(saved)) { if (value == null) delete process.env[key]; else process.env[key] = value; }
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
