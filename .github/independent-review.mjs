#!/usr/bin/env node
/**
 * Independent review gate.
 *
 * Passes only when a PR comment begins with "Independent review: PASS"
 * followed by the PR's current head SHA. Fails on "Independent review: BLOCK"
 * for this head (or a BLOCK that names no SHA), and when no comment names
 * the current head SHA.
 *
 * GitHub accounts cannot separate the bots today, so this does not check
 * who wrote the comment. That remains a process rule.
 */
import fs from "node:fs";

const PASS_PREFIX = "Independent review: PASS";
const BLOCK_PREFIX = "Independent review: BLOCK";

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
    "This check confirms a review comment for that SHA. It cannot prove the commenter is a different author, because every bot posts under the same GitHub account today.",
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
    `No comment begins with \`${PASS_PREFIX} ${headSha}\`.`,
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
  assert(text.includes(sha) && text.includes("same GitHub account"), "summary");
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
    throw new Error(`${method} ${pathname} -> ${response.status} ${text.slice(0, 500)}`);
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

async function rerunPullRequestWorkflow(owner, repo, headSha) {
  const listed = await gh(
    `/repos/${owner}/${repo}/actions/workflows/independent-review.yml/runs?head_sha=${headSha}&event=pull_request&per_page=5`,
  );
  const latest = listed && listed.workflow_runs && listed.workflow_runs[0];
  if (!latest) {
    console.log("No pull_request run to re-run.");
    return;
  }
  if (["queued", "in_progress", "waiting", "pending", "requested"].includes(latest.status)) {
    console.log(`Run ${latest.id} is ${latest.status}; not re-running.`);
    return;
  }
  await gh(`/repos/${owner}/${repo}/actions/runs/${latest.id}/rerun`, { method: "POST" });
  console.log(`Re-ran workflow run ${latest.id} for ${headSha}.`);
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

  const comments = await listComments(owner, repo, number);
  const result = classifyReview(comments, headSha);
  const summary = summaryFor(result, headSha);
  console.log(summary);
  writeStepSummary(summary);

  if (eventName === "issue_comment") {
    // This run is attached to the default branch. Publish the real result
    // on the PR head, then re-run the pull_request job so that check updates.
    await publishCheck(owner, repo, headSha, result.conclusion, summary);
    try {
      await rerunPullRequestWorkflow(owner, repo, headSha);
    } catch (error) {
      console.log(`Could not re-run the pull_request check: ${error.message}`);
    }
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
