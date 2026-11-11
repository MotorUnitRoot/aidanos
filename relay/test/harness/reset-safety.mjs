import { fixtureEnv } from "../../../test/child-diagnostics.mjs";
import { accessSync, constants } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";

export function resetTestMode(testMode, env) {
  // Neither an inherited reset variable nor the CLI flag alone enables deletion.
  return testMode === true && env.NODE_ENV === "test";
}

export function hasProxyHints(headers = {}) {
  return Object.keys(headers).some((name) =>
    /^(forwarded$|x-forwarded(?:-|$)|tailscale-)/i.test(name),
  );
}

export function readServeStatus(env = process.env) {
  // Locate first: ENOENT from an installed but broken executable must NOT be
  // mistaken for "Tailscale absent". Never log status or its command error.
  let executable;
  for (const directory of String(env.PATH || "").split(path.delimiter).filter(Boolean)) {
    const candidate = path.resolve(directory, "tailscale");
    try {
      accessSync(candidate, constants.X_OK);
      executable = candidate;
      break;
    } catch (error) {
      if (error.code !== "ENOENT" && error.code !== "ENOTDIR") {
        throw new Error("Cannot check Tailscale Serve/Funnel; test reset is refused.");
      }
    }
  }
  if (!executable) return null;
  try {
    return execFileSync(executable, ["serve", "status", "--json"], {
      env: fixtureEnv({ PATH: env.PATH }), encoding: "utf8", timeout: 5000, maxBuffer: 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    throw new Error("Cannot check Tailscale Serve/Funnel; test reset is refused.");
  }
}

function emptyConfig(value) {
  if (value === null) return true;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  // Accept only absent/empty maps. Unknown or nonempty configuration is unsafe,
  // including disabled-looking Funnel entries and new Serve schema fields.
  const maps = new Set(["TCP", "Web", "Services", "AllowFunnel"]);
  return Object.entries(value).every(([key, map]) => maps.has(key) &&
    (map === null || (typeof map === "object" && !Array.isArray(map) && Object.keys(map).length === 0)),
  );
}

export function assertNoServe(readStatus = readServeStatus) {
  let raw;
  try {
    raw = readStatus();
    // null means the executable is absent. JSON null means no stored config.
    if (raw === null || emptyConfig(JSON.parse(raw))) return;
  } catch {
    throw new Error("Cannot check Tailscale Serve/Funnel; test reset is refused.");
  }
  throw new Error("Reset and Tailscale Serve/Funnel must never be combined; test relay will not start.");
}
