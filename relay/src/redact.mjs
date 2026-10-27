// Scrub secrets before anything is printed. The git token and the relay
// token must never appear in a log line.
import { Console } from "node:console";
import { createWriteStream } from "node:fs";

export function redact(text, secrets) {
  let out = String(text ?? "");
  const list = [];
  for (const secret of secrets || []) {
    const value = String(secret || "").trim();
    if (value && !list.includes(value)) list.push(value);
  }
  for (const secret of list) {
    out = out.split(secret).join("***");
    const encoded = encodeURIComponent(secret);
    if (encoded !== secret) out = out.split(encoded).join("***");
  }
  out = out.replace(/x-access-token:[^@\s]+/gi, "x-access-token:***");
  out = out.replace(/Bearer\s+\S+/gi, "Bearer ***");
  out = out.replace(/Authorization:\s*Basic\s+\S+/gi, "Authorization: Basic ***");
  out = out.replace(/AIDANOS_(?:RELAY|VAULT_GIT)_TOKEN=\S+/g, "AIDANOS_TOKEN=***");
  out = out.replace(/https?:\/\/[^\s]+/gi, "[url]");
  out = out.replace(/file:\/\/[^\s]+/gi, "[url]");
  return out;
}

export function stampLine(line, now = new Date()) {
  return now.toISOString() + " " + String(line);
}

export function logSafe(secrets, ...parts) {
  const line = parts
    .map((part) => {
      if (part instanceof Error) return part.stack || part.message || "error";
      return String(part);
    })
    .join(" ");
  console.error(stampLine(redact(line, secrets)));
}

// Node writes a regular file with writeSync. On the Apple runner those
// writes were the multi-second event-loop gaps: the lag line went out
// through console.error, the write blocked, and the next tick logged a
// longer gap. An async stream on the same fd keeps the bytes in that
// file and returns before the kernel finishes.
export function installFileLog(fd = process.stderr.fd) {
  const previous = console.error;
  const stream = createWriteStream("", { fd, autoClose: false });
  stream.on("error", () => {});
  const sink = new Console({ stdout: stream, stderr: stream });
  console.error = (...args) => sink.error(...args);
  return {
    stream,
    restore() {
      console.error = previous;
    },
  };
}
