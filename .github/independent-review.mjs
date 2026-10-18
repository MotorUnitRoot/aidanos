#!/usr/bin/env node
/**
 * Independent review gate.
 *
 * A comment counts only when all of these are true:
 * - It begins with "Independent review: PASS" or "Independent review: BLOCK".
 * - PASS is followed by the pull request's current head SHA.
 * - The comment has not been edited.
 * - The author has write, maintain, or admin on this repo, from
 *   GET /repos/{owner}/{repo}/collaborators/{username}/permission.
 *
 * The pull_request job only reads. The issue_comment job, whose workflow
 * file comes from the default branch, publishes the check and commit status
 * on the PR head.
 */
import fs from "node:fs";

const PASS_PREFIX = "Independent review: PASS";
const BLOCK_PREFIX = "Independent review: BLOCK";
const REVIEW_ROLES = new Set(["admin", "maintain", "write"]);

export function commentKind(body, headSha) {
  const text = String(body || "")
    .replace(/^\uFEFF/, "")
    .replace(/\r\n/g, "\n")
    .trimStart();
  const sha = String(headSha || "").toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(sha)) return null;

  if (/^Independent review: BLOCK(?:\s|$)/.test(text)) {
    const named = text.match(/\b[0-9a-f]{40}\b/gi) || [];
    if (named.length === 0) return "block";
    if (named.some((item) => item.toLowerCase() === sha)) return "block";
    return null;
  }

  const pass = text.match(/^Independent review: PASS\s+([0-9a-fA-F]{40})\b/);
  if (pass && pass[1].toLowerCase() === sha) return "pass";
  return null;
}

export function hasReviewAccess(record) {
  if (!record || typeof record !== "object") return false;
  return REVIEW_ROLES.has(record.permission) || REVIEW_ROLES.has(record.role_name);
}

export function commentWasEdited(comment) {
  if (!comment || !comment.created_at || !comment.updated_at) return false;
  return comment.created_at !== comment.updated_at;
}

export function classifyReview(comments, headSha) {
  const pass = [];
  const block = [];
  for (const comment of comments || []) {
    const kind = commentKind(comment && comment.body, headSha);
    if (kind === "pass") pass.push(comment);
    else if (kind === "block") block.push(comment);
  }
  if (block.length) {
    return { conclusion: "failure", reason: "block", pass, block };
  }
  if (pass.length) {
    return { conclusion: "success", reason: "pass", pass, block };
  }
  return { conclusion: "failure", reason: "missing", pass, block };
}

export function summaryFor(result, headSha) {
  const lines = [
    `Head SHA: \`${headSha}\`.`,
    "",
    "Only an unedited comment from an author with write, maintain, or admin access counts.",
  ];
  if (result.reason === "pass") {
    const ids = result.pass.map((comment) => comment.id).filter(Boolean).join(", ");
    lines.splice(1, 0, `PASS comment${result.pass.length === 1 ? "" : "s"}: ${ids || "(no id)"}.`);
    return lines.join("\n");
  }
  if (result.reason === "block") {
    const ids = result.block.map((comment) => comment.id).filter(Boolean).join(", ");
    lines.splice(1, 0, `BLOCK comment${result.block.length === 1 ? "" : "s"}: ${ids || "(no id)"}. A BLOCK for this SHA fails the check even if a PASS is also present. A BLOCK that names no SHA applies to the current head.`);
    return lines.join("\n");
  }
  lines.splice(
    1,
    0,
    `No unedited comment from a write, maintain, or admin author begins with \`${PASS_PREFIX} ${headSha}\`.`,
  );
  return lines.join("\n");
}

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

