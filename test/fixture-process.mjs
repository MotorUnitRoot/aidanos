// Test-only env -i boundary for synchronous utilities and every fixture Git call.
import { execFileSync as rawExecFileSync } from "node:child_process";
import path from "node:path";
import { fixtureEnv } from "./child-diagnostics.mjs";

export function fixtureGitEnv(extra = {}) {
  const fixture = fixtureEnv(extra), env = {};
  for (const name of ["PATH", "HOME", "TMPDIR", "TZ", "LANG", "LC_ALL"]) if (fixture[name] != null) env[name] = fixture[name];
  env.GIT_CONFIG_GLOBAL = "/dev/null";
  env.GIT_CONFIG_NOSYSTEM = "1";
  env.GIT_TERMINAL_PROMPT = "0";
  if (extra.GIT_LITERAL_PATHSPECS === "1") env.GIT_LITERAL_PATHSPECS = "1";
  // No askpass, injected Git config, proxy, SSH agent, or credential variables.
  return env;
}
export function fixtureGitArgs(args) { return ["-c", "credential.helper=", ...args]; }
export function execFileSync(file, args, options = {}) {
  const git = path.basename(String(file)) === "git";
  return rawExecFileSync(file, git ? fixtureGitArgs(args) : args,
    { ...options, env: git ? fixtureGitEnv(options.env) : fixtureEnv(options.env) });
}
