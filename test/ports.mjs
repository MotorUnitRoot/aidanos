// Test-only fallback: production server.mjs rejects PORT=0, so do not change it.
// Keep random listeners out of Linux and macOS client ephemeral ranges.
// This is selection, not a reservation/retry: existing bind failures still fail.
import { readFileSync } from "node:fs";

export const TEST_PORT_MIN = 10000;
export const TEST_PORT_MAX = 29999;
const macRange = [49152, 65535];
const ranges = [macRange];
if (process.platform === "linux") {
  const range = readFileSync("/proc/sys/net/ipv4/ip_local_port_range", "utf8").trim().split(/\s+/).map(Number);
  if (range.length !== 2 || range.some((n) => !Number.isInteger(n) || n < 1 || n > 65535) || range[0] > range[1]) {
    throw new Error("Cannot determine the Linux ephemeral range for test ports");
  }
  ranges.push(range);
}
for (const [first, last] of ranges) {
  if (TEST_PORT_MIN <= last && TEST_PORT_MAX >= first) {
    throw new Error("Test port range overlaps an ephemeral range; choose a safe fixed range before running tests");
  }
}

export function randomTestPort(span = 1, random = Math.random) {
  const count = TEST_PORT_MAX - TEST_PORT_MIN + 1;
  if (!Number.isInteger(span) || span < 1 || span > count) throw new RangeError("Invalid test port span");
  const value = random();
  if (!(value >= 0 && value < 1)) throw new RangeError("Invalid random test port value");
  return TEST_PORT_MIN + Math.floor(value * (count - span + 1));
}