export function selfTest() {
  const sha = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const other = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  const cases = [
    ["exact pass", `Independent review: PASS ${sha}`, sha, "pass"],
    ["leading space and note", `  Independent review: PASS ${sha}\nlooks good`, sha, "pass"],
    ["sha on next line", `Independent review: PASS\n${sha}`, sha, "pass"],
    ["uppercase hex", `Independent review: PASS ${sha.toUpperCase()}`, sha, "pass"],
    ["other sha", `Independent review: PASS ${other}`, sha, null],
    ["not at the start", `Note: Independent review: PASS ${sha}`, sha, null],
    ["missing space", `Independent review: PASS${sha}`, sha, null],
    ["bare block", "Independent review: BLOCK", sha, "block"],
    ["block this sha", `Independent review: BLOCK ${sha}`, sha, "block"],
    ["block other sha", `Independent review: BLOCK ${other}`, sha, null],
    ["block then prose", "Independent review: BLOCK\nstill wrong", sha, "block"],
    ["blocked is not block", "Independent review: BLOCKED", sha, null],
  ];
  for (const [name, body, head, want] of cases) {
    const got = commentKind(body, head);
    assert(got === want, `${name}: got ${got}, want ${want}`);
  }

  assert(hasReviewAccess({ permission: "admin", role_name: "admin" }), "admin");
  assert(hasReviewAccess({ permission: "write", role_name: "write" }), "write");
  assert(hasReviewAccess({ permission: "write", role_name: "maintain" }), "maintain maps to write");
  assert(hasReviewAccess({ permission: "maintain", role_name: "maintain" }), "maintain");
  assert(!hasReviewAccess({ permission: "read", role_name: "read" }), "read");
  assert(!hasReviewAccess({ permission: "read", role_name: "triage" }), "triage");
  assert(!hasReviewAccess({ permission: "none", role_name: "" }), "none");
  assert(!hasReviewAccess(null), "missing record");

  const stamp = "2026-10-18T00:00:00Z";
  assert(!commentWasEdited({ created_at: stamp, updated_at: stamp }), "unedited");
  assert(!commentWasEdited({ body: "no timestamps" }), "timestamps absent");
  assert(commentWasEdited({ created_at: stamp, updated_at: "2026-10-18T00:00:01Z" }), "edited");

  const pass = classifyReview([{ id: 1, body: `${PASS_PREFIX} ${sha}` }], sha);
  assert(pass.conclusion === "success" && pass.reason === "pass", "pass class");

  const missing = classifyReview([{ id: 2, body: `see ${sha}` }], sha);
  assert(missing.conclusion === "failure" && missing.reason === "missing", "sha mention is not a review");

  const blocked = classifyReview(
    [
      { id: 3, body: `${PASS_PREFIX} ${sha}` },
      { id: 4, body: `${BLOCK_PREFIX} ${sha}` },
    ],
    sha,
  );
  assert(blocked.conclusion === "failure" && blocked.reason === "block", "block wins");

  const staleBlock = classifyReview(
    [
      { id: 5, body: `${BLOCK_PREFIX} ${other}` },
      { id: 6, body: `${PASS_PREFIX} ${sha}` },
    ],
    sha,
  );
  assert(staleBlock.conclusion === "success", "block for another sha does not fail this head");

  const bare = classifyReview(
    [
      { id: 7, body: BLOCK_PREFIX },
      { id: 8, body: `${PASS_PREFIX} ${sha}` },
    ],
    sha,
  );
  assert(bare.conclusion === "failure" && bare.reason === "block", "bare block still fails");

  const text = summaryFor(pass, sha);
  assert(text.includes(sha) && text.includes("write, maintain, or admin"), "summary");
  console.log("independent-review self-test ok");
}

function apiBase() {
  return process.env.GITHUB_API_URL || "https://api.github.com";
}

