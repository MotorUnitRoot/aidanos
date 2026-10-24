import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkExternalFormatCases } from "./external-format-cases-check.mjs";

const root = path.dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(
  fs.readFileSync(path.join(root, "fixtures", "external-format", "manifest.json"), "utf8"),
);

test("active external-format cases are listed and present", () => {
  checkExternalFormatCases(root);
});

for (const entry of manifest.pending) {
  const guessedPending = entry.number === 39;
  const name = guessedPending
    ? "case 39 is Guessed in v0.3 and still pending"
    : "case " + entry.number + " waits for spec v0.3";
  const skip = guessedPending ? "Guessed in v0.3; still pending" : "waiting for v0.3";
  test(name, { skip }, () => {
    throw new Error("pending case " + entry.number + " ran");
  });
}
