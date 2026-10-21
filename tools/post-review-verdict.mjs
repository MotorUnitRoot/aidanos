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
 * On PASS it posts the comment first, then sets success, so a failed
 * comment never turns the commit green. On BLOCK it sets failure first,
 * then posts the comment, so a failed status write posts no comment.
 * Calling it with BLOCK again sets failure and reposts the BLOCK comment.
 *
 * --check-run or REVIEW_CHECK_RUN=1 also creates a check run named
 * independent-review/approved. That mode is off by default.
 */
import { spawnSync } from "node:child_process";
import { STATUS_CONTEXT, verdictLine } from "../.github/independent-review.mjs";

export function scrubToken(text, token) {
  const source = String(text ?? "");
  if (!token) return source;
  return source.split(token).join("[redacted]");
}

export function checkRunEnabled(argv = [], env = {}) {
  if (argv.includes("--check-run")) return true;
  const flag = env.REVIEW_CHECK_RUN;
  return flag === "1" || flag === "true";
}

export async function postReviewVerdict({
  token,
  owner,
  repo,
  number,
  verdict,
  sha,
  request,
  checkRun = false,
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

  const state = verdict === "PASS" ? "success" : "failure";
  const postComment = () =>
    call(`/repos/${owner}/${repo}/issues/${prNumber}/comments`, {
      method: "POST",
      body: { body: line },
    });
  const postStatus = () =>
    call(`/repos/${owner}/${repo}/statuses/${encodeURIComponent(head)}`, {
      method: "POST",
      body: {
        state,
        context: STATUS_CONTEXT,
        description: line.slice(0, 140),
      },
    });
  const postCheckRun = () =>
    call(`/repos/${owner}/${repo}/check-runs`, {
      method: "POST",
      body: {
        name: STATUS_CONTEXT,
        head_sha: head,
        status: "completed",
        conclusion: state,
        completed_at: new Date().toISOString(),
      },
    });

  if (verdict === "BLOCK") {
    await postStatus();
    if (checkRun) await postCheckRun();
    await postComment();
  } else {
    await postComment();
    await postStatus();
    if (checkRun) await postCheckRun();
  }
  log(`Posted ${verdict} for PR #${prNumber} at ${head}.`);
  return { line, state, sha: head };
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

  return Promise.allSettled([pass, block, stale, leaked]).then(async (results) => {
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
    assert(blockApi.calls[1].pathname.includes("/statuses/"), "block sets status first");
    assert(blockApi.calls[1].body.state === "failure", "block status");
    assert(blockApi.calls[2].body.body === `Independent review: BLOCK ${sha}`, "block comment after status");
    assert(!passApi.calls.some((call) => call.pathname.endsWith("/check-runs")), "check run stays off");
    assert(!blockApi.calls.some((call) => call.pathname.endsWith("/check-runs")), "block check run stays off");

    assert(staleResult.status === "rejected", "stale head is refused");
    assert(staleApi.calls.length === 1, "stale head posts nothing");
    assert(!String(staleResult.reason && staleResult.reason.message).includes(token), "stale error hides the token");

    assert(leakedResult.status === "rejected", "request errors surface");
    assert(!String(leakedResult.reason.message).includes(token), "errors redact the token");
    assert(leakedResult.reason.message.includes("[redacted]"), "redaction marker");
    assert(logs.every((line) => !line.includes(token)), "logs hide the token");

    const passCommentFails = fake(sha);
    const savedRequest = passCommentFails.request;
    passCommentFails.request = async (pathname, options) => {
      if (pathname.includes("/comments")) throw new Error("comment failed");
      return savedRequest(pathname, options);
    };
    const passStopped = await postReviewVerdict({
      token,
      owner: "MotorUnitRoot",
      repo: "aidanos",
      number: 40,
      verdict: "PASS",
      sha,
      request: passCommentFails.request,
      log: (message) => logs.push(message),
    }).then(
      () => null,
      (error) => error,
    );
    assert(passStopped instanceof Error, "a failed PASS comment stops the script");
    assert(
      !passCommentFails.calls.some((call) => call.pathname.includes("/statuses/")),
      "a failed PASS comment does not set success",
    );

    const blockStatusFails = spawnSync(
      process.execPath,
      ["--input-type=module", "--eval", blockStatusFailsSource(token, sha)],
      { encoding: "utf8" },
    );
    assert(blockStatusFails.status === 1, "a failed BLOCK status exits non-zero");
    assert(
      !String(blockStatusFails.stdout || "").includes("comment-posted"),
      "a failed BLOCK status posts no comment",
    );

    const withCheck = fake(sha);
    const checked = await postReviewVerdict({
      token,
      owner: "MotorUnitRoot",
      repo: "aidanos",
      number: 40,
      verdict: "PASS",
      sha,
      checkRun: true,
      request: withCheck.request,
      log: () => {},
    });
    const checkCall = withCheck.calls.find((call) => call.pathname.endsWith("/check-runs"));
    assert(checked.state === "success", "check run follows a pass");
    assert(withCheck.calls[1].pathname.includes("/comments"), "pass still comments first");
    assert(withCheck.calls[2].pathname.includes("/statuses/"), "pass status before the check run");
    assert(checkCall && checkCall.body.name === STATUS_CONTEXT, "check run name");
    assert(checkCall.body.conclusion === "success" && checkCall.body.status === "completed", "check run conclusion");
    assert(checkCall.body.head_sha === sha, "check run sha");
    assert(checkRunEnabled(["--check-run"], {}), "flag enables the check run");
    assert(checkRunEnabled([], { REVIEW_CHECK_RUN: "1" }), "env enables the check run");
    assert(!checkRunEnabled([], {}), "check run defaults off");
    assert(!checkRunEnabled([], { REVIEW_CHECK_RUN: "0" }), "zero does not enable the check run");

    console.log("post-review-verdict self-test ok");
  });
}

function blockStatusFailsSource(token, sha) {
  const scriptUrl = new URL("./post-review-verdict.mjs", import.meta.url);
  return `
    import { postReviewVerdict } from ${JSON.stringify(scriptUrl.href)};
    const token = ${JSON.stringify(token)};
    const sha = ${JSON.stringify(sha)};
    const state = { status: "success", comments: 0 };
    try {
      await postReviewVerdict({
        token,
        owner: "MotorUnitRoot",
        repo: "aidanos",
        number: 40,
        verdict: "BLOCK",
        sha,
        request: async (pathname, options) => {
          if (options.method === "GET") return { head: { sha } };
          if (pathname.includes("/statuses/")) throw new Error("status write failed");
          if (pathname.includes("/comments")) {
            state.comments += 1;
            console.log("comment-posted");
            return {};
          }
          throw new Error("unexpected " + pathname);
        },
        log: () => {},
      });
      process.exit(state.status === "success" ? 0 : 4);
    } catch (error) {
      if (state.comments !== 0) process.exit(2);
      if (state.status !== "success") process.exit(3);
      process.exit(1);
    }
  `;
}

async function main() {
  if (process.argv.includes("--self-test")) {
    await selfTest();
    return;
  }
  if (process.env.GITHUB_ACTIONS === "true") {
    throw new Error("post-review-verdict.mjs does not run in GitHub Actions");
  }
  const [number, verdict, sha] = process.argv.slice(2).filter((arg) => arg !== "--check-run");
  const [owner, repo] = String(process.env.GITHUB_REPOSITORY || "").split("/");
  const apiBase = process.env.GITHUB_API_URL || "https://api.github.com";
  await postReviewVerdict({
    token: process.env.GITHUB_TOKEN,
    owner,
    repo,
    number,
    verdict,
    sha,
    checkRun: checkRunEnabled(process.argv, process.env),
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
