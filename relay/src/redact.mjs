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
  out = out.replace(/https?:\/\/[^\s]+/gi, "[url]");
  out = out.replace(/file:\/\/[^\s]+/gi, "[url]");
  return out;
}

export function logSafe(secrets, ...parts) {
  const line = parts
    .map((part) => {
      if (part instanceof Error) return part.stack || part.message || "error";
      return String(part);
    })
    .join(" ");
  console.error(redact(line, secrets));
}
