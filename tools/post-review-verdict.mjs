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
 * comment never turns the commit green. On BLOCK it writes the failure
 * signals first, then posts the comment. A failed BLOCK posts no comment,
 * so an earlier PASS stays green until the BLOCK is retried.
 *
 * REVIEW_MODE is "status" or "check-run". Changing it is a code change.
 */
import { spawnSync } from "node:child_process";
import { REVIEW_APP_ID, STATUS_CONTEXT, verdictLine } from "../.github/independent-review.mjs";

// "status" posts the commit status. "check-run" posts the check run.
// A BLOCK in either mode also fails the other signal when one is already
// on the commit. Change this constant to switch; there is no runtime flag.
export const REVIEW_MODE = "status";

export const BLOCK_STATUS_FAILED_MESSAGE =
  "Could not set independent-review/approved to failure. BLOCK was not posted, and an earlier PASS stays green until this BLOCK is retried.";

export const BLOCK_CHECK_PERMISSION_MESSAGE =
  "Cannot write a failing independent-review/approved check run. The App does not have permission to write checks. BLOCK was not posted, and an earlier PASS stays green until this BLOCK is retried.";

const BLOCK_CHECK_LIST_MESSAGE =
  "Cannot list check runs named independent-review/approved, so a BLOCK cannot see an earlier check run. BLOCK was not posted, and an earlier PASS stays green until this BLOCK is retried.";

export function scrubToken(text, token) {
  const source = String(text ?? "");
  if (!token) return source;
  return source.split(token).join("[redacted]");
}

function selectedMode(mode) {
  const value = mode || REVIEW_MODE;
  if (value !== "status" && value !== "check-run") {
    throw new Error("REVIEW_MODE must be status or check-run");
  }
  return value;
}

function isPermissionError(error) {
  const message = String(error && error.message ? error.message : error);
  return /\b403\b/.test(message) || /Resource not accessible by integration/i.test(message);
}

function isOurCheckRun(run) {
  if (!run || run.name !== STATUS_CONTEXT) return false;
  const app = run.app;
  if (!app) return true;
  if (Number(app.id) === REVIEW_APP_ID) return true;
  return app.slug === "motorunit-aidanos-bots";
}

export function blockFailureKeptPass({ exitCode, message, comments, statuses }) {
  const onlyEarlierPass =
    Array.isArray(statuses) &&
    statuses.length === 1 &&
    statuses[0].state === "success" &&
    statuses[0].context === STATUS_CONTEXT &&
    statuses[0].source === "earlier-pass";
  return (
    exitCode === 1 &&
    message === `${BLOCK_STATUS_FAILED_MESSAGE} (status write failed)` &&
    comments === 0 &&
    onlyEarlierPass
  );
}

