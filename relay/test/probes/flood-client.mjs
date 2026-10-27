// Sends a burst from a separate process so the relay's RSS is the server's.
import WebSocket from "ws";
import { encode } from "@automerge/automerge-repo/helpers/cbor.js";

const url = process.env.FLOOD_URL;
const token = process.env.FLOOD_TOKEN;
const storageId = process.env.FLOOD_STORAGE;
const documentId = process.env.FLOOD_DOC;
const payloadBytes = Number(process.env.FLOOD_PAYLOAD || 2 * 1024 * 1024);
const prime = Number(process.env.FLOOD_PRIME || 4);
const extra = Number(process.env.FLOOD_EXTRA || 16);

const ws = new WebSocket(url, { headers: { Authorization: "Bearer " + token } });
ws.on("error", () => {
  process.exit(1);
});
await new Promise((resolve, reject) => {
  ws.once("open", resolve);
  ws.once("error", reject);
});
ws.send(encode({
  type: "join",
  senderId: "flood-child",
  supportedProtocolVersions: ["1"],
  peerMetadata: { storageId, isEphemeral: false },
}));
await new Promise((resolve) => ws.once("message", resolve));
const frame = encode({
  type: "request",
  senderId: "flood-child",
  targetId: "aidanos-relay",
  documentId,
  data: Buffer.alloc(payloadBytes, 7),
});
for (let n = 0; n < prime; n += 1) ws.send(frame);
process.stdout.write("primed\n");
await new Promise((resolve) => process.stdin.once("data", resolve));
for (let n = 0; n < extra; n += 1) ws.send(frame);
process.stdout.write("flooded\n");
await new Promise(() => {});
