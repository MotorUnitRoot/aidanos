// Not copied into the production Docker image. The normal server CLI has no
// test-mode switch and cannot enable HTTP reset, even with inherited test env.
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "../../src/server.mjs";
import { startRelay, startupLines } from "./reset-relay.mjs";

export function parseHarnessArgs(argv) {
  if (!argv.includes("--test-mode")) throw new Error("The disposable test relay requires --test-mode.");
  return parseArgs(argv.filter((arg) => arg !== "--test-mode"));
}

async function main() {
  if (process.env.NODE_ENV !== "test") throw new Error("The test harness requires NODE_ENV=test.");
  const args = parseHarnessArgs(process.argv.slice(2));
  const relay = await startRelay({
    testMode: true, lan: args.lan, lanAddress: args.lanAddress,
    vault: args.vault || undefined, data: args.data || undefined,
    port: args.port == null ? undefined : args.port,
  });
  for (const line of startupLines({ lan: args.lan, port: relay.port, phone: relay.phone })) console.log(line);
  const stop = () => relay.close().then(() => process.exit(0));
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(() => { console.error("Test relay startup refused; check harness flags, admin authority and Serve/Funnel."); process.exit(1); });
}