async function gh(pathname, { method = "GET", body } = {}) {
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error("GITHUB_TOKEN is required");
  const response = await fetch(apiBase() + pathname, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "aidanos-independent-review",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  if (!response.ok) {
    const error = new Error(`${method} ${pathname} -> ${response.status} ${text.slice(0, 300)}`);
    error.status = response.status;
    throw error;
  }
  if (!text) return null;
  return JSON.parse(text);
}

async function listComments(owner, repo, number) {
  const comments = [];
  for (let page = 1; page <= 20; page += 1) {
    const batch = await gh(
      `/repos/${owner}/${repo}/issues/${number}/comments?per_page=100&page=${page}`,
    );
    comments.push(...batch);
    if (batch.length < 100) break;
  }
  return comments;
}

async function permissionFor(owner, repo, login, cache) {
  if (cache.has(login)) return cache.get(login);
  let record = null;
  try {
    record = await gh(
      `/repos/${owner}/${repo}/collaborators/${encodeURIComponent(login)}/permission`,
    );
  } catch (error) {
    console.log(`Permission lookup failed for ${login}: ${error.message}`);
    record = null;
  }
  cache.set(login, record);
  return record;
}

async function commentsFromReviewers(owner, repo, comments) {
  const cache = new Map();
  const accepted = [];
  for (const comment of comments) {
    const login = comment && comment.user && comment.user.login;
    if (commentWasEdited(comment)) {
      console.log(`Ignoring edited comment ${comment.id || "?"} from ${login || "unknown"}.`);
      continue;
    }
    if (!login) {
      console.log(`Ignoring comment ${comment && comment.id} with no author.`);
      continue;
    }
    const record = await permissionFor(owner, repo, login, cache);
    const role = record && (record.role_name || record.permission);
    if (!hasReviewAccess(record)) {
      console.log(`Ignoring comment ${comment.id} from ${login} (${role || "no access"}).`);
      continue;
    }
    accepted.push(comment);
  }
  return accepted;
}

async function publishCheck(owner, repo, headSha, conclusion, summary) {
  const server = process.env.GITHUB_SERVER_URL || "https://github.com";
  const runId = process.env.GITHUB_RUN_ID;
  const repository = process.env.GITHUB_REPOSITORY;
  await gh(`/repos/${owner}/${repo}/check-runs`, {
    method: "POST",
    body: {
      name: "independent-review",
      head_sha: headSha,
      status: "completed",
      conclusion,
      completed_at: new Date().toISOString(),
      details_url: runId && repository ? `${server}/${repository}/actions/runs/${runId}` : undefined,
      output: {
        title: conclusion === "success" ? "Independent review passed" : "Independent review failed",
        summary,
      },
    },
  });
}

async function publishStatus(owner, repo, headSha, conclusion, summary) {
  const server = process.env.GITHUB_SERVER_URL || "https://github.com";
  const runId = process.env.GITHUB_RUN_ID;
  const repository = process.env.GITHUB_REPOSITORY;
  const description = summary.split("\n").find((line) => line.trim()) || "Independent review";
  await gh(`/repos/${owner}/${repo}/statuses/${headSha}`, {
    method: "POST",
    body: {
      state: conclusion === "success" ? "success" : "failure",
      context: "independent-review",
      description: description.slice(0, 140),
      target_url: runId && repository ? `${server}/${repository}/actions/runs/${runId}` : undefined,
    },
  });
}

function writeStepSummary(summary) {
  const path = process.env.GITHUB_STEP_SUMMARY;
  if (!path) return;
  fs.appendFileSync(path, summary + "\n");
}

async function main() {
  if (process.argv.includes("--self-test")) {
    selfTest();
    return;
  }

  const eventName = process.env.GITHUB_EVENT_NAME || "";
  const event = JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"));
  const [owner, repo] = String(process.env.GITHUB_REPOSITORY || "").split("/");
  if (!owner || !repo) throw new Error("GITHUB_REPOSITORY is required");

  if (eventName === "issue_comment" && event.action === "edited") {
    console.log("Ignoring an edited comment.");
    return;
  }

  if (eventName === "issue_comment" && !(event.issue && event.issue.pull_request)) {
    console.log("Not a pull request comment. Skipping.");
    return;
  }

  let number;
  let headSha;
  let baseRef;
  if (eventName === "pull_request") {
    number = event.pull_request.number;
    headSha = event.pull_request.head.sha;
    baseRef = event.pull_request.base.ref;
  } else if (eventName === "issue_comment") {
    number = event.issue.number;
    const pr = await gh(`/repos/${owner}/${repo}/pulls/${number}`);
    headSha = pr.head.sha;
    baseRef = pr.base.ref;
  } else {
    console.log(`Event ${eventName} does not carry a pull request. Skipping.`);
    return;
  }

  if (baseRef !== "main") {
    console.log(`PR #${number} targets ${baseRef}, not main. Skipping.`);
    return;
  }

  const comments = await commentsFromReviewers(owner, repo, await listComments(owner, repo, number));
  const result = classifyReview(comments, headSha);
  const summary = summaryFor(result, headSha);
  console.log(summary);
  writeStepSummary(summary);

  if (eventName === "issue_comment") {
    // This run uses the workflow on the default branch. Publish onto the PR
    // head. Do not fail the default-branch commit when the review is missing.
    await publishCheck(owner, repo, headSha, result.conclusion, summary);
    await publishStatus(owner, repo, headSha, result.conclusion, summary);
    return;
  }

  if (result.conclusion !== "success") process.exitCode = 1;
}

const isDirectRun = process.argv[1] && process.argv[1].endsWith("independent-review.mjs");
if (isDirectRun) {
  main().catch((error) => {
    console.error(error && error.stack ? error.stack : error);
    process.exit(1);
  });
}
