import { createHash } from "node:crypto";
import bs58check from "bs58check";

// Same recipe as native/AidanCore. A hash is a fingerprint of the exact
// bytes. base58check turns 16 of those bytes into a short id with a checksum.
function idFor(bytes) {
  const digest = createHash("sha256").update(bytes).digest();
  return bs58check.encode(digest.subarray(0, 16));
}

export const INDEX_ID = idFor("aidanos.index.v1");

export function noteId(notePath) {
  return idFor(Buffer.concat([Buffer.from("aidanos.note.v1"), Buffer.from([0]), Buffer.from(notePath)]));
}
