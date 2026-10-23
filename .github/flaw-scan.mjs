#!/usr/bin/env node
/**
 * Rank findings for the weekly flaw scan.
 *
 * A finding is urgent only when one of these is true:
 * - Its CVE is on CISA's Known Exploited Vulnerabilities list.
 * - Its severity is critical and it is reachable from the internet.
 * - The hosted image's Node, or the Linux distribution that image is
 *   built on, is past its end-of-support date.
 *
 * Reachable means the hosted container image or the server code that
 * image runs. Dev-only and CI-only tooling is not reachable.
 *
 * End of support is a summary warning from 60 days before the date.
 * It becomes urgent once that date has passed. End of support is the
 * day security fixes stop.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DAY_MS = 24 * 60 * 60 * 1000;
const OTHER_LIMIT = 80;
const SEVERITY_ORDER = ["CRITICAL", "HIGH", "MEDIUM", "LOW", "UNKNOWN"];
const SEVERITY_FROM_INT = ["UNKNOWN", "LOW", "MEDIUM", "HIGH", "CRITICAL"];
const WHERE_LABEL = {
  image: "hosted image",
  server: "server code",
  ci: "CI only",
  dev: "dev only",
  "not-shipped": "outside the hosted image",
};
const MANIFESTS = new Set([
  "package.json",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "pnpm-lock.yaml",
]);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function severityRank(severity) {
  const index = SEVERITY_ORDER.indexOf(severity);
  return index === -1 ? SEVERITY_ORDER.length : index;
}

function parseDay(iso) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || "").trim());
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const utc = Date.UTC(year, month - 1, day);
  const check = new Date(utc);
  if (
    check.getUTCFullYear() !== year ||
    check.getUTCMonth() !== month - 1 ||
    check.getUTCDate() !== day
  ) {
    return null;
  }
  return utc;
}

function dateOnly(value) {
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(String(value || ""));
  return match ? match[1] : null;
}

export function supportStatus(eolIso, todayIso) {
  const eol = parseDay(eolIso);
  const today = parseDay(todayIso);
  if (eol == null || today == null) return { status: "unknown", daysUntil: null };
  const daysUntil = Math.round((eol - today) / DAY_MS);
  if (daysUntil < 0) return { status: "urgent", daysUntil };
  if (daysUntil <= 60) return { status: "warn", daysUntil };
  return { status: "ok", daysUntil };
}

export function parseNodeVersion(text) {
  const match = String(text || "").match(/v?\d+\.\d+\.\d+/);
  return match ? match[0] : "";
}

export function nodeCycle(version) {
  const match = String(version || "").match(/v?(\d+)\./);
  return match ? match[1] : "";
}

export function parseOsRelease(text) {
  const map = {};
  for (const line of String(text || "").split(/\r?\n/)) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (!match) continue;
    map[match[1]] = match[2].replace(/^"|"$/g, "");
  }
  return {
    id: String(map.ID || "").toLowerCase(),
    versionId: String(map.VERSION_ID || ""),
    codename: String(map.VERSION_CODENAME || "").toLowerCase(),
  };
}

function logicalLines(text) {
  const lines = [];
  let buffer = "";
  for (const raw of String(text || "").split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, "");
    if (line.endsWith("\\")) {
      buffer += line.slice(0, -1) + " ";
      continue;
    }
    buffer += line;
    lines.push(buffer);
    buffer = "";
  }
  if (buffer) lines.push(buffer);
  return lines;
}

function tokenize(line) {
  const tokens = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let match;
  while ((match = re.exec(line))) tokens.push(match[1] ?? match[2] ?? match[3]);
  return tokens;
}

export function copySources(dockerfileText) {
  const sources = [];
  for (const line of logicalLines(dockerfileText)) {
    const trimmed = line.trim();
    if (!/^COPY\b/i.test(trimmed)) continue;
    const withoutComment = trimmed.replace(/\s+#.*$/, "");
    const tokens = tokenize(withoutComment).slice(1).filter((token) => !token.startsWith("--"));
    if (tokens.length < 2) continue;
    tokens.pop();
    for (const source of tokens) sources.push(source.replace(/^\.\//, ""));
  }
  return sources;
}

export function pathIsCopied(rel, sources) {
  const norm = String(rel || "").replace(/\\/g, "/").replace(/^\.\//, "");
  for (const source of sources) {
    const clean = String(source).replace(/^\.\//, "").replace(/\/$/, "");
    if (norm === clean || norm.startsWith(clean + "/")) return true;
  }
  return false;
}

function safeRel(rel) {
  const norm = String(rel || "").replace(/\\/g, "/").replace(/^\.\//, "");
  if (!norm || norm.startsWith("..") || norm.startsWith("/") || norm.includes("\0")) return "";
  return norm;
}

export function serverCodePaths(readFile) {
  const seen = new Set();
  const tried = new Set();
  const queue = ["server.mjs"];
  while (queue.length > 0) {
    const rel = queue.shift();
    if (tried.has(rel)) continue;
    tried.add(rel);
    let text;
    try {
      text = readFile(rel);
    } catch {
      continue;
    }
    if (typeof text !== "string") continue;
    seen.add(rel);
    const re = /(?:from\s+|import\s*\(\s*|import\s+)["'](\.[^"']+)["']/g;
    let match;
    while ((match = re.exec(text))) {
      const dir = rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : ".";
      const joined = safeRel(path.posix.normalize(path.posix.join(dir, match[1])));
      if (!joined) continue;
      for (const candidate of [joined, joined + ".mjs", joined + ".js"]) {
        if (!tried.has(candidate)) queue.push(candidate);
      }
    }
  }
  return seen;
}

function devDependencyNames(pkg) {
  const names = new Set();
  const dev = pkg && pkg.devDependencies;
  if (dev && typeof dev === "object" && !Array.isArray(dev)) {
    for (const name of Object.keys(dev)) names.add(name);
  }
  return names;
}

export function trivyResults(report) {
  if (report == null) return [];
  if (Array.isArray(report)) return report;
  if (Array.isArray(report.Results)) return report.Results;
  if (report.Results == null) return [];
  throw new Error("Trivy report has no Results array");
}

export function severityOf(vuln) {
  const direct = String((vuln && vuln.Severity) || "").toUpperCase();
  if (SEVERITY_ORDER.includes(direct)) return direct;
  let best = "UNKNOWN";
  const vendor = vuln && vuln.VendorSeverity;
  if (vendor && typeof vendor === "object") {
    for (const value of Object.values(vendor)) {
      let name = "UNKNOWN";
      if (typeof value === "number" && SEVERITY_FROM_INT[value]) name = SEVERITY_FROM_INT[value];
      else if (typeof value === "string" && SEVERITY_ORDER.includes(value.toUpperCase())) {
        name = value.toUpperCase();
      }
      if (severityRank(name) < severityRank(best)) best = name;
    }
  }
  return best;
}

export function cveIdsOf(vuln) {
  const cveRe = /CVE-\d{4}-\d{4,}/gi;
  const chunks = [vuln && vuln.VulnerabilityID, vuln && vuln.PrimaryURL, vuln && vuln.Title];
  if (vuln && Array.isArray(vuln.VendorIDs)) chunks.push(...vuln.VendorIDs);
  if (vuln && Array.isArray(vuln.References)) chunks.push(...vuln.References);
  const ids = new Set();
  for (const chunk of chunks) {
    for (const match of String(chunk || "").matchAll(cveRe)) ids.add(match[0].toUpperCase());
  }
  return [...ids];
}

export function scannerSaysKev(vuln) {
  if (!vuln || typeof vuln !== "object") return false;
  if (vuln.CisaKev) return true;
  const cisa = vuln.CISA;
  if (cisa && typeof cisa === "object" && (cisa.KnownExploited || cisa.kev || cisa.KEV)) return true;
  return false;
}

function repoRelative(target, root) {
  let text = String(target || "").replace(/\\/g, "/");
  const abs = String(root || "").replace(/\\/g, "/").replace(/\/$/, "");
  if (abs && (text === abs || text.startsWith(abs + "/"))) {
    text = text.slice(abs.length).replace(/^\//, "");
  }
  if (text.startsWith("./")) text = text.slice(2);
  return text;
}

function isCiPath(rel) {
  return rel === ".github" || rel.startsWith(".github/");
}

function isDevPath(rel) {
  if (rel === "eslint.config.js") return true;
  if (/(^|\/)[^/]*-test\.mjs$/.test(rel)) return true;
  if (/(^|\/)[^/]*\.test\.mjs$/.test(rel)) return true;
  return false;
}

function isManifest(rel) {
  return MANIFESTS.has(rel.split("/").pop());
}

function classifyRepo(result, vuln, ctx) {
  const target = repoRelative(result.Target, ctx.root);
  if (isCiPath(target)) return { reachable: false, where: "ci" };
  if (isDevPath(target)) return { reachable: false, where: "dev" };
  if (ctx.devNames.has(vuln.PkgName)) return { reachable: false, where: "dev" };
  if (ctx.serverPaths.has(target)) return { reachable: true, where: "server" };
  if (isManifest(target)) return { reachable: false, where: "not-shipped" };
  if (pathIsCopied(target, ctx.copied)) return { reachable: true, where: "image" };
  return { reachable: false, where: "not-shipped" };
}

function toFinding(result, vuln, surface, ctx) {
  const cves = cveIdsOf(vuln);
  const id = (vuln && vuln.VulnerabilityID) || cves[0] || "unknown";
  const kev = scannerSaysKev(vuln) || cves.some((cve) => ctx.kevSet.has(cve));
  const place = surface === "image"
    ? { reachable: true, where: "image" }
    : classifyRepo(result, vuln, ctx);
  return {
    id,
    cves,
    package: (vuln && vuln.PkgName) || "",
    installed: (vuln && vuln.InstalledVersion) || "",
    fixed: (vuln && vuln.FixedVersion) || "",
    severity: severityOf(vuln),
    kev,
    reachable: place.reachable,
    where: place.where,
    target: String((result && result.Target) || ""),
    type: String((result && result.Type) || ""),
    targets: [String((result && result.Target) || "")],
  };
}

function collect(report, surface, ctx) {
  const found = [];
  for (const result of trivyResults(report)) {
    const vulns = result && result.Vulnerabilities;
    if (!Array.isArray(vulns)) continue;
    for (const vuln of vulns) {
      if (vuln && typeof vuln === "object") found.push(toFinding(result, vuln, surface, ctx));
    }
  }
  return found;
}

function preferWhere(left, right) {
  const rank = { image: 0, server: 1 };
  return (rank[left] ?? 9) <= (rank[right] ?? 9) ? left : right;
}

function applyUrgency(finding) {
  const reasons = [];
  if (finding.kev) reasons.push("On CISA's Known Exploited Vulnerabilities list");
  if (finding.severity === "CRITICAL" && finding.reachable) {
    reasons.push("Critical and reachable from the internet");
  }
  finding.reasons = reasons;
  finding.urgent = reasons.length > 0;
  return finding;
}

function mergeFindings(list) {
  const map = new Map();
  for (const incoming of list) {
    const key = [incoming.id, incoming.package, incoming.installed].join("\0");
    const existing = map.get(key);
    if (!existing) {
      map.set(key, { ...incoming, cves: [...incoming.cves], targets: [...incoming.targets] });
      continue;
    }
    existing.kev = existing.kev || incoming.kev;
    if (incoming.reachable) {
      existing.where = existing.reachable ? preferWhere(existing.where, incoming.where) : incoming.where;
      existing.reachable = true;
    }
    if (severityRank(incoming.severity) < severityRank(existing.severity)) {
      existing.severity = incoming.severity;
    }
    if (!existing.fixed && incoming.fixed) existing.fixed = incoming.fixed;
    for (const cve of incoming.cves) {
      if (!existing.cves.includes(cve)) existing.cves.push(cve);
    }
    if (incoming.target && !existing.targets.includes(incoming.target)) existing.targets.push(incoming.target);
  }
  return [...map.values()].map(applyUrgency);
}

function sortFindings(findings) {
  return findings.sort((a, b) => {
    if (a.urgent !== b.urgent) return a.urgent ? -1 : 1;
    if (a.urgent && b.urgent && a.kev !== b.kev) return a.kev ? -1 : 1;
    const severity = severityRank(a.severity) - severityRank(b.severity);
    if (severity !== 0) return severity;
    if (a.reachable !== b.reachable) return a.reachable ? -1 : 1;
    const id = a.id.localeCompare(b.id);
    if (id !== 0) return id;
    return a.package.localeCompare(b.package);
  });
}

function lookupNodeEol(cycle, schedule, endoflife, problems, cache) {
  if (cache.has(cycle)) return cache.get(cycle);
  let scheduleEol = null;
  if (schedule && typeof schedule === "object") {
    const row = schedule["v" + cycle] || schedule[cycle];
    if (row && row.end) scheduleEol = dateOnly(row.end);
  }
  let listedEol = null;
  if (Array.isArray(endoflife)) {
    const row = endoflife.find((item) => String(item.cycle) === String(cycle));
    if (row) listedEol = dateOnly(row.eol);
  }
  if (scheduleEol && listedEol && scheduleEol !== listedEol) {
    problems.push(
      `Node ${cycle} end-of-support dates differ: Node.js release schedule ${scheduleEol}, endoflife.date ${listedEol}. Using the Node.js release schedule.`,
    );
  }
  let result = null;
  if (scheduleEol) result = { eol: scheduleEol, source: "Node.js release schedule" };
  else if (listedEol) result = { eol: listedEol, source: "endoflife.date" };
  else problems.push(`No end-of-support date for Node ${cycle}.`);
  cache.set(cycle, result);
  return result;
}

function lookupDebianEol(osInfo, rows, problems) {
  if (!Array.isArray(rows)) {
    problems.push("Debian end-of-support list was missing.");
    return null;
  }
  const row = rows.find((item) => String(item.cycle) === String(osInfo.versionId))
    || rows.find((item) => String(item.codename || "").toLowerCase() === osInfo.codename);
  if (!row) {
    problems.push(`No end-of-support date for Debian ${osInfo.versionId || osInfo.codename || "unknown"}.`);
    return null;
  }
  const eol = dateOnly(row.eol);
  if (!eol) {
    problems.push(`Debian ${row.cycle} has no dated end of support.`);
    return null;
  }
  const name = "Debian " + row.cycle + (row.codename ? " " + row.codename : "");
  return { eol, source: "endoflife.date", name };
}

function runtimeFromLookup(label, looked, today, counts, role) {
  if (!looked) {
    return { label, status: "unknown", counts, eol: null, daysUntil: null, source: "", role };
  }
  const window = supportStatus(looked.eol, today);
  return {
    label,
    status: window.status,
    counts,
    eol: looked.eol,
    daysUntil: window.daysUntil,
    source: looked.source,
    role,
  };
}

function hostedNodeRuntime(input, problems, cache) {
  const version = parseNodeVersion(input.nodeVersionText);
  const cycle = nodeCycle(version);
  if (!version || !cycle) {
    problems.push("Could not read the Node version inside the hosted image.");
    return {
      label: "Hosted image Node",
      status: "unknown",
      counts: true,
      eol: null,
      daysUntil: null,
      source: "",
      role: "hosted-node",
    };
  }
  const looked = lookupNodeEol(cycle, input.nodeSchedule, input.nodeEol, problems, cache);
  return runtimeFromLookup("Hosted image Node " + version, looked, input.today, true, "hosted-node");
}

function hostedOsRuntime(input, problems) {
  const osInfo = parseOsRelease(input.osReleaseText);
  if (osInfo.id !== "debian") {
    problems.push(
      "Hosted image OS is " + (osInfo.id || "unknown") + ". End-of-support dates in this scan cover Debian, the base of the Node slim image.",
    );
    return {
      label: "Hosted image OS " + (osInfo.id || "unknown"),
      status: "unknown",
      counts: true,
      eol: null,
      daysUntil: null,
      source: "",
      role: "hosted-os",
    };
  }
  const looked = lookupDebianEol(osInfo, input.debianEol, problems);
  const name = looked && looked.name ? looked.name : "Debian " + (osInfo.versionId || osInfo.codename);
  return runtimeFromLookup("Hosted image " + name, looked, input.today, true, "hosted-os");
}

function actionsNodeRuntime(input, problems, cache) {
  if (input.actionsNodeText == null || String(input.actionsNodeText).trim() === "") return null;
  const version = parseNodeVersion(input.actionsNodeText);
  const cycle = nodeCycle(version);
  if (!version || !cycle) {
    problems.push("Could not read the Node version in .nvmrc.");
    return {
      label: "GitHub Actions Node",
      status: "unknown",
      counts: false,
      eol: null,
      daysUntil: null,
      source: "",
      role: "actions-node",
    };
  }
  const looked = lookupNodeEol(cycle, input.nodeSchedule, input.nodeEol, problems, cache);
  return runtimeFromLookup("GitHub Actions Node " + version, looked, input.today, false, "actions-node");
}

export function buildReport(input) {
  const problems = [];
  const cache = new Map();
  const copied = copySources(input.dockerfileText || "");
  const serverPaths = serverCodePaths(input.readFile || (() => {
    throw new Error("missing");
  }));
  const ctx = {
    root: input.root || "",
    kevSet: input.kevSet || new Set(),
    copied,
    serverPaths,
    devNames: devDependencyNames(input.packageJson),
  };
  const findings = sortFindings(mergeFindings([
    ...collect(input.image, "image", ctx),
    ...collect(input.repo, "repo", ctx),
  ]));
  const runtimes = [hostedNodeRuntime(input, problems, cache), hostedOsRuntime(input, problems)];
  const actions = actionsNodeRuntime(input, problems, cache);
  if (actions) runtimes.push(actions);
  const complete = runtimes.every((runtime) => !runtime.counts || runtime.status !== "unknown");
  const urgent = findings.some((finding) => finding.urgent)
    || runtimes.some((runtime) => runtime.counts && runtime.status === "urgent");
  return {
    schemaVersion: 1,
    today: input.today,
    scanner: input.scanner || "Trivy",
    urgent,
    complete,
    problems,
    runtimes,
    findings,
    copied,
    serverPaths: [...serverPaths].sort(),
  };
}

function runtimeSentence(runtime) {
  if (runtime.status === "unknown") {
    return runtime.label + ": no end-of-support date.";
  }
  if (runtime.status === "urgent") {
    return runtime.label + " passed end of support on " + runtime.eol + " (" + runtime.source + ").";
  }
  if (runtime.status === "warn") {
    return runtime.label + " reaches end of support on " + runtime.eol + ", " + runtime.daysUntil + " days left (" + runtime.source + ").";
  }
  return runtime.label + " is supported through " + runtime.eol + ", " + runtime.daysUntil + " days left (" + runtime.source + ").";
}

function findingSentence(finding) {
  const bits = [finding.id];
  if (finding.package) bits.push(finding.package + (finding.installed ? " " + finding.installed : ""));
  else if (finding.installed) bits.push(finding.installed);
  bits.push(String(finding.severity || "unknown").toLowerCase());
  bits.push(WHERE_LABEL[finding.where] || finding.where);
  if (finding.fixed) bits.push("fixed in " + finding.fixed);
  if (finding.urgent && finding.reasons.length) bits.push(finding.reasons.join("; "));
  return bits.join(", ");
}

function otherCountSentence(findings) {
  if (findings.length === 0) return "No other findings.";
  const buckets = { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0, UNKNOWN: 0 };
  for (const finding of findings) {
    if (buckets[finding.severity] == null) buckets[finding.severity] = 0;
    buckets[finding.severity] += 1;
  }
  return "Ranked below: "
    + buckets.CRITICAL + " critical, "
    + buckets.HIGH + " high, "
    + buckets.MEDIUM + " medium, "
    + buckets.LOW + " low, "
    + buckets.UNKNOWN + " unknown.";
}

export function renderReport(report) {
  const lines = [];
  const urgentFindings = report.findings.filter((finding) => finding.urgent);
  const urgentRuntimes = report.runtimes.filter((runtime) => runtime.counts && runtime.status === "urgent");
  lines.push("# Weekly flaw scan");
  lines.push("");
  lines.push("Date: " + report.today + ". Scanner: " + report.scanner + ".");
  lines.push("");
  if (report.urgent) {
    lines.push("Result: urgent (" + (urgentFindings.length + urgentRuntimes.length) + "). This run fails.");
  } else if (!report.complete) {
    lines.push("Result: the scan did not finish.");
  } else {
    lines.push("Result: nothing urgent.");
  }
  lines.push("");
  lines.push("## Base runtime");
  lines.push("");
  lines.push("End of support is judged on the hosted image. A warning starts 60 days before the date. The finding is urgent once that date has passed. GitHub Actions installs Node from .nvmrc; that line is here so the two versions can be compared.");
  lines.push("");
  for (const runtime of report.runtimes) lines.push("- " + runtimeSentence(runtime));
  lines.push("");
  lines.push("## Urgent");
  lines.push("");
  if (urgentFindings.length === 0 && urgentRuntimes.length === 0) lines.push("None.");
  for (const runtime of urgentRuntimes) lines.push("- " + runtimeSentence(runtime));
  for (const finding of urgentFindings) lines.push("- " + findingSentence(finding));
  lines.push("");
  lines.push("## Other findings");
  lines.push("");
  const others = report.findings.filter((finding) => !finding.urgent);
  lines.push(otherCountSentence(others));
  lines.push("");
  const shown = others.slice(0, OTHER_LIMIT);
  if (shown.length === 0) lines.push("None.");
  shown.forEach((finding, index) => {
    lines.push((index + 1) + ". " + findingSentence(finding));
  });
  if (others.length > shown.length) {
    lines.push("");
    lines.push((others.length - shown.length) + " more are in the JSON report, in the same rank order.");
  }
  if (report.problems.length) {
    lines.push("");
    lines.push("## Could not decide");
    lines.push("");
    for (const problem of report.problems) lines.push("- " + problem);
  }
  lines.push("");
  lines.push("## Rule");
  lines.push("");
  lines.push("Urgent means the finding is on CISA's Known Exploited Vulnerabilities list, or it is critical and reachable from the internet, or the hosted image's Node or Linux is past end of support.");
  lines.push("Reachable means the hosted container image, or the server code that image runs. Dev-only and CI-only tooling stays in this summary.");
  lines.push("");
  return lines.join("\n");
}

function writeStepSummary(summary) {
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (!summaryPath || !summary) return;
  fs.appendFileSync(summaryPath, summary + "\n");
}

function readJson(file) {
  const text = fs.readFileSync(file, "utf8");
  if (!String(text).trim()) throw new Error(file + " is empty");
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(file + " is not JSON: " + error.message);
  }
}

function kevSetFrom(catalog) {
  if (!catalog || !Array.isArray(catalog.vulnerabilities)) {
    throw new Error("CISA catalog has no vulnerabilities array");
  }
  const set = new Set();
  for (const item of catalog.vulnerabilities) {
    if (item && item.cveID) set.add(String(item.cveID).toUpperCase());
  }
  return set;
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--self-test") {
      out.selfTest = true;
      continue;
    }
    if (!arg.startsWith("--")) throw new Error("unexpected argument " + arg);
    const value = argv[i + 1];
    if (value == null || value.startsWith("--")) throw new Error("missing value for " + arg);
    out[arg.slice(2)] = value;
    i += 1;
  }
  return out;
}

function todayUtc() {
  return new Date().toISOString().slice(0, 10);
}

function writeOutput(file, text) {
  if (!file) return;
  const full = path.resolve(file);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, text);
}

function diskReader(root) {
  return (rel) => fs.readFileSync(path.join(root, rel), "utf8");
}

function run(argv) {
  const args = parseArgs(argv);
  const root = path.resolve(args.root || process.cwd());
  const dockerfilePath = path.resolve(root, args.dockerfile || "Dockerfile");
  let packageJson = {};
  const packagePath = path.join(root, "package.json");
  if (fs.existsSync(packagePath)) packageJson = readJson(packagePath);
  const nodeSchedule = args["node-schedule"] ? readJson(args["node-schedule"]) : null;
  const nodeEol = args["node-eol"] ? readJson(args["node-eol"]) : null;
  if (!nodeSchedule && !nodeEol) throw new Error("missing --node-schedule or --node-eol");
  const report = buildReport({
    today: args.today || todayUtc(),
    scanner: args.scanner || "Trivy",
    kevSet: kevSetFrom(readJson(args.kev)),
    dockerfileText: fs.readFileSync(dockerfilePath, "utf8"),
    readFile: diskReader(root),
    packageJson,
    image: readJson(args.image),
    repo: readJson(args.repo),
    nodeVersionText: fs.readFileSync(args["node-version"], "utf8"),
    osReleaseText: fs.readFileSync(args["os-release"], "utf8"),
    nodeSchedule,
    nodeEol,
    debianEol: readJson(args["debian-eol"]),
    actionsNodeText: args["actions-node"] ? fs.readFileSync(args["actions-node"], "utf8") : null,
    root,
  });
  const summary = renderReport(report);
  writeOutput(args["out-md"], summary);
  writeOutput(args["out-json"], JSON.stringify(report, null, 2) + "\n");
  console.log(summary);
  writeStepSummary(summary);
  if (!report.complete && !report.urgent) process.exit(2);
  if (report.urgent) process.exit(1);
  process.exit(0);
}

function vuln(fields) {
  return {
    VulnerabilityID: fields.id,
    PkgName: fields.pkg || "pkg",
    InstalledVersion: fields.installed || "1.0.0",
    FixedVersion: fields.fixed || "",
    Severity: fields.severity,
    References: fields.references || [],
    CisaKev: fields.cisa || undefined,
  };
}

function repoResult(target, vulnerabilities, extra) {
  return {
    Target: target,
    Class: (extra && extra.class) || "lang-pkgs",
    Type: (extra && extra.type) || "npm",
    Vulnerabilities: vulnerabilities,
  };
}

function baseInput(overrides) {
  return {
    today: overrides.today || "2026-10-23",
    scanner: "test",
    kevSet: new Set(overrides.kev || []),
    dockerfileText: overrides.dockerfile || "FROM node:22-slim\nCOPY server.mjs ./\n",
    readFile: overrides.readFile || (() => {
      throw new Error("missing");
    }),
    packageJson: overrides.packageJson || {},
    image: overrides.image || { Results: [] },
    repo: overrides.repo || { Results: [] },
    nodeVersionText: overrides.nodeVersion || "v22.23.4\n",
    osReleaseText: overrides.os || "ID=debian\nVERSION_ID=\"12\"\nVERSION_CODENAME=bookworm\n",
    nodeSchedule: overrides.schedule || {
      v18: { end: "2025-04-30" },
      v20: { end: "2026-04-30" },
      v22: { end: "2027-04-30" },
    },
    nodeEol: overrides.nodeEol || null,
    debianEol: overrides.debian || [{ cycle: "12", codename: "Bookworm", eol: "2028-06-30" }],
    actionsNodeText: overrides.actionsNode,
    root: overrides.root || "",
  };
}

function selfTest() {
  assert(supportStatus("2026-04-30", "2026-03-01").status === "warn", "60 days before is a warning");
  assert(supportStatus("2026-04-30", "2026-03-01").daysUntil === 60, "March 1 is 60 days before April 30");
  assert(supportStatus("2026-04-30", "2026-02-28").status === "ok", "61 days before stays quiet");
  assert(supportStatus("2026-04-30", "2026-04-30").status === "warn", "end-of-support day is still a warning");
  assert(supportStatus("2026-04-30", "2026-05-01").status === "urgent", "the day after is urgent");
  assert(supportStatus("2026-04-30", "2026-10-23").status === "urgent", "Node 20 date has passed");
  assert(supportStatus("2027-04-30", "2026-10-23").status === "ok", "Node 22 is outside the warning window");

  const continued = copySources("COPY --chown=node:node a.txt \\\n  b.txt \\\n  ./dest\n");
  assert(continued.length === 2 && continued[0] === "a.txt" && continued[1] === "b.txt", "COPY continuation");

  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const dockerfile = fs.readFileSync(path.join(repoRoot, "Dockerfile"), "utf8");
  const sources = copySources(dockerfile);
  assert(/^FROM node:/m.test(dockerfile), "hosted image is a node base");
  assert(sources.length < 30, "copy parser stayed on COPY lines, got " + sources.length);
  for (const expected of ["package.json", "server.mjs", "app.js", "vault", "start.sh", "sw.js"]) {
    assert(sources.includes(expected), "dockerfile copies " + expected);
  }
  assert(pathIsCopied("vault/maps/the-reply.md", sources), "vault file ships in the image");
  assert(!pathIsCopied("search-test.mjs", sources), "tests stay out of the image");
  const realServer = serverCodePaths((rel) => fs.readFileSync(path.join(repoRoot, rel), "utf8"));
  assert(realServer.has("server.mjs"), "server.mjs is on the server path");

  const imported = serverCodePaths((rel) => {
    if (rel === "server.mjs") return "import { a } from \"./lib.mjs\";\n";
    if (rel === "lib.mjs") return "export const a = 1;\n";
    throw new Error("missing " + rel);
  });
  assert(imported.has("server.mjs") && imported.has("lib.mjs"), "local imports are server code");

  const quiet = buildReport(baseInput({}));
  assert(quiet.urgent === false && quiet.complete === true, "supported image with no findings is clear");
  assert(quiet.runtimes.some((runtime) => runtime.role === "hosted-node" && runtime.status === "ok"), "node 22 is supported");

  const past = buildReport(baseInput({ nodeVersion: "v20.19.0\n" }));
  assert(past.urgent === true, "hosted Node 20 is past end of support");
  assert(past.runtimes.some((runtime) => runtime.role === "hosted-os" && runtime.status === "ok"), "Debian 12 is still supported");
  assert(renderReport(past).includes("passed end of support on 2026-04-30"), "summary names the Node 20 date");

  const soon = buildReport(baseInput({
    today: "2026-03-01",
    nodeVersion: "v20.19.0\n",
  }));
  assert(soon.urgent === false, "60 days before end of support does not fail");
  assert(soon.runtimes.some((runtime) => runtime.role === "hosted-node" && runtime.status === "warn"), "that window is a warning");

  const actionsOld = buildReport(baseInput({ actionsNode: "18.20.8\n" }));
  assert(actionsOld.urgent === false, "a past-due Actions Node does not fail when the image is current");
  assert(renderReport(actionsOld).includes("GitHub Actions Node 18.20.8 passed end of support"), "the summary still names it");

  const kevOnly = buildReport(baseInput({
    kev: ["CVE-2021-44228"],
    repo: {
      Results: [
        repoResult(".github/workflows/eslint.yml", [
          vuln({ id: "GHSA-low-kev", pkg: "eslint", severity: "LOW", references: ["https://example.test/CVE-2021-44228"] }),
        ], { type: "npm" }),
      ],
    },
  }));
  assert(kevOnly.findings.length === 1 && kevOnly.findings[0].urgent && kevOnly.findings[0].where === "ci", "KEV is urgent in CI tooling");
  assert(kevOnly.urgent === true, "a KEV fails the run");

  const criticalImage = buildReport(baseInput({
    image: {
      Results: [
        repoResult("aidanos (debian 12)", [
          vuln({ id: "CVE-CRIT", pkg: "libssl3", severity: "CRITICAL", fixed: "9" }),
          vuln({ id: "CVE-HIGH", pkg: "git", severity: "HIGH" }),
        ], { class: "os-pkgs", type: "debian" }),
      ],
    },
  }));
  assert(criticalImage.findings.find((finding) => finding.id === "CVE-CRIT").urgent, "critical in the image is urgent");
  assert(!criticalImage.findings.find((finding) => finding.id === "CVE-HIGH").urgent, "high in the image stays in the summary");

  const devCritical = buildReport(baseInput({
    packageJson: { devDependencies: { eslint: "9.39.5" } },
    dockerfile: "FROM node:22-slim\nCOPY package.json ./\nCOPY server.mjs ./\n",
    repo: {
      Results: [
        repoResult("package.json", [
          vuln({ id: "CVE-ESLINT", pkg: "eslint", severity: "CRITICAL" }),
        ]),
      ],
    },
  }));
  assert(devCritical.urgent === false, "critical dev tooling is not urgent");
  assert(devCritical.findings[0].where === "dev", "eslint is dev only");

  const serverCritical = buildReport(baseInput({
    dockerfile: "FROM node:22-slim\nCOPY package.json ./\n",
    readFile: (rel) => {
      if (rel === "server.mjs") return "import { a } from \"./lib.mjs\";\n";
      if (rel === "lib.mjs") return "export const a = 1;\n";
      throw new Error("missing " + rel);
    },
    repo: {
      Results: [
        repoResult("lib.mjs", [vuln({ id: "CVE-SERVER", pkg: "lib", severity: "CRITICAL" })], { class: "secret", type: "file" }),
        repoResult("notes/tool.mjs", [vuln({ id: "CVE-NOTE", pkg: "tool", severity: "CRITICAL" })], { class: "secret", type: "file" }),
      ],
    },
  }));
  const serverFinding = serverCritical.findings.find((finding) => finding.id === "CVE-SERVER");
  const noteFinding = serverCritical.findings.find((finding) => finding.id === "CVE-NOTE");
  assert(serverFinding.urgent && serverFinding.where === "server", "critical server code is urgent");
  assert(!noteFinding.urgent && noteFinding.where === "not-shipped", "critical outside the image stays in the summary");

  const merged = buildReport(baseInput({
    image: {
      Results: [
        repoResult("aidanos (debian 12)", [
          vuln({ id: "CVE-BOTH", pkg: "leftpad", severity: "HIGH" }),
        ], { class: "os-pkgs", type: "debian" }),
      ],
    },
    repo: {
      Results: [
        repoResult("package.json", [
          vuln({ id: "CVE-BOTH", pkg: "leftpad", severity: "CRITICAL" }),
        ]),
      ],
    },
  }));
  assert(merged.findings.length === 1, "image and repo records of one flaw merge");
  assert(merged.findings[0].urgent && merged.findings[0].reachable && merged.findings[0].severity === "CRITICAL", "reachable wins when either side can be reached");

  const ranked = buildReport(baseInput({
    kev: ["CVE-2024-0001"],
    image: {
      Results: [
        repoResult("aidanos (debian 12)", [
          vuln({ id: "CVE-2024-0002", pkg: "openssl", severity: "CRITICAL" }),
          vuln({ id: "CVE-2024-0003", pkg: "zlib", severity: "MEDIUM" }),
        ], { class: "os-pkgs", type: "debian" }),
      ],
    },
    repo: {
      Results: [
        repoResult(".github/workflows/eslint.yml", [
          vuln({ id: "CVE-2024-0001", pkg: "gitleaks", severity: "LOW" }),
        ], { type: "file", class: "secret" }),
      ],
    },
  }));
  assert(
    ranked.findings.map((finding) => finding.id).join(",") === "CVE-2024-0001,CVE-2024-0002,CVE-2024-0003",
    "rank is KEV, then critical reachable, then the rest: " + ranked.findings.map((finding) => finding.id).join(","),
  );

  const marked = buildReport(baseInput({
    image: {
      Results: [{
        Target: "aidanos",
        Class: "os-pkgs",
        Type: "debian",
        Vulnerabilities: [vuln({ id: "CVE-MARK", pkg: "marked", severity: "LOW", cisa: { DateAdded: "2024-01-01" } })],
      }],
    },
  }));
  assert(marked.findings[0].kev && marked.urgent, "scanner KEV flag counts");

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "flaw-scan-"));
  const schedule = { v20: { end: "2026-04-30" }, v22: { end: "2027-04-30" } };
  const debian = [{ cycle: "12", codename: "Bookworm", eol: "2028-06-30" }];
  fs.writeFileSync(path.join(dir, "Dockerfile"), "FROM node:22-slim\nCOPY server.mjs ./\n");
  fs.writeFileSync(path.join(dir, "server.mjs"), "export const ok = 1;\n");
  fs.writeFileSync(path.join(dir, "package.json"), "{}\n");
  fs.writeFileSync(path.join(dir, "kev.json"), "{\"vulnerabilities\":[]}\n");
  fs.writeFileSync(path.join(dir, "schedule.json"), JSON.stringify(schedule));
  fs.writeFileSync(path.join(dir, "debian.json"), JSON.stringify(debian));
  fs.writeFileSync(path.join(dir, "os-release"), "ID=debian\nVERSION_ID=\"12\"\nVERSION_CODENAME=bookworm\n");
  fs.writeFileSync(path.join(dir, "empty.json"), "{\"Results\":[]}\n");
  const env = { ...process.env };
  delete env.GITHUB_STEP_SUMMARY;
  const script = fileURLToPath(import.meta.url);
  function cli(extra) {
    return spawnSync(process.execPath, [script, ...extra], { cwd: dir, env, encoding: "utf8" });
  }
  const common = [
    "--image", "empty.json",
    "--repo", "empty.json",
    "--kev", "kev.json",
    "--os-release", "os-release",
    "--node-schedule", "schedule.json",
    "--debian-eol", "debian.json",
    "--root", dir,
    "--today", "2026-10-23",
    "--scanner", "test",
  ];
  fs.writeFileSync(path.join(dir, "node20.txt"), "v20.19.0\n");
  const failed = cli([...common, "--node-version", "node20.txt"]);
  assert(failed.status === 1, "CLI exits 1 for a past end-of-support image: " + failed.stderr);
  assert(failed.stdout.includes("passed end of support on 2026-04-30"), "CLI summary names the date");

  fs.writeFileSync(path.join(dir, "node22.txt"), "v22.23.4\n");
  const clear = cli([...common, "--node-version", "node22.txt", "--actions-node", "node22.txt"]);
  assert(clear.status === 0, "CLI exits 0 when nothing is urgent: " + clear.stdout + clear.stderr);
  assert(clear.stdout.includes("Result: nothing urgent."), "clear summary");

  fs.writeFileSync(path.join(dir, "image.json"), JSON.stringify({
    Results: [repoResult("aidanos", [vuln({ id: "CVE-CRIT", pkg: "openssl", severity: "CRITICAL" })], { class: "os-pkgs", type: "debian" })],
  }));
  const crit = cli(["--image", "image.json", ...common.slice(2), "--node-version", "node22.txt"]);
  assert(crit.status === 1 && crit.stdout.includes("CVE-CRIT"), "CLI exits 1 for a critical image finding");

  fs.writeFileSync(path.join(dir, "bad.json"), "{");
  const broken = cli(["--kev", "bad.json", ...common.filter((item) => item !== "kev.json" && item !== "--kev"), "--node-version", "node22.txt"]);
  assert(broken.status === 2, "CLI exits 2 when a list cannot be read: " + broken.status + broken.stderr);

  console.log("flaw-scan self-test ok");
}

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  if (process.argv.includes("--self-test")) {
    try {
      selfTest();
    } catch (error) {
      console.error(error && error.stack ? error.stack : error);
      process.exit(1);
    }
  } else {
    try {
      run(process.argv.slice(2));
    } catch (error) {
      const message = "Flaw scan could not finish: " + (error && error.message ? error.message : error);
      console.error(message);
      writeStepSummary(message);
      process.exit(2);
    }
  }
}
