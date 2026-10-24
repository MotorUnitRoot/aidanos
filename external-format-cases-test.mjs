import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkExternalFormatCases } from "./external-format-cases-check.mjs";

const root = path.dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(
  fs.readFileSync(path.join(root, "fixtures", "part-two-noteplan", "manifest.json"), "utf8"),
);

test("active external-format cases are listed and present", () => {
  checkExternalFormatCases(root);
});

for (const entry of manifest.pending) {
  test("case " + entry.number + " waits for spec v0.3", { skip: "waiting for v0.3" }, () => {
    throw new Error("pending case " + entry.number + " ran");
  });
}
