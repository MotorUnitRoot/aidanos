import { accessSync, constants } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { relayChildEnv } from "./child-env.mjs";

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
        throw new Error("Cannot check Tailscale Serve/Funnel; relay access is refused.");
      }
    }
  }
  if (!executable) return null;
  try {
    return execFileSync(executable, ["serve", "status", "--json"], {
      env: relayChildEnv(env), encoding: "utf8", timeout: 5000, maxBuffer: 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    throw new Error("Cannot check Tailscale Serve/Funnel; relay access is refused.");
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
    // Missing CLI is not proof of safe exposure. JSON null is an empty stored config.
    if (raw !== null && emptyConfig(JSON.parse(raw))) return;
  } catch {
    throw new Error("Cannot check Tailscale Serve/Funnel; relay access is refused.");
  }
  throw new Error("Relay access requires readable empty Tailscale Serve/Funnel configuration.");
}