export async function postReviewVerdict({
  token,
  owner,
  repo,
  number,
  verdict,
  sha,
  request,
  mode,
  log = () => {},
}) {
  if (!token) throw new Error("GITHUB_TOKEN is required");
  if (!owner || !repo) throw new Error("GITHUB_REPOSITORY is required");
  const prNumber = Number(number);
  if (!Number.isInteger(prNumber) || prNumber <= 0) throw new Error("pull request number is required");
  const reviewMode = selectedMode(mode);
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

  const failExistingCheckRuns = async () => {
    let listed;
    try {
      listed = await call(
        `/repos/${owner}/${repo}/commits/${encodeURIComponent(head)}/check-runs?per_page=100`,
      );
    } catch (error) {
      if (isPermissionError(error)) throw new Error(BLOCK_CHECK_LIST_MESSAGE);
      throw new Error(
        `Could not list check runs named ${STATUS_CONTEXT}. BLOCK was not posted. (${scrubToken(error.message, token)})`,
      );
    }
    const runs = (listed && listed.check_runs) || [];
    if (!runs.some(isOurCheckRun)) return;
    try {
      await postCheckRun();
    } catch (error) {
      if (isPermissionError(error)) throw new Error(BLOCK_CHECK_PERMISSION_MESSAGE);
      throw new Error(
        `Could not write the failing check run. BLOCK was not posted. (${scrubToken(error.message, token)})`,
      );
    }
  };

  const failStatus = async () => {
    try {
      await postStatus();
    } catch (error) {
      throw new Error(`${BLOCK_STATUS_FAILED_MESSAGE} (${scrubToken(error.message, token)})`);
    }
  };

  if (verdict === "BLOCK" && reviewMode === "status") {
    await failExistingCheckRuns();
    await failStatus();
    await postComment();
  } else if (verdict === "BLOCK") {
    try {
      await postCheckRun();
    } catch (error) {
      if (isPermissionError(error)) throw new Error(BLOCK_CHECK_PERMISSION_MESSAGE);
      throw new Error(
        `Could not write the failing check run. BLOCK was not posted. (${scrubToken(error.message, token)})`,
      );
    }
    await failStatus();
    await postComment();
  } else if (reviewMode === "status") {
    await postComment();
    await postStatus();
  } else {
    await postComment();
    await postCheckRun();
  }
  log(`Posted ${verdict} for PR #${prNumber} at ${head}.`);
  return { line, state, sha: head, mode: reviewMode };
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

    assert(REVIEW_MODE === "status", "the default mode is status");
    assert(blockResult.status === "fulfilled", "block posts");
    assert(blockResult.value.line === `Independent review: BLOCK ${sha}`, "block first line");
    assert(blockApi.calls[1].pathname.includes("/check-runs"), "block looks for an earlier check run");
    assert(blockApi.calls[2].pathname.includes("/statuses/"), "block sets status before the comment");
    assert(blockApi.calls[2].body.state === "failure", "block status");
    assert(blockApi.calls[3].body.body === `Independent review: BLOCK ${sha}`, "block comment after the failure writes");
    assert(
      !blockApi.calls.some((call) => call.method === "POST" && call.pathname.endsWith("/check-runs")),
      "status mode does not create a check run when none exists",
    );

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
    const blockReport = JSON.parse(blockStatusFails.stdout || "{}");
    assert(
      blockFailureKeptPass({ exitCode: blockStatusFails.status, ...blockReport }),
      `failed BLOCK after a green PASS: exit ${blockStatusFails.status} ${blockStatusFails.stdout} ${blockStatusFails.stderr}`,
    );
    assert(
      !blockFailureKeptPass({
        exitCode: 1,
        message: `${BLOCK_STATUS_FAILED_MESSAGE} (status write failed)`,
        comments: 1,
        statuses: [{ state: "success", context: STATUS_CONTEXT, source: "earlier-pass" }],
      }),
      "reversed order fails this test",
    );

    const priorCheck = memoryApi(sha, token, {
      checkRuns: [{ name: STATUS_CONTEXT, conclusion: "success", app: { id: REVIEW_APP_ID, slug: "motorunit-aidanos-bots" } }],
    });
    await postReviewVerdict({
      token,
      owner: "MotorUnitRoot",
      repo: "aidanos",
      number: 40,
      verdict: "BLOCK",
      sha,
      mode: "status",
      request: priorCheck.request,
      log: () => {},
    });
    const priorPosts = priorCheck.posts();
    assert(priorPosts[0].kind === "check-run" && priorPosts[0].conclusion === "failure", "status mode fails an earlier check run");
    assert(priorPosts[1].kind === "status" && priorPosts[1].state === "failure", "status mode then fails the status");
    assert(priorPosts[2].kind === "comment", "status mode comments only after both failure writes");

    const denied = memoryApi(sha, token, {
      statuses: [{ state: "success", context: STATUS_CONTEXT, source: "earlier-pass" }],
      checkRuns: [{ name: STATUS_CONTEXT, conclusion: "success", app: { id: REVIEW_APP_ID } }],
      denyCheckWrite: true,
    });
    const deniedError = await postReviewVerdict({
      token,
      owner: "MotorUnitRoot",
      repo: "aidanos",
      number: 40,
      verdict: "BLOCK",
      sha,
      mode: "status",
      request: denied.request,
      log: () => {},
    }).then(
      () => null,
      (error) => error,
    );
    assert(deniedError instanceof Error && deniedError.message === BLOCK_CHECK_PERMISSION_MESSAGE, "missing check permission is explicit");
    assert(denied.comments.length === 0, "missing check permission posts no comment");
    assert(denied.statuses.length === 1 && denied.statuses[0].state === "success", "missing check permission leaves the PASS");

    const checkModeBlock = memoryApi(sha, token);
    await postReviewVerdict({
      token,
      owner: "MotorUnitRoot",
      repo: "aidanos",
      number: 40,
      verdict: "BLOCK",
      sha,
      mode: "check-run",
      request: checkModeBlock.request,
      log: () => {},
    });
    const checkPosts = checkModeBlock.posts();
    assert(checkPosts[0].kind === "check-run" && checkPosts[0].conclusion === "failure", "check-run mode fails the check run first");
    assert(checkPosts[1].kind === "status" && checkPosts[1].state === "failure", "check-run mode also fails the status");
    assert(checkPosts[2].kind === "comment", "check-run mode comments after the failure writes");

    const checkModePass = memoryApi(sha, token);
    await postReviewVerdict({
      token,
      owner: "MotorUnitRoot",
      repo: "aidanos",
      number: 40,
      verdict: "PASS",
      sha,
      mode: "check-run",
      request: checkModePass.request,
      log: () => {},
    });
    const passPosts = checkModePass.posts();
    assert(passPosts[0].kind === "comment", "check-run mode still comments before success");
    assert(passPosts[1].kind === "check-run" && passPosts[1].conclusion === "success", "check-run mode then posts success");
    assert(!passPosts.some((post) => post.kind === "status"), "a check-run PASS does not set a status");

    console.log("post-review-verdict self-test ok");
  });
}

