#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = path.dirname(fileURLToPath(import.meta.url));
const sh = fs.readFileSync(path.join(root, "start.sh"), "utf8");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const server = fs.readFileSync(path.join(root, "server.mjs"), "utf8");
function assert(c, m) { if (!c) throw new Error(m); }
assert(fs.existsSync(path.join(root, "start.sh")), "missing start.sh");
const mode = fs.statSync(path.join(root, "start.sh")).mode;
assert((mode & 0o111) !== 0, "start.sh not executable");
assert(sh.includes("n"+"pm start"), "start.sh must use package start");
assert(sh.includes("nohup") || sh.includes("setsid"), "start.sh must detach");
assert(sh.indexOf("/Users/colby") < 0, "do not bake Mac path");
assert(sh.includes("AIDANOS_VAULT"), "honor vault env");
assert(/unset\s+AIDANOS_VAULT/.test(sh), "empty vault env must be unset");
assert(pkg.scripts.start === "node server.mjs", "package start is server");
assert(server.includes('const HOST = "127.0.0.1"'), "HOST must be 127.0.0.1");
console.log("stay-up-test ok");
