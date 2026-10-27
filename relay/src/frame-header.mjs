// The accept thread only needs a few short strings from a sync frame.
// Decoding the whole frame builds the Automerge payload on that thread, and
// a multi-megabyte sync message was a multi-second event-loop gap. This walk
// reads the top-level map and skips byte strings without copying them.

const MAX_TEXT = 4096;
const MAX_DEPTH = 8;
const STRING_FIELDS = ["type", "documentId", "storageId", "senderId", "targetId"];

function asBytes(input) {
  if (input instanceof Uint8Array) return input;
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  return null;
}

function countAt(buf, pos, info) {
  if (info < 24) return { value: info, pos };
  if (pos >= buf.length) return null;
  if (info === 24) return { value: buf[pos], pos: pos + 1 };
  if (info === 25) {
    if (pos + 2 > buf.length) return null;
    return { value: buf[pos] * 256 + buf[pos + 1], pos: pos + 2 };
  }
  if (info === 26) {
    if (pos + 4 > buf.length) return null;
    return {
      value: buf[pos] * 16777216 + buf[pos + 1] * 65536 + buf[pos + 2] * 256 + buf[pos + 3],
      pos: pos + 4,
    };
  }
  if (info === 27) {
    if (pos + 8 > buf.length) return null;
    const hi = buf[pos] * 16777216 + buf[pos + 1] * 65536 + buf[pos + 2] * 256 + buf[pos + 3];
    const lo = buf[pos + 4] * 16777216 + buf[pos + 5] * 65536 + buf[pos + 6] * 256 + buf[pos + 7];
    if (hi > 0x1fffff) return null;
    return { value: hi * 0x100000000 + lo, pos: pos + 8 };
  }
  if (info === 31) return { indefinite: true, pos };
  return null;
}

function headerAt(buf, pos) {
  if (pos >= buf.length) return null;
  const byte = buf[pos];
  const major = byte >> 5;
  const info = byte & 31;
  const arg = countAt(buf, pos + 1, info);
  if (!arg) return null;
  return { major, info, value: arg.value || 0, indefinite: Boolean(arg.indefinite), pos: arg.pos };
}

function skipBytes(state, length) {
  if (!Number.isFinite(length) || length < 0 || state.pos + length > state.buf.length) return false;
  state.pos += length;
  return true;
}

function skipIndefinite(state, major) {
  for (;;) {
    if (state.pos >= state.buf.length) return false;
    if (state.buf[state.pos] === 0xff) {
      state.pos += 1;
      return true;
    }
    const head = headerAt(state.buf, state.pos);
    if (!head || head.major !== major || head.indefinite) return false;
    state.pos = head.pos;
    if (!skipBytes(state, head.value)) return false;
  }
}

function skipValue(state, depth) {
  if (depth > MAX_DEPTH) return false;
  const head = headerAt(state.buf, state.pos);
  if (!head) return false;
  state.pos = head.pos;
  if (head.major === 0 || head.major === 1) return !head.indefinite;
  if (head.major === 2 || head.major === 3) {
    if (head.indefinite) return skipIndefinite(state, head.major);
    return skipBytes(state, head.value);
  }
  if (head.major === 4) {
    if (head.indefinite) {
      for (;;) {
        if (state.pos >= state.buf.length) return false;
        if (state.buf[state.pos] === 0xff) {
          state.pos += 1;
          return true;
        }
        if (!skipValue(state, depth + 1)) return false;
      }
    }
    for (let i = 0; i < head.value; i += 1) {
      if (!skipValue(state, depth + 1)) return false;
    }
    return true;
  }
  if (head.major === 5) {
    if (head.indefinite) {
      for (;;) {
        if (state.pos >= state.buf.length) return false;
        if (state.buf[state.pos] === 0xff) {
          state.pos += 1;
          return true;
        }
        if (!skipValue(state, depth + 1) || !skipValue(state, depth + 1)) return false;
      }
    }
    for (let i = 0; i < head.value; i += 1) {
      if (!skipValue(state, depth + 1) || !skipValue(state, depth + 1)) return false;
    }
    return true;
  }
  if (head.major === 6) {
    if (head.indefinite) return false;
    return skipValue(state, depth + 1);
  }
  if (head.major === 7) {
    if (head.indefinite) return false;
    if (head.info === 24) return skipBytes(state, 1);
    if (head.info === 25) return skipBytes(state, 2);
    if (head.info === 26) return skipBytes(state, 4);
    if (head.info === 27) return skipBytes(state, 8);
    return head.info < 24;
  }
  return false;
}