function memoryApi(head, token, { statuses = [], checkRuns = [], denyCheckWrite = false } = {}) {
  const state = { statuses: statuses.map((item) => ({ ...item })), checkRuns: checkRuns.map((item) => ({ ...item })), comments: [], posts: [] };
  const request = async (pathname, options) => {
    if (String(options.token) !== token) throw new Error("missing token");
    if (options.method === "GET" && pathname.includes("/pulls/")) return { head: { sha: head } };
    if (options.method === "GET" && pathname.includes("/check-runs")) return { check_runs: state.checkRuns };
    if (options.method === "POST" && pathname.endsWith("/check-runs")) {
      if (denyCheckWrite) throw new Error("403 Resource not accessible by integration");
      const run = { name: options.body.name, conclusion: options.body.conclusion, app: { id: REVIEW_APP_ID, slug: "motorunit-aidanos-bots" } };
      state.checkRuns.push(run);
      state.posts.push({ kind: "check-run", conclusion: options.body.conclusion });
      return run;
    }
    if (options.method === "POST" && pathname.includes("/statuses/")) {
      state.statuses.push({ state: options.body.state, context: options.body.context, source: "write" });
      state.posts.push({ kind: "status", state: options.body.state });
      return {};
    }
    if (options.method === "POST" && pathname.includes("/comments")) {
      state.comments.push(options.body.body);
      state.posts.push({ kind: "comment" });
      return {};
    }
    throw new Error(`unexpected ${options.method} ${pathname}`);
  };
  return {
    request,
    posts: () => state.posts,
    get comments() {
      return state.comments;
    },
    get statuses() {
      return state.statuses;
    },
  };
}

function blockStatusFailsSource(token, sha) {
  const scriptUrl = new URL("./post-review-verdict.mjs", import.meta.url);
  return `
    import { STATUS_CONTEXT } from ${JSON.stringify(new URL("../.github/independent-review.mjs", scriptUrl).href)};
    import { postReviewVerdict } from ${JSON.stringify(scriptUrl.href)};
    const token = ${JSON.stringify(token)};
    const sha = ${JSON.stringify(sha)};
    const record = {
      comments: [],
      statuses: [{ state: "success", context: STATUS_CONTEXT, source: "earlier-pass" }],
    };
    try {
      await postReviewVerdict({
        token,
        owner: "MotorUnitRoot",
        repo: "aidanos",
        number: 40,
        verdict: "BLOCK",
        sha,
        request: async (pathname, options) => {
          if (options.method === "GET" && pathname.includes("/pulls/")) return { head: { sha } };
          if (options.method === "GET" && pathname.includes("/check-runs")) return { check_runs: [] };
          if (options.method === "POST" && pathname.includes("/statuses/")) {
            throw new Error("status write failed");
          }
          if (options.method === "POST" && pathname.includes("/comments")) {
            record.comments.push(options.body.body);
            return {};
          }
          throw new Error("unexpected " + options.method + " " + pathname);
        },
        log: () => {},
      });
      console.log(JSON.stringify({ message: "BLOCK succeeded", comments: record.comments.length, statuses: record.statuses }));
      process.exit(0);
    } catch (error) {
      console.log(JSON.stringify({
        message: error.message,
        comments: record.comments.length,
        statuses: record.statuses,
      }));
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
