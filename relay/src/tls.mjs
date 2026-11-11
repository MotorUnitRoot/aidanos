import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { X509Certificate, createHash, createPrivateKey } from "node:crypto";
import { createSecureContext } from "node:tls";
import { isTailscaleIPv4 } from "./bind.mjs";

const codeRoot = fileURLToPath(new URL("../", import.meta.url));
class TLSConfigurationError extends Error {}
async function codeRoots() {
  const roots = [codeRoot]; let current = path.resolve(codeRoot);
  for (;;) {
    try { await fs.lstat(path.join(current, ".git")); roots.push(current); break; }
    catch (error) { if (error.code !== "ENOENT" && error.code !== "ENOTDIR") throw error; }
    const parent = path.dirname(current); if (parent === current) break; current = parent;
  }
  return roots;
}
export function validTLSName(name) {
  return typeof name === "string" && name === name.toLowerCase() && name.endsWith(".ts.net") && name.length <= 253 &&
    name.split(".").every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label));
}
const inside = (parent, child) => { const rel = path.relative(parent, child); return rel === "" || (!rel.startsWith(".." + path.sep) && rel !== ".." && !path.isAbsolute(rel)); };
async function safeLocation(file, forbidden) {
  const resolved = await fs.realpath(file);
  for (const root of [...await codeRoots(), ...forbidden]) {
    let real; try { real = await fs.realpath(root); } catch (error) { if (error.code !== "ENOENT") throw error; real = path.resolve(root); }
    if (inside(real, resolved)) throw new TLSConfigurationError("TLS files must be outside the repository, vault and relay data.");
  }
  return resolved;
}
export async function loadRelayTLS({ name, certFile, keyFile, forbidden = [] }) {
  if (!name && !certFile && !keyFile) throw new Error("Production sync requires TLS; configure the exact name, certificate and private-key files.");
  if (!validTLSName(name) || !certFile || !keyFile) throw new Error("TLS requires one exact lowercase MagicDNS name, certificate file and private-key file.");
  try {
    const before = await fs.lstat(keyFile);
    if (!before.isFile() || before.nlink !== 1) throw new TLSConfigurationError("TLS private key must be a relay-owned regular single-link 0600 file, not a symlink or hardlink.");
    const location = await safeLocation(keyFile, forbidden);
    const handle = await fs.open(keyFile, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    let key;
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.nlink !== 1 || before.isSymbolicLink() || before.ino !== stat.ino || before.dev !== stat.dev ||
          (stat.mode & 0o7777) !== 0o600 || typeof process.getuid !== "function" || stat.uid !== process.getuid() ||
          await fs.realpath(keyFile) !== location) throw new TLSConfigurationError("TLS private key must be a relay-owned regular single-link 0600 file, not a symlink or hardlink.");
      key = await handle.readFile();
      const after = await handle.stat();
      if (!after.isFile() || after.nlink !== 1 || after.ino !== before.ino || after.dev !== before.dev ||
          after.ino !== stat.ino || after.dev !== stat.dev || (after.mode & 0o7777) !== 0o600 || after.uid !== stat.uid) {
        throw new TLSConfigurationError("TLS private key changed while reading; require the same relay-owned regular single-link 0600 file.");
      }
    } finally { await handle.close(); }
    await safeLocation(certFile, forbidden);
    const cert = await fs.readFile(certFile);
    if (cert.includes(Buffer.from("PRIVATE KEY"))) throw new TLSConfigurationError("Certificate chain must not contain a private key.");
    const leaf = new X509Certificate(cert);
    if (leaf.checkHost(name, { subject: "never", wildcards: false, partialWildcards: false, multiLabelWildcards: false }) !== name ||
        Date.parse(leaf.validFrom) > Date.now() || Date.parse(leaf.validTo) <= Date.now() || !leaf.checkPrivateKey(createPrivateKey(key))) {
      throw new TLSConfigurationError("TLS certificate/key must match the exact relay name and current validity.");
    }
    const context = { key, cert, minVersion: "TLSv1.2" };
    createSecureContext(context);
    const spki = "sha256/" + createHash("sha256").update(leaf.publicKey.export({ type: "spki", format: "der" })).digest("base64");
    return { context, name, spki };
  } catch (error) {
    // Never embed OpenSSL errors, certificate/key contents, or input paths.
    if (error instanceof TLSConfigurationError) throw error;
    throw new Error("TLS material refused; check private-key ownership/mode and the exact certificate/name.", { cause: error });
  }
}
export function pairingRecord({ name, port, ip, spki }) {
  if (!validTLSName(name) || !Number.isInteger(port) || port < 1 || port > 65535 || !isTailscaleIPv4(ip) || !/^sha256\/[A-Za-z0-9+/]{43}=$/.test(spki)) {
    throw new Error("Pairing requires an exact WSS name/port, Tailscale IPv4 and SPKI fingerprint.");
  }
  return { version: 1, address: "wss://" + name + ":" + port + "/", ipv4: ip, spki };
}
export async function writePairingFile(file, record, forbidden) {
  const parent = await fs.realpath(path.dirname(file));
  for (const root of [...await codeRoots(), ...forbidden]) if (inside(path.resolve(root), parent)) throw new Error("Pairing display file must be outside repo/vault/data.");
  try { const old = await fs.lstat(file); if (!old.isFile() || old.isSymbolicLink() || old.uid !== process.getuid()) throw new Error("Pairing output must be a relay-owned regular file."); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  const temp = path.join(parent, ".aidanos-pairing-" + process.pid + ".json");
  await fs.writeFile(temp, JSON.stringify(record) + "\n", { flag: "wx", mode: 0o600 });
  await fs.rename(temp, file);
}
