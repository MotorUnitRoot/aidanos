// Scrub secrets before anything is printed. The git token and the relay
// token must never appear in a log line.
import { createWriteStream, writeSync } from "node:fs";
import { formatWithOptions } from "node:util";

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

function formatParts(secrets, parts) {
  const line = parts
    .map((part) => {
      if (part instanceof Error) return part.stack || part.message || "error";
      return String(part);
    })
    .join(" ");
  return redact(line, secrets);
}

export function logSafe(secrets, ...parts) {
  console.error(stampLine(formatParts(secrets, parts)));
}

// A startup refusal calls process.exit on the next line. The async file
// log drops that line: the bytes are still in the stream when the process
// ends. writeSync lands them before the exit.
let fileLogFd = null;

export function logFatal(secrets, ...parts) {
  const line = stampLine(formatParts(secrets, parts)) + "\n";
  writeSync(fileLogFd == null ? process.stderr.fd : fileLogFd, line);
}

// Node writes a regular file with writeSync. On the Apple runner those
// writes were the multi-second event-loop gaps: the lag line went out
// through console.error, the write blocked, and the next tick logged a
// longer gap. An async stream on the same fd keeps the bytes in that
// file and returns before the kernel finishes.
// A stalled pipe used to keep every line. One run queued 303 MB in 3s.
// Past this cap, further lines are dropped and one notice is written.
export const FILE_LOG_CAP = 1024 * 1024;
const DROP_NOTICE_RESERVE = 96;

export function installFileLog(fd = process.stderr.fd, options = {}) {
  const cap = Number(options.cap) > 0 ? Number(options.cap) : FILE_LOG_CAP;
  const previous = console.error;
  const previousFd = fileLogFd;
  fileLogFd = fd;
  const highWaterMark = Math.min(16 * 1024, Math.max(1024, Math.floor(cap / 2)));
  const stream = createWriteStream("", { fd, autoClose: false, highWaterMark });
  stream.on("error", () => {});
  let dropped = 0;
  let announced = false;

  function announce() {
    if (announced || dropped === 0) return;
    const text = stampLine(dropped + " lines dropped") + "\n";
    if (stream.writableLength + Buffer.byteLength(text) > cap) return;
    announced = true;
    stream.write(text);
  }

  stream.on("drain", announce);
  const end = stream.end;
  stream.end = function endAndNote(...args) {
    announce();
    return end.apply(stream, args);
  };

  console.error = (...args) => {
    const text = formatWithOptions({ colors: false }, ...args) + "\n";
    const size = Buffer.byteLength(text);
    const reserve = announced ? 0 : DROP_NOTICE_RESERVE;
    if (stream.writableLength + size + reserve > cap) {
      dropped += 1;
      return;
    }
    stream.write(text);
  };

  return {
    stream,
    get dropped() {
      return dropped;
    },
    restore() {
      console.error = previous;
      fileLogFd = previousFd;
    },
  };
}
