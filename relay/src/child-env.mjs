// Never forward relay credentials, TLS key paths/material, or proxy/cert overrides.
export function relayChildEnv(source = process.env) {
  const env = { TAILSCALE_BE_CLI: "1" };
  for (const name of ["PATH", "HOME", "TMPDIR", "XDG_RUNTIME_DIR"]) if (source[name] != null) env[name] = source[name];
  return env;
}
