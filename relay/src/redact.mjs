import os from "node:os";

// Scrub secrets before anything is printed. The git token and the relay
// token must never appear in a log line.

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

const logMessages = new Set([
  "error", "rejected a sync connection", "closed a sync connection", "accepted a sync connection",
  "sync connection closed:", "git backup failed:", "git backup push failed:", "fold-in failed for", "mirror failed:",
  "relay startup failed:", "Node 22 or newer is needed.", "reset refused: the folder has no current relay marker",
  "reset complete", "reset attempt failed:", "reset failed:", "resetting",
  "Production sync requires TLS; configure the exact name, certificate and private-key files.",
  "TLS requires one exact lowercase MagicDNS name, certificate file and private-key file.",
  "TLS private key must be a relay-owned regular single-link 0600 file, not a symlink or hardlink.",
  "TLS private key changed while reading; require the same relay-owned regular single-link 0600 file.",
  "TLS files must be outside the repository, vault and relay data.",
  "Certificate chain must not contain a private key.",
  "TLS certificate/key must match the exact relay name and current validity.",
  "TLS material refused; check private-key ownership/mode and the exact certificate/name.",
]);
const logCodes = new Set([...Object.keys(os.constants.errno), "ERR_STREAM_PREMATURE_CLOSE"]);
function ownLogField(value, field) {
  if (!value || (typeof value !== "object" && typeof value !== "function")) return undefined;
  try { return Object.getOwnPropertyDescriptor(value, field)?.value; } catch { return undefined; }
}
function publicLogMessage(value) {
  if (typeof value !== "string") return false;
  if (logMessages.has(value)) return true;
  // Existing explicitly public, single-line schemas; never stringify objects or
  // accept arbitrary Error text as a diagnostic body.
  return /^LISTENING 127\.0\.0\.1 (?:[1-9]\d{0,4})$/.test(value) ||
    /^sync (?:in|out) (?:join|peer)$/.test(value) ||
    /^sync (?:in|out) doc-unavailable doc=[A-Za-z0-9_-]{1,128}$/.test(value) ||
    /^sync (?:in|out) (?:sync|request) doc=[A-Za-z0-9_-]{1,128} heads=(?:[a-f0-9]{64}(?:,[a-f0-9]{64})*)?$/.test(value);
}
function safeLogPart(part) {
  if (typeof part === "string") return publicLogMessage(part) ? part : "error";
  const message = ownLogField(part, "message"), code = ownLogField(part, "code");
  // An Error message must be one of the fixed strings, not a public status-field
  // pattern. Never read stack/cause/errors, even for AggregateError.
  return (logMessages.has(message) ? message : "error") + " code=" + (logCodes.has(code) ? code : "EIO");
}
export function logSafe(secrets, ...parts) {
  const line = parts.length ? parts.map(safeLogPart).join(" ") : "error";
  console.error(stampLine(redact(line, secrets)));
}