function readText(state) {
  const head = headerAt(state.buf, state.pos);
  if (!head || head.major !== 3 || head.indefinite) return undefined;
  if (head.value > MAX_TEXT) return null;
  state.pos = head.pos;
  const end = state.pos + head.value;
  if (end > state.buf.length) return undefined;
  const text = Buffer.from(state.buf.subarray(state.pos, end)).toString("utf8");
  state.pos = end;
  return text;
}

// undefined: not a definite text value (caller skips). null: text longer than the cap.
function takeText(state) {
  const marked = state.pos;
  const head = headerAt(state.buf, state.pos);
  if (!head || head.major !== 3 || head.indefinite) return undefined;
  if (head.value > MAX_TEXT) {
    state.pos = marked;
    return null;
  }
  return readText(state);
}

// undefined: the next value is not a map and was not consumed.
// null: it was a map and the walk failed after consuming part of it.
function readStringMap(state, depth) {
  const marked = state.pos;
  const head = headerAt(state.buf, state.pos);
  if (!head || head.major !== 5) return undefined;
  state.pos = head.pos;
  const fields = {};
  const bad = [];
  function onePair() {
    const key = readText(state);
    if (typeof key !== "string") return false;
    const text = takeText(state);
    if (text === undefined) {
      if (!skipValue(state, depth + 1)) return false;
    } else if (text === null) {
      if (!skipValue(state, depth + 1)) return false;
      bad.push(key);
    } else {
      fields[key] = text;
    }
    return true;
  }
  let ok = true;
  if (head.indefinite) {
    for (;;) {
      if (state.pos >= state.buf.length) {
        ok = false;
        break;
      }
      if (state.buf[state.pos] === 0xff) {
        state.pos += 1;
        break;
      }
      if (!onePair()) {
        ok = false;
        break;
      }
    }
  } else {
    for (let i = 0; i < head.value; i += 1) {
      if (!onePair()) {
        ok = false;
        break;
      }
    }
  }
  if (!ok) {
    state.pos = marked;
    return null;
  }
  return { fields, bad };
}

function headerFrom(parsed) {
  const header = {};
  for (const key of STRING_FIELDS) {
    if (parsed.bad.includes(key)) header[key] = "\0";
    else if (Object.prototype.hasOwnProperty.call(parsed.fields, key)) header[key] = parsed.fields[key];
  }
  if (parsed.bad.includes("peerMetadata")) header.peerMetadata = { storageId: "\0" };
  else if (parsed.fields.peerMetadata && typeof parsed.fields.peerMetadata === "object") {
    header.peerMetadata = parsed.fields.peerMetadata;
  }
  return header;
}

// A plain object of the short header strings, or null when the bytes are not
// one CBOR map this walker understands. A long or non-text field we have to
// check becomes "\\0" so the caller rejects it instead of ignoring it.
export function peekFrameHeader(input) {
  const buf = asBytes(input);
  if (!buf || buf.length === 0) return null;
  const state = { buf, pos: 0 };
  const top = headerAt(buf, 0);
  if (!top || top.major !== 5) return null;
  state.pos = top.pos;
  const fields = {};
  const bad = [];
  function onePair() {
    const key = readText(state);
    if (typeof key !== "string") return false;
    if (STRING_FIELDS.includes(key)) {
      const text = takeText(state);
      if (text === undefined) {
        if (!skipValue(state, 1)) return false;
        bad.push(key);
      } else if (text === null) {
        if (!skipValue(state, 1)) return false;
        bad.push(key);
      } else {
        fields[key] = text;
      }
      return true;
    }
    if (key === "peerMetadata") {
      const nested = readStringMap(state, 1);
      if (nested === null) return false;
      if (nested) {
        fields.peerMetadata = nested.fields;
        if (nested.bad.includes("storageId")) bad.push("peerMetadata");
        return true;
      }
      if (!skipValue(state, 1)) return false;
      bad.push("peerMetadata");
      return true;
    }
    return skipValue(state, 1);
  }
  if (top.indefinite) {
    for (;;) {
      if (state.pos >= buf.length) return null;
      if (buf[state.pos] === 0xff) {
        state.pos += 1;
        break;
      }
      if (!onePair()) return null;
    }
  } else {
    for (let i = 0; i < top.value; i += 1) {
      if (!onePair()) return null;
    }
  }
  if (state.pos !== buf.length) return null;
  return headerFrom({ fields, bad });
}
