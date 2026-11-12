import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// Local synthetic CLI only, never a real daemon/configuration/credential.
export async function noServeFixture() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aidanos-no-serve-"));
  const status = path.join(dir, "status.json");
  await fs.writeFile(status, "{}\n");
  const executable = path.join(dir, "tailscale");
  await fs.writeFile(executable, `#!/bin/sh
[ "$#" = 3 ] && [ "$1" = serve ] && [ "$2" = status ] && [ "$3" = --json ] || exit 8
IFS= read -r value < '${status}'
[ "$value" != CLI_ERROR ] || exit 9
printf '%s\n' "$value"
`, { mode: 0o700 });
  return { dir, status, executable, env: { NODE_ENV: "test", PATH: dir } };
}
