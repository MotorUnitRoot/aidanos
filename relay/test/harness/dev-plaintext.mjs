// Disposable development entry ONLY. Excluded from npm pack and Docker input.
// The production entry never imports this file and has no plaintext switch.
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { parseArgs } from "../../src/server.mjs";
import { startRelay as startFixtureRelay } from "./reset-relay.mjs";
export function parseDevArgs(argv) {
  if (argv[0] !== "--dev-plaintext") throw new Error("Plaintext requires explicit --dev-plaintext");
  return parseArgs(argv.slice(1));
}
export function startDevRelay(options = {}, { devPlaintext = false } = {}) {
  if (devPlaintext !== true) throw new Error("Plaintext requires explicit --dev-plaintext");
  if (options.lan || options.lanAddress) throw new Error("Disposable plaintext is loopback-only");
  return startFixtureRelay({ ...options, lan: false, lanAddress: "", testMode: false, allowReset: false });
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const relay = await startDevRelay(parseDevArgs(process.argv.slice(2)), { devPlaintext: true });
    console.error("DISPOSABLE PLAINTEXT FIXTURE ONLY; never real notes or credentials.");
    console.log("LISTENING 127.0.0.1 " + relay.port);
    for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => relay.close().then(() => process.exit(0)));
  } catch { console.error("Disposable plaintext fixture refused; check its explicit flag and fixture configuration."); process.exitCode = 1; }
}
