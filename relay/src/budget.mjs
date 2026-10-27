import { CLOSE_BYTES, GLOBAL_BYTES, PAUSE_BYTES, PAUSE_LIMIT_MS } from "./channel.mjs";

// Per connection: pause at 8 MB, close at 16 MB or after 60s paused.
// Across connections: pause the biggest senders once 64 MB is in flight.
// Idle connections (nothing in flight) are left alone.
export function planBudget(entries, now) {
  const close = [];
  const pause = new Set();
  for (const entry of entries) {
    const bytes = Number(entry.bytes) || 0;
    const pausedTooLong = Boolean(entry.paused) && entry.pausedAt && now - entry.pausedAt >= PAUSE_LIMIT_MS;
    if (bytes >= CLOSE_BYTES || pausedTooLong) close.push(entry.id);
  }
  const closing = new Set(close);
  const alive = [];
  let aliveTotal = 0;
  for (const entry of entries) {
    if (closing.has(entry.id)) continue;
    alive.push(entry);
    aliveTotal += Number(entry.bytes) || 0;
  }
  for (const entry of alive) {
    if ((Number(entry.bytes) || 0) >= PAUSE_BYTES) pause.add(entry.id);
  }
  if (aliveTotal > GLOBAL_BYTES) {
    const ranked = alive
      .filter((entry) => (Number(entry.bytes) || 0) > 0)
      .sort((left, right) => (Number(right.bytes) || 0) - (Number(left.bytes) || 0));
    let held = 0;
    for (const entry of ranked) {
      pause.add(entry.id);
      held += Number(entry.bytes) || 0;
      if (aliveTotal - held <= GLOBAL_BYTES) break;
    }
  }
  const resume = [];
  for (const entry of alive) {
    if (!pause.has(entry.id)) resume.push(entry.id);
  }
  return { close, pause: [...pause], resume };
}
