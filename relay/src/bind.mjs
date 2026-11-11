import os from "node:os";
import { relayChildEnv } from "./child-env.mjs";
import { isIPv4 } from "node:net";
import { execFileSync } from "node:child_process";

export function isTailscaleIPv4(ip) {
  if (!isIPv4(String(ip))) return false;
  const [a, b] = ip.split(".").map(Number);
  return a === 100 && b >= 64 && b <= 127;
}

// A CGNAT address alone is not proof of encryption. Require the running local
// Tailscale daemon to identify it as this node's address. Never log its status:
// it can contain details of other devices on the tailnet.
export function tailscaleAddresses(readStatus, env = process.env) {
  const read = readStatus || (() => execFileSync("tailscale", ["status", "--json"], {
  env: relayChildEnv(env),
  encoding: "utf8", timeout: 5000, maxBuffer: 1024 * 1024,
  stdio: ["ignore", "pipe", "pipe"],
}));
  try {
    const status = JSON.parse(read());
    if (status.BackendState === "Running" && Array.isArray(status.Self?.TailscaleIPs)) {
      return status.Self.TailscaleIPs.filter(isTailscaleIPv4);
    }
  } catch {
    // Missing CLI, stopped daemon, malformed status: fail closed below.
  }
  return [];
}

// Default is loopback only. --lan now means Tailscale only, never home Wi-Fi.
// Both automatic and explicit selection require a local address AND daemon proof.
export function listenHosts({ lan = false, interfaces = os.networkInterfaces(), choose,
  tailscaleIPs, env = process.env } = {}) {
  const hosts = ["127.0.0.1"];
  if (!lan && !choose) return { hosts, phone: null };
  const verified = tailscaleIPs ?? tailscaleAddresses(undefined, env);
  const local = Object.values(interfaces || {}).flat().filter((addr) =>
    (addr.family === "IPv4" || addr.family === 4) && !addr.internal &&
    isTailscaleIPv4(addr.address) && verified.includes(addr.address),
  ).map((addr) => addr.address);
  const phone = choose || local[0];
  if (!phone || !local.includes(phone)) {
    const error = new Error(
      "--lan requires a running Tailscale connection and its local 100.64.0.0/10 address. " +
      "Home-network, public, wildcard, and nonlocal addresses are refused.",
    );
    error.code = "NO_LAN";
    throw error;
  }
  hosts.push(phone);
  return { hosts, phone };
}
