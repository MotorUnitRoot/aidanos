#!/usr/bin/env node
/**
 * Post an independent-review verdict as the motorunit-aidanos-bots App.
 *
 * Run this where the App key lives, after minting an installation token.
 * The token arrives in GITHUB_TOKEN. This file never reads the App key
 * and never prints the token. Do not run it from GitHub Actions.
 *
 *   GITHUB_TOKEN=... GITHUB_REPOSITORY=owner/repo \
 *     node tools/post-review-verdict.mjs <pr> PASS <head-sha>
 *
 * The script refuses if the pull request's current head is not that SHA.
 * It posts a comment whose first line is the verdict, then sets the
 * commit status independent-review/approved on that SHA. Calling it with
 * BLOCK again reposts the BLOCK comment and sets the failure status.
 */
import { STATUS_CONTEXT, verdictLine } from "../.github/independent-review.mjs";

export function scrubToken(text, token) {
  const source = String(text ?? "");
  if (!token) return source;
  return source.split(token).join("[redacted]");
}

export async function postReviewVerdict({
  token,
  owner,
  repo,
  number,
  verdict,
  sha,
  request,
  log = () => {},
}) {
  if (!token) throw new Error("GITHUB_TOKEN is required");
  if (!owner || !repo) throw new Error("GITHUB_REPOSITORY is required");
  const prNumber = Number(number);
  if (!Number.isInteger(prNumber) || prNumber <= 0) throw new Error("pull request number is required");
  const line = verdictLine(verdict, sha);
  const normalized = line.split(" ").pop();

  const call = async (pathname, options = {}) => {
    try {
      return await request(pathname, { method: options.method || "GET", body: options.body, token });
    } catch (error) {
      throw new Error(scrubToken(error && error.message ? error.message : error, token));
    }
  };

  const pr = await call(`/repos/${owner}/${repo}/pulls/${prNumber}`);
  const head = pr && pr.head && pr.head.sha;
  if (!head || String(head).toLowerCase() !== normalized) {
    throw new Error(`PR #${prNumber} head is ${head || "missing"}, not ${normalized}`);
  }

  await call(`/repos/${owner}/${repo}/issues/${prNumber}/comments`, {
    method: "POST",
    body: { body: line },
  });
  await call(`/repos/${owner}/${repo}/statuses/${encodeURIComponent(head)}`, {
    method: "POST",
    body: {
      state: verdict === "PASS" ? "success" : "failure",
      context: STATUS_CONTEXT,
      description: line.slice(0, 140),
    },
  });
  log(`Posted ${verdict} for PR #${prNumber} at ${head}.`);
  return { line, state: verdict === "PASS" ? "success" : "failure", sha: head };
}

export async function githubRequest({ apiBase, token, pathname, method, body }) {
  const response = await fetch(apiBase + pathname, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "aidanos-post-review-verdict",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${method} ${pathname} -> ${response.status} ${scrubToken(text, token).slice(0, 300)}`);
  }
  if (!text) return null;
  return JSON.parse(text);
}

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

export function selfTest() {
  const sha = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const token = "ghs_test_token_value_not_real";
  const logs = [];

  function fake(head) {
    const calls = [];
    const request = async (pathname, options) => {
      calls.push({ pathname, method: options.method, body: options.body });
      if (String(options.token) !== token) throw new Error("missing token");
      if (options.method === "GET") return { head: { sha: head } };
      return { ok: true };
    };
    return { calls, request };
  }

  const passApi = fake(sha);
  const pass = postReviewVerdict({
    token,
    owner: "MotorUnitRoot",
    repo: "aidanos",
    number: "40",
    verdict: "PASS",
    sha: sha.toUpperCase(),
    request: passApi.request,
    log: (message) => logs.push(message),
  });

  const blockApi = fake(sha);
  const block = postReviewVerdict({
    token,
    owner: "MotorUnitRoot",
    repo: "aidanos",
    number: 40,
    verdict: "BLOCK",
    sha,
    request: blockApi.request,
    log: (message) => logs.push(message),
  });

  const staleApi = fake(`b${"c".repeat(39)}`);
  const stale = postReviewVerdict({
    token,
    owner: "MotorUnitRoot",
    repo: "aidanos",
    number: 40,
    verdict: "PASS",
    sha,
    request: staleApi.request,
    log: (message) => logs.push(message),
  });

  const leakApi = {
    request: async () => {
      throw new Error(`API said ${token}`);
    },
  };
  const leaked = postReviewVerdict({
    token,
    owner: "MotorUnitRoot",
    repo: "aidanos",
    number: 40,
    verdict: "BLOCK",
    sha,
    request: leakApi.request,
    log: (message) => logs.push(message),
  });

  return Promise.allSettled([pass, block, stale, leaked]).then((results) => {
    const [passResult, blockResult, staleResult, leakedResult] = results;
    assert(passResult.status === "fulfilled", "pass posts");
    assert(passResult.value.line === `Independent review: PASS ${sha}`, "pass first line");
    assert(passResult.value.state === "success", "pass status");
    assert(passApi.calls.length === 3, "pass calls head, comment, status");
    assert(passApi.calls[1].body.body === `Independent review: PASS ${sha}`, "comment body");
    assert(passApi.calls[2].body.state === "success", "success state");
    assert(passApi.calls[2].body.context === "independent-review/approved", "status context");

    assert(blockResult.status === "fulfilled", "block posts");
    assert(blockResult.value.line === `Independent review: BLOCK ${sha}`, "block first line");
    assert(blockApi.calls[1].body.body === `Independent review: BLOCK ${sha}`, "block comment");
    assert(blockApi.calls[2].body.state === "failure", "block status");

    assert(staleResult.status === "rejected", "stale head is refused");
    assert(staleApi.calls.length === 1, "stale head posts nothing");
    assert(!String(staleResult.reason && staleResult.reason.message).includes(token), "stale error hides the token");

    assert(leakedResult.status === "rejected", "request errors surface");
    assert(!String(leakedResult.reason.message).includes(token), "errors redact the token");
    assert(leakedResult.reason.message.includes("[redacted]"), "redaction marker");
    assert(logs.every((line) => !line.includes(token)), "logs hide the token");
    console.log("post-review-verdict self-test ok");
  });
}

async function main() {
  if (process.argv.includes("--self-test")) {
    await selfTest();
    return;
  }
  if (process.env.GITHUB_ACTIONS === "true") {
    throw new Error("post-review-verdict.mjs does not run in GitHub Actions");
  }
  const [number, verdict, sha] = process.argv.slice(2);
  const [owner, repo] = String(process.env.GITHUB_REPOSITORY || "").split("/");
  const apiBase = process.env.GITHUB_API_URL || "https://api.github.com";
  await postReviewVerdict({
    token: process.env.GITHUB_TOKEN,
    owner,
    repo,
    number,
    verdict,
    sha,
    request: (pathname, options) => githubRequest({ apiBase, pathname, ...options }),
    log: (message) => console.log(message),
  });
}

const isDirectRun = process.argv[1] && process.argv[1].endsWith("post-review-verdict.mjs");
if (isDirectRun) {
  main().catch((error) => {
    const token = process.env.GITHUB_TOKEN;
    const message = scrubToken(error && error.message ? error.message : error, token);
    console.error(message);
    process.exit(1);
  });
}
