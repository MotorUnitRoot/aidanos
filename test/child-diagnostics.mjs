// Test-only helpers for sync-path-flake-ticket. Never inspect command lines.
import { spawn } from "node:child_process";

export function captureChildLog(child) {
  let log = "";
  child.stdout.on("data", (chunk) => { log += String(chunk); });
  child.stderr.on("data", (chunk) => { log += String(chunk); });
  child._log = () => log;
  return child;
}

export function spawnWithLog(...args) {
  return captureChildLog(spawn(...args));
}

export function childStartupError(child, message) {
  const log = child._log();
  return new Error(message + "\nchild stdout/stderr:\n" + (log || "(no child output captured)"));
}
