import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
export const name = "relay.fixture.ts.net"; // Synthetic name; no DNS/CA/tailnet call.
export async function localTLSFixture() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aidanos-local-ca-"));
  const run = (...args) => execFileSync("openssl", args, { cwd: dir, stdio: ["ignore", "pipe", "pipe"],
    env: { PATH: process.env.PATH, HOME: dir, TMPDIR: os.tmpdir() } });
  run("req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes", "-days", "1",
    "-subj", "/CN=AidanOS Disposable Test CA", "-keyout", "ca.key", "-out", "ca.crt");
  await fs.writeFile(path.join(dir, "ext.cnf"), "subjectAltName=DNS:" + name + "\nbasicConstraints=CA:FALSE\nkeyUsage=digitalSignature\nextendedKeyUsage=serverAuth\n");
  for (const stem of ["relay", "rotated"]) {
    run("req", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes", "-subj", "/CN=" + name,
      "-keyout", stem + ".key", "-out", stem + ".csr");
    run("x509", "-req", "-in", stem + ".csr", "-CA", "ca.crt", "-CAkey", "ca.key", "-CAcreateserial", "-days", "1",
      "-extfile", "ext.cnf", "-out", stem + ".crt");
    await fs.chmod(path.join(dir, stem + ".key"), 0o600);
  }
  return { dir, name, certFile: path.join(dir, "relay.crt"), keyFile: path.join(dir, "relay.key"), ca: await fs.readFile(path.join(dir, "ca.crt")) };
}
