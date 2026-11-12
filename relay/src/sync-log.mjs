import * as Automerge from "@automerge/automerge";
import { decode } from "@automerge/automerge-repo/helpers/cbor.js";
import { logSafe } from "./redact.mjs";

function asBytes(value) {
  if (value == null) return null;
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  if (ArrayBuffer.isView(value)) {
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  }
  if (typeof value === "string") return Buffer.from(value);
  return null;
}

function headList(heads) {
  if (!heads || typeof heads[Symbol.iterator] !== "function") return "";
  const parts = [];
  for (const head of heads) {
    if (typeof head === "string") parts.push(head);
    else if (head instanceof Uint8Array) parts.push(Buffer.from(head).toString("hex"));
    else parts.push(String(head));
  }
  parts.sort();
  return parts.join(",");
}

function messageHeads(data) {
  const bytes = asBytes(data);
  if (!bytes || bytes.length === 0) return "";
  try {
    const decoded = Automerge.decodeSyncMessage(bytes);
    return headList(decoded && decoded.heads);
  } catch {
    return "";
  }
}

/// One line for a sync frame, or "" when the bytes are not a sync message.
export function describeSyncFrame(direction, bytes) {
  const raw = asBytes(bytes);
  if (!raw || raw.length === 0) return "";
  let message;
  try {
    message = decode(raw);
  } catch {
    return "";
  }
  if (!message || typeof message !== "object") return "";
  const type = typeof message.type === "string" ? message.type : "";
  const dir = direction === "out" ? "out" : "in";
  if (type === "join") return "sync " + dir + " join";
  if (type === "peer") return "sync " + dir + " peer";
  if (type === "doc-unavailable") {
    return "sync " + dir + " doc-unavailable doc=" + String(message.documentId || "");
  }
  if (type === "sync" || type === "request") {
    return "sync " + dir + " " + type + " doc=" + String(message.documentId || "") + " heads=" + messageHeads(message.data);
  }
  return "";
}

/// Print a sync frame. A bad frame is skipped. This never changes the socket.
export function logSyncFrame(direction, bytes, secrets) {
  try {
    const line = describeSyncFrame(direction, bytes);
    if (line) logSafe(secrets, line);
  } catch {
    // Logging stays out of the sync path.
  }
}
