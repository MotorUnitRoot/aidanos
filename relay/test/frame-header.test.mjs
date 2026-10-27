import test from "node:test";
import assert from "node:assert/strict";
import { encode, decode } from "@automerge/automerge-repo/helpers/cbor.js";
import { peekFrameHeader } from "../src/frame-header.mjs";
import { noteId } from "../src/ids.mjs";
import { syncFrameAllowed } from "../src/server.mjs";

const STORAGE_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

test("a sync frame header skips the payload", () => {
  const documentId = noteId("notes/keep.md");
  const raw = encode({
    type: "sync",
    senderId: "sender1",
    targetId: "target1",
    documentId,
    data: Buffer.alloc(256 * 1024, 9),
  });
  const header = peekFrameHeader(raw);
  const full = decode(raw);
  assert.equal(header.type, "sync");
  assert.equal(header.documentId, documentId);
  assert.equal(header.senderId, full.senderId);
  assert.equal(header.data, undefined);
  assert.equal(full.data.length, 256 * 1024);
  assert.equal(syncFrameAllowed(raw), true);
});

test("a join frame is still checked in full", () => {
  const raw = encode({
    type: "join",
    senderId: "device1",
    supportedProtocolVersions: ["1"],
    peerMetadata: { storageId: STORAGE_ID, isEphemeral: false, deviceToken: "device-token-1" },
  });
  const header = peekFrameHeader(raw);
  assert.equal(header.type, "join");
  assert.equal(header.peerMetadata.storageId, STORAGE_ID);
  assert.equal(header.peerMetadata.deviceToken, "device-token-1");
  assert.equal(syncFrameAllowed(raw), true);
});

test("a large frame with a non-text document id is refused", () => {
  const raw = encode({
    type: "sync",
    documentId: 5,
    data: Buffer.alloc(80 * 1024, 1),
  });
  assert.equal(peekFrameHeader(raw).documentId, "\0");
  assert.equal(syncFrameAllowed(raw), false);
});

test("a truncated frame has no header", () => {
  const raw = encode({
    type: "sync",
    documentId: noteId("notes/keep.md"),
    data: Buffer.alloc(100, 1),
  });
  assert.equal(peekFrameHeader(raw.subarray(0, 8)), null);
  assert.equal(syncFrameAllowed(raw.subarray(0, 8)), false);
});
