#!/usr/bin/env node
/**
 * Post an independent-review verdict as the motorunit-aidanos-bots App.
 *
 * Nothing in this repository starts this script. The post workflow has
 * been removed. This file never reads an App private key and never prints
 * a token. PASS is not posted. BLOCK, if someone runs this script by
 * hand, writes a failure status and does not call the checks API.
 *
 *   GITHUB_TOKEN=... GITHUB_REPOSITORY=owner/repo \
 *     node tools/post-review-verdict.mjs <pr> BLOCK <head-sha>
 *
 * --status-only sets the status and does not post a comment. BLOCK writes
 * the failure status first, then posts the comment when a comment is
 * requested. It does not read or write check runs. A failed BLOCK posts
 * no comment.
 *
 * PASS is not posted. approval-gate is the only success status. A PASS
 * matched by the MotorUnitRoot login is ignored, and --status-only PASS
 * writes nothing. The independent-review-post workflow has been removed.
 * This file must not mint or use the shared App key.
 *
 * REVIEW_MODE is "status". The check-run mode has been removed. The
 * installed App has no checks write, and this script never calls the
 * checks API. --parse-request reads an issue_comment event and accepts
 * only a BLOCK whose SHA is still the pull request head.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { REVIEW_APP_ID, STATUS_CONTEXT, verdictLine } from "../.github/independent-review.mjs";

// "status" posts the commit status independent-review/approved.
// check-run mode has been removed. A BLOCK never calls the checks API.
export const REVIEW_MODE = "status";

export const BLOCK_STATUS_FAILED_MESSAGE =
  "Could not set independent-review/approved to failure. BLOCK was not posted, and an earlier PASS stays green until this BLOCK is retried.";

export const BLOCK_CHECK_RATE_LIMIT_MESSAGE =
  "GitHub rate limited independent-review/approved. BLOCK was not posted, and an earlier PASS stays green until this BLOCK is retried.";

// Comments that may start the gated status job. One list of login names, checked in one place.
// This is not GitHub's author association.
export const VERDICT_AUTHORS = Object.freeze(["MotorUnitRoot", "motorunit-aidanos-bots[bot]"]);

export const PASS_ENVIRONMENT = "independent-review";
export const BLOCK_ENVIRONMENT = "independent-review-block";

export function environmentForVerdict(verdict) {
  if (verdict === "PASS") return PASS_ENVIRONMENT;
  if (verdict === "BLOCK") return BLOCK_ENVIRONMENT;
  throw new Error("verdict must be PASS or BLOCK");
}

export function commentBodySha256(body) {
  return createHash("sha256").update(String(body ?? ""), "utf8").digest("hex");
}

export function scrubToken(text, token) {
  const source = String(text ?? "");
  if (!token) return source;
  return source.split(token).join("[redacted]");
}

function selectedMode(mode) {
  const value = mode || REVIEW_MODE;
  if (value === "check-run") {
    throw new Error("check-run mode has been removed. The gate writes a commit status only.");
  }
  if (value !== "status") {
    throw new Error("REVIEW_MODE must be status");
  }
  return "status";
}

function headerValue(headers, name) {
  if (!headers || typeof headers !== "object") return undefined;
  if (Object.prototype.hasOwnProperty.call(headers, name)) return headers[name];
  const match = Object.keys(headers).find((key) => key.toLowerCase() === name);
  return match ? headers[match] : undefined;
}

// 403 and 429 are rate limits when GitHub says so. Any other 403 is permissions.
export function apiFailureKind(error) {
  const status = Number(error && error.status);
  const remaining = headerValue(error && error.headers, "x-ratelimit-remaining");
  const retryAfter = headerValue(error && error.headers, "retry-after");
  const message = String(error && error.message ? error.message : error);
  const rateSignal =
    remaining === 0 ||
    remaining === "0" ||
    (retryAfter != null && String(retryAfter) !== "") ||
    /rate limit/i.test(message);
  if ((status === 403 || status === 429) && rateSignal) return "rate-limit";
  if (status === 403) return "permission";
  return "other";
}

function scrubbedError(error, token) {
  const wrapped = new Error(scrubToken(error && error.message ? error.message : error, token));
  if (error && typeof error === "object") {
    if (Number.isInteger(error.status)) wrapped.status = error.status;
    if (error.headers && typeof error.headers === "object") wrapped.headers = error.headers;
  }
  return wrapped;
}

export function parseVerdictLine(body) {
  const line = String(body ?? "")
    .replace(/^\uFEFF/, "")
    .replace(/\r\n/g, "\n")
    .trimStart()
    .split("\n", 1)[0]
    .trim();
  const match = /^Independent review: (PASS|BLOCK)\s+([0-9a-fA-F]{40})$/.exec(line);
  if (!match) return null;
  return { verdict: match[1], sha: match[2].toLowerCase() };
}

export function classifyCommentRequest({ login, body, headSha, viaApp, userType }) {
  if (!VERDICT_AUTHORS.includes(login)) return { action: "ignore" };
  const parsed = parseVerdictLine(body);
  if (!parsed) return { action: "ignore" };
  if (parsed.verdict === "PASS" && !passAuthorAllowed({ login, viaApp, userType })) return { action: "ignore" };
  const head = String(headSha || "").toLowerCase();
  if (head !== parsed.sha) return { action: "refuse", verdict: parsed.verdict, sha: parsed.sha, head };
  return { action: "accept", verdict: parsed.verdict, sha: parsed.sha };
}

function passAuthorAllowed({ login, viaApp, userType }) {
  void login;
  void viaApp;
  void userType;
  return false;
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
  postComment = true,
  commentId,
  bodySha256,
  log = () => {},
}) {
  void commentId;
  void bodySha256;
  selectedMode(mode);
  if (verdict === "PASS") {
    throw new Error("PASS is not posted. approval-gate is the only success status.");
  }
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
      throw scrubbedError(error, token);
    }
  };

  const pr = await call(`/repos/${owner}/${repo}/pulls/${prNumber}`);
  const head = pr && pr.head && pr.head.sha;
  if (!head || String(head).toLowerCase() !== normalized) {
    throw new Error(`PR #${prNumber} head is ${head || "missing"}, not ${normalized}`);
  }

  if (verdict !== "BLOCK") throw new Error("verdict must be BLOCK");
  const state = "failure";
  const writeComment = () => {
    if (!postComment) return null;
    return call(`/repos/${owner}/${repo}/issues/${prNumber}/comments`, {
      method: "POST",
      body: { body: line },
    });
  };
  const postStatus = () =>
    call(`/repos/${owner}/${repo}/statuses/${encodeURIComponent(head)}`, {
      method: "POST",
      body: {
        state,
        context: STATUS_CONTEXT,
        description: line.slice(0, 140),
      },
    });
  const failStatus = async () => {
    try {
      await postStatus();
    } catch (error) {
      const detail = scrubToken(error.message, token);
      if (apiFailureKind(error) === "rate-limit") {
        throw new Error(`${BLOCK_CHECK_RATE_LIMIT_MESSAGE} (${detail})`);
      }
      throw new Error(`${BLOCK_STATUS_FAILED_MESSAGE} (${detail})`);
    }
  };

  const rewriteFailureIfPassed = async () => {
    let combined;
    try {
      combined = await call(`/repos/${owner}/${repo}/commits/${encodeURIComponent(head)}/status`);
    } catch (error) {
      const detail = scrubToken(error.message, token);
      throw new Error(`${BLOCK_STATUS_FAILED_MESSAGE} (${detail})`);
    }
    const latest = ((combined && combined.statuses) || []).find((item) => item && item.context === STATUS_CONTEXT);
    if (latest && latest.state === "success") await failStatus();
  };

  await failStatus();
  await rewriteFailureIfPassed();
  await writeComment();
  log(
    postComment
      ? `Posted ${verdict} for PR #${prNumber} at ${head}.`
      : `Set independent-review/approved to ${state} for PR #${prNumber} at ${head}.`,
  );
  return { line, state, sha: head, mode: "status", postComment };
}

export async function parseRequest({ event, request, owner, repo, token, writeOutput, writeSummary, log = () => {} }) {
  const user = event && event.comment && event.comment.user;
  const login = user && user.login;
  const body = event && event.comment && event.comment.body;
  const number = event && event.issue && event.issue.number;
  const parsedLine = parseVerdictLine(body);
  const viaApp = event && event.comment && event.comment.performed_via_github_app;
  if (!VERDICT_AUTHORS.includes(login) || !parsedLine) {
    log("No allowlisted verdict on the first line. Nothing to post.");
    return { action: "ignore" };
  }
  if (parsedLine.verdict === "PASS") {
    void passAuthorAllowed({ login, viaApp, userType: user && user.type });
    log("PASS is not posted. approval-gate is the only success status.");
    return { action: "ignore" };
  }
  const pr = await request(`/repos/${owner}/${repo}/pulls/${number}`, { method: "GET", token });
  const head = pr && pr.head && pr.head.sha;
  const result = classifyCommentRequest({ login, body, headSha: head });
  if (result.action !== "accept") {
    throw new Error(
      `PR #${number} head is ${head || "missing"}, not ${result.sha}. Refusing to post ${result.verdict}.`,
    );
  }
  const commentId = Number(event && event.comment && event.comment.id);
  if (!Number.isInteger(commentId) || commentId <= 0) throw new Error("verdict comment id is required");
  const bodySha256 = commentBodySha256(body);
  const environment = environmentForVerdict(result.verdict);
  const short = result.sha.slice(0, 7);
  const waiting =
    result.verdict === "PASS"
      ? "PASS waits for approval in the independent-review environment."
      : "BLOCK uses independent-review-block and applies without a reviewer.";
  if (writeOutput) {
    writeOutput(
      `verdict=${result.verdict}\nsha=${result.sha}\nshort=${short}\npr=${number}\ncomment_id=${commentId}\nbody_sha256=${bodySha256}\nenvironment=${environment}\n`,
    );
  }
  if (writeSummary) {
    writeSummary(
      [
        `### Independent review #${number}`,
        "",
        `**${result.verdict}** \`${short}\``,
        "",
        `Full commit \`${result.sha}\`.`,
        "",
        waiting,
        "",
      ].join("\n"),
    );
  }
  log(`#${number} ${result.verdict} ${short}`);
  return {
    action: "accept",
    verdict: result.verdict,
    sha: result.sha,
    short,
    pr: number,
    commentId,
    bodySha256,
    environment,
  };
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
    const error = new Error(`${method} ${pathname} -> ${response.status} ${scrubToken(text, token).slice(0, 300)}`);
    error.status = response.status;
    const headers = {};
    const remaining = response.headers.get("x-ratelimit-remaining");
    const retryAfter = response.headers.get("retry-after");
    if (remaining != null) headers["x-ratelimit-remaining"] = remaining;
    if (retryAfter != null) headers["retry-after"] = retryAfter;
    error.headers = headers;
    throw error;
  }
  if (!text) return null;
  return JSON.parse(text);
}

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

export function selfTest() {
  const previousGate = process.env.REVIEW_GATE_PASS_ENV;
  process.env.REVIEW_GATE_PASS_ENV = "1";
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
    assert(passResult.status === "rejected", "PASS is not posted");
    assert(
      String(passResult.reason && passResult.reason.message).includes("PASS is not posted"),
      "PASS names the approval gate as the only success status",
    );
    assert(passApi.calls.length === 0, "PASS does not call the API or write a status");

    assert(REVIEW_MODE === "status", "the default mode is status");
    assert(blockResult.status === "fulfilled", "block posts");
    assert(blockResult.value.line === `Independent review: BLOCK ${sha}`, "block first line");
    assert(blockApi.calls[1].pathname.includes("/statuses/"), "block sets status before the comment");
    assert(blockApi.calls[1].body.state === "failure", "block status");
    assert(blockApi.calls[2].pathname.endsWith("/status"), "block reads the status again after writing failure");
    assert(blockApi.calls[3].body.body === `Independent review: BLOCK ${sha}`, "block comment after the failure writes");
    assert(
      !blockApi.calls.some((call) => call.pathname.includes("/check-runs") || call.pathname.includes("/checks")),
      "BLOCK does not call the checks API",
    );

    assert(staleResult.status === "rejected", "PASS is refused before the head is read");
    assert(staleApi.calls.length === 0, "PASS posts nothing");
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
    assert(
      passStopped instanceof Error && passStopped.message.includes("PASS is not posted"),
      "PASS does not post",
    );
    assert(passCommentFails.calls.length === 0, "PASS does not set success");

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
    assert(priorPosts[0].kind === "status" && priorPosts[0].state === "failure", "BLOCK writes the failure status and leaves check runs alone");
    assert(priorPosts[1].kind === "comment", "BLOCK comments after the failure status");
    assert(!priorPosts.some((post) => post.kind === "check-run"), "BLOCK does not write a check run");
    assert(priorCheck.lookups.length === 0, "BLOCK does not read check runs");

    const noChecksAccess = memoryApi(sha, token, {
      statuses: [{ state: "success", context: STATUS_CONTEXT, source: "earlier-pass" }],
      denyChecks: true,
    });
    const noChecksError = await postReviewVerdict({
      token,
      owner: "MotorUnitRoot",
      repo: "aidanos",
      number: 40,
      verdict: "BLOCK",
      sha,
      mode: "status",
      request: noChecksAccess.request,
      log: () => {},
    }).then(
      () => null,
      (error) => error,
    );
    assert(noChecksError == null, "a checks 403 does not refuse BLOCK");
    assert(
      noChecksAccess.posts().some((post) => post.kind === "status" && post.state === "failure"),
      "a BLOCK with no checks access still writes the failure status",
    );
    assert(!noChecksAccess.posts().some((post) => post.kind === "check-run"), "a BLOCK with no checks access writes no check run");
    assert(
      noChecksAccess.statuses.some((item) => item.state === "failure" && item.source === "write"),
      "the failure status is recorded when checks are forbidden",
    );

    const passNoChecks = memoryApi(sha, token, { denyChecks: true });
    const passNoChecksError = await postReviewVerdict({
      token,
      owner: "MotorUnitRoot",
      repo: "aidanos",
      number: 40,
      verdict: "PASS",
      sha,
      mode: "status",
      request: passNoChecks.request,
      log: () => {},
    }).then(
      () => null,
      (error) => error,
    );
    assert(
      passNoChecksError instanceof Error && passNoChecksError.message.includes("PASS is not posted"),
      "PASS does not write success",
    );
    assert(passNoChecks.posts().length === 0, "PASS writes nothing");
    assert(passNoChecks.lookups.length === 0, "PASS does not call the checks API");

    const checkModeRemoved = memoryApi(sha, token);
    const checkModeError = await postReviewVerdict({
      token,
      owner: "MotorUnitRoot",
      repo: "aidanos",
      number: 40,
      verdict: "PASS",
      sha,
      mode: "check-run",
      request: checkModeRemoved.request,
      log: () => {},
    }).then(
      () => null,
      (error) => error,
    );
    assert(
      checkModeError instanceof Error && checkModeError.message.includes("check-run mode has been removed"),
      "check-run mode is removed",
    );
    assert(checkModeRemoved.posts().length === 0, "removed check-run mode writes nothing");

    assert(
      VERDICT_AUTHORS.length === 2 &&
        VERDICT_AUTHORS[0] === "MotorUnitRoot" &&
        VERDICT_AUTHORS[1] === "motorunit-aidanos-bots[bot]",
      "verdict authors are the one allowlist",
    );
    assert(
      classifyCommentRequest({ login: "MotorUnitRoot", body: `Independent review: PASS ${sha}\nnote`, headSha: sha }).action ===
        "ignore",
      "a MotorUnitRoot PASS is not an approval",
    );
    assert(
      classifyCommentRequest({
        login: "motorunit-aidanos-bots[bot]",
        body: `Independent review: BLOCK ${sha}`,
        headSha: sha,
      }).action === "accept",
      "the review App can request a BLOCK",
    );
    assert(
      classifyCommentRequest({
        login: "motorunit-aidanos-bots[bot]",
        body: `Independent review: PASS ${sha}`,
        headSha: sha,
      }).action === "ignore",
      "an App PASS is not an approval",
    );
    assert(
      classifyCommentRequest({
        login: "MotorUnitRoot",
        body: `Independent review: PASS ${sha}`,
        headSha: sha,
        viaApp: { id: 1210556, slug: "cursor" },
        userType: "User",
      }).action === "ignore",
      "a PASS made through an app is not an approval",
    );
    assert(
      classifyCommentRequest({ login: "octocat", body: `Independent review: PASS ${sha}`, headSha: sha }).action === "ignore",
      "other authors are ignored",
    );
    assert(
      classifyCommentRequest({ login: "MotorUnitRoot", body: "Independent review: BLOCK", headSha: sha }).action === "ignore",
      "a BLOCK without the full commit is ignored",
    );
    assert(
      classifyCommentRequest({ login: "MotorUnitRoot", body: `Independent review: BLOCK ${sha}`, headSha: `b${"c".repeat(39)}` })
        .action === "refuse",
      "a BLOCK for an older commit is refused",
    );

    let lookups = 0;
    const ignoredRequest = await parseRequest({
      event: {
        comment: { user: { login: "octocat" }, body: `Independent review: PASS ${sha}` },
        issue: { number: 40 },
      },
      request: async () => {
        lookups += 1;
        return { head: { sha } };
      },
      owner: "MotorUnitRoot",
      repo: "aidanos",
      token,
    });
    assert(ignoredRequest.action === "ignore" && lookups === 0, "ignored comments do not read the pull request");

    let appPassLookups = 0;
    const appPassIgnored = await parseRequest({
      event: {
        comment: {
          id: 15,
          user: { login: "motorunit-aidanos-bots[bot]", type: "Bot" },
          body: `Independent review: PASS ${sha}`,
          performed_via_github_app: { id: 5413571, slug: "motorunit-aidanos-bots" },
        },
        issue: { number: 40 },
      },
      request: async () => {
        appPassLookups += 1;
        return { head: { sha } };
      },
      owner: "MotorUnitRoot",
      repo: "aidanos",
      token,
    });
    assert(appPassIgnored.action === "ignore" && appPassLookups === 0, "an App PASS does not read the pull request or post");

    const refusedRequest = await parseRequest({
      event: {
        comment: { user: { login: "MotorUnitRoot" }, body: `Independent review: BLOCK ${sha}` },
        issue: { number: 40 },
      },
      request: async () => ({ head: { sha: `b${"c".repeat(39)}` } }),
      owner: "MotorUnitRoot",
      repo: "aidanos",
      token,
    }).then(
      () => null,
      (error) => error,
    );
    assert(
      refusedRequest instanceof Error && refusedRequest.message.includes("Refusing to post BLOCK"),
      "a moved head refuses the gated post",
    );

    let passLookups = 0;
    let parsedOutput = "";
    const ignoredPass = await parseRequest({
      event: {
        comment: { id: 15, user: { login: "MotorUnitRoot", type: "User" }, body: `Independent review: PASS ${sha}\nlater` },
        issue: { number: 40 },
      },
      request: async () => {
        passLookups += 1;
        return { head: { sha } };
      },
      owner: "MotorUnitRoot",
      repo: "aidanos",
      token,
      writeOutput: (text) => {
        parsedOutput += text;
      },
    });
    assert(ignoredPass.action === "ignore" && passLookups === 0, "a MotorUnitRoot PASS does not read the pull request");
    assert(!parsedOutput.includes("verdict=PASS"), "parse does not emit a PASS verdict");

    let blockOutput = "";
    const blockParsed = await parseRequest({
      event: {
        comment: { id: 16, user: { login: "MotorUnitRoot" }, body: `Independent review: BLOCK ${sha}` },
        issue: { number: 40 },
      },
      request: async () => ({ head: { sha } }),
      owner: "MotorUnitRoot",
      repo: "aidanos",
      token,
      writeOutput: (text) => {
        blockOutput += text;
      },
    });
    assert(blockParsed.environment === BLOCK_ENVIRONMENT, "BLOCK names the immediate environment");
    assert(blockOutput.includes(`environment=${BLOCK_ENVIRONMENT}`), "BLOCK output names its environment");

    const statusOnlyBlock = memoryApi(sha, token, {
      checkRuns: [{ name: STATUS_CONTEXT, conclusion: "success", app: { id: REVIEW_APP_ID } }],
      denyChecks: true,
    });
    await postReviewVerdict({
      token,
      owner: "MotorUnitRoot",
      repo: "aidanos",
      number: 40,
      verdict: "BLOCK",
      sha,
      postComment: false,
      request: statusOnlyBlock.request,
      log: () => {},
    });
    const statusOnlyBlockPosts = statusOnlyBlock.posts();
    assert(
      statusOnlyBlockPosts.length === 1 &&
        statusOnlyBlockPosts[0].kind === "status" &&
        statusOnlyBlockPosts[0].state === "failure",
      "status-only BLOCK sets the failure status and does not touch check runs",
    );
    assert(!statusOnlyBlockPosts.some((post) => post.kind === "comment"), "status-only BLOCK does not post a comment");

    const statusOnlyPass = memoryApi(sha, token);
    const statusOnlyPassError = await postReviewVerdict({
      token,
      owner: "MotorUnitRoot",
      repo: "aidanos",
      number: 40,
      verdict: "PASS",
      sha,
      postComment: false,
      request: statusOnlyPass.request,
      log: () => {},
    }).then(
      () => null,
      (error) => error,
    );
    assert(
      statusOnlyPassError instanceof Error && statusOnlyPassError.message.includes("PASS is not posted"),
      "status-only PASS is refused",
    );
    assert(statusOnlyPass.posts().length === 0, "status-only PASS writes nothing");
    assert(statusOnlyPass.comments.length === 0, "status-only PASS does not post a comment");

    const rateLimitedStatus = memoryApi(sha, token, {
      statuses: [{ state: "success", context: STATUS_CONTEXT, source: "earlier-pass" }],
      statusWriteError: httpError(403, "403 API rate limit exceeded", { "x-ratelimit-remaining": "0" }),
    });
    const rateLimitedStatusError = await postReviewVerdict({
      token,
      owner: "MotorUnitRoot",
      repo: "aidanos",
      number: 40,
      verdict: "BLOCK",
      sha,
      request: rateLimitedStatus.request,
      log: () => {},
    }).then(
      () => null,
      (error) => error,
    );
    assert(
      rateLimitedStatusError instanceof Error && rateLimitedStatusError.message.startsWith(BLOCK_CHECK_RATE_LIMIT_MESSAGE),
      "a rate-limited status write is reported as rate limiting",
    );
    assert(rateLimitedStatus.comments.length === 0, "a rate-limited status write posts no comment");
    assert(
      rateLimitedStatus.statuses.length === 1 && rateLimitedStatus.statuses[0].state === "success",
      "a rate-limited status write leaves the PASS",
    );

    assert(apiFailureKind(httpError(403, "403 Resource not accessible by integration", {})) === "permission", "a plain 403 is permissions");
    assert(
      apiFailureKind(httpError(403, "You have exceeded a secondary rate limit", { "x-ratelimit-remaining": "12" })) ===
        "rate-limit",
      "a 403 that says rate limit is rate limiting",
    );
    assert(apiFailureKind(httpError(429, "429", {})) === "other", "a 429 without a rate-limit signal is not a permission error");

    const passBody = `Independent review: PASS ${sha}`;
    const passHash = commentBodySha256(passBody);
    const passComment = {
      id: 15,
      body: passBody,
      created_at: "2026-10-21T00:00:00Z",
      user: { login: "MotorUnitRoot" },
    };
    async function recheck(verdict, { comment, head = sha, statusState = null, comments = [], missing = false } = {}) {
      const posts = [];
      const error = await postReviewVerdict({
        token,
        owner: "MotorUnitRoot",
        repo: "aidanos",
        number: 40,
        verdict,
        sha,
        postComment: false,
        commentId: 15,
        bodySha256: verdict === "BLOCK" ? commentBodySha256(`Independent review: BLOCK ${sha}`) : passHash,
        request: async (pathname, options) => {
          if (options.method === "GET" && pathname.includes("/pulls/")) return { head: { sha: head } };
          if (options.method === "GET" && pathname.includes("/issues/comments/")) {
            if (missing) throw httpError(404, "404 Not Found", {});
            return comment;
          }
          if (options.method === "GET" && pathname.includes("/comments?")) return comments;
          if (options.method === "GET" && pathname.endsWith("/status")) {
            return { statuses: statusState ? [{ context: STATUS_CONTEXT, state: statusState }] : [] };
          }
          if (options.method === "POST" && pathname.includes("/statuses/")) {
            posts.push(options.body.state);
            return {};
          }
          throw new Error(`unexpected ${options.method} ${pathname}`);
        },
        log: () => {},
      }).then(
        () => null,
        (err) => err,
      );
      return { error, posts };
    }

    for (const [label, options] of [
      ["a deleted PASS comment", { missing: true }],
      ["an edited PASS comment", { comment: { ...passComment, body: `${passBody}\nedited` } }],
      ["a PASS whose head moved", { comment: passComment, head: `b${"c".repeat(39)}` }],
      ["a PASS on a commit that is already failure", { comment: passComment, statusState: "failure" }],
      [
        "a PASS beside an allowed BLOCK",
        {
          comment: passComment,
          comments: [
            {
              user: { login: "motorunit-aidanos-bots[bot]" },
              body: `Independent review: BLOCK ${sha}`,
            },
          ],
        },
      ],
      [
        "a PASS beside a BLOCK from another login",
        {
          comment: passComment,
          comments: [{ user: { login: "octocat" }, body: `Independent review: BLOCK ${sha}` }],
        },
      ],
    ]) {
      const outcome = await recheck("PASS", options);
      assert(
        outcome.error instanceof Error && outcome.error.message.includes("PASS is not posted") && outcome.posts.length === 0,
        `${label} writes nothing`,
      );
    }

    delete process.env.REVIEW_GATE_PASS_ENV;
    const closedGate = await recheck("PASS", { comment: passComment });
    process.env.REVIEW_GATE_PASS_ENV = "1";
    assert(
      closedGate.error instanceof Error && closedGate.error.message.includes("PASS is not posted"),
      "PASS is refused with or without the old gate variable",
    );
    assert(closedGate.posts.length === 0, "PASS sets no success");

    const blockBody = `Independent review: BLOCK ${sha}`;
    const freshBlock = await recheck("BLOCK", {
      comment: { id: 15, body: blockBody, created_at: "2026-10-21T00:00:00Z", user: { login: "MotorUnitRoot" } },
      statusState: "failure",
    });
    assert(freshBlock.error == null && freshBlock.posts[0] === "failure", "BLOCK still posts when the comment is unchanged");

    const editedBlock = await recheck("BLOCK", {
      comment: { id: 15, body: "edited away", created_at: "2026-10-21T00:00:00Z", user: { login: "MotorUnitRoot" } },
    });
    assert(editedBlock.error == null && editedBlock.posts[0] === "failure", "an edited BLOCK comment still sets failure");

    const deletedBlock = await recheck("BLOCK", { missing: true });
    assert(deletedBlock.error == null && deletedBlock.posts[0] === "failure", "a deleted BLOCK comment still sets failure");

    const raced = [];
    await postReviewVerdict({
      token,
      owner: "MotorUnitRoot",
      repo: "aidanos",
      number: 40,
      verdict: "BLOCK",
      sha,
      postComment: false,
      request: async (pathname, options) => {
        if (options.method === "GET" && pathname.includes("/pulls/")) return { head: { sha } };
        if (options.method === "GET" && pathname.endsWith("/status")) {
          return { statuses: [{ context: STATUS_CONTEXT, state: "success" }] };
        }
        if (options.method === "POST" && pathname.includes("/statuses/")) {
          raced.push(options.body.state);
          return {};
        }
        throw new Error(`unexpected ${options.method} ${pathname}`);
      },
      log: () => {},
    });
    assert(raced.length === 2 && raced.every((state) => state === "failure"), "BLOCK writes failure again when a success landed after it");

    const workflowDir = new URL("../.github/workflows/", import.meta.url);
    const workflowNames = fs.readdirSync(workflowDir);
    assert(!workflowNames.includes("independent-review-post.yml"), "the shared-key status writer workflow is gone");
    let missingWorkflow = null;
    try {
      fs.readFileSync(new URL("../.github/workflows/independent-review-post.yml", import.meta.url), "utf8");
    } catch (error) {
      missingWorkflow = error;
    }
    assert(missingWorkflow && missingWorkflow.code === "ENOENT", "the post workflow file cannot be read");
    if (previousGate === undefined) delete process.env.REVIEW_GATE_PASS_ENV;
    else process.env.REVIEW_GATE_PASS_ENV = previousGate;

    console.log("post-review-verdict self-test ok");
  });
}

function httpError(status, message, headers) {
  const error = new Error(message);
  error.status = status;
  error.headers = headers;
  return error;
}

function memoryApi(
  head,
  token,
  { statuses = [], checkRuns = [], denyCheckWrite = false, denyChecks = false, listError = null, checkWriteError = null, statusWriteError = null } = {},
) {
  const state = {
    statuses: statuses.map((item) => ({ ...item })),
    checkRuns: checkRuns.map((item) => ({ ...item })),
    comments: [],
    posts: [],
    lookups: [],
  };
  const checksRequest = (pathname) => pathname.includes("/check-runs") || pathname.includes("/checks");
  const request = async (pathname, options) => {
    if (String(options.token) !== token) throw new Error("missing token");
    if (checksRequest(pathname)) {
      state.lookups.push(pathname);
      if (denyChecks) throw httpError(403, "403 Resource not accessible by integration", {});
    }
    if (options.method === "GET" && pathname.includes("/pulls/")) return { head: { sha: head } };
    if (options.method === "GET" && pathname.includes("/check-runs")) {
      if (listError) throw listError;
      return { check_runs: state.checkRuns };
    }
    if (options.method === "GET" && pathname.endsWith("/status")) {
      const ours = [...state.statuses].reverse().find((item) => item.context === STATUS_CONTEXT);
      return { statuses: ours ? [{ context: STATUS_CONTEXT, state: ours.state }] : [] };
    }
    if (options.method === "GET" && pathname.includes("/comments")) return [];
    if (options.method === "POST" && pathname.endsWith("/check-runs")) {
      if (checkWriteError) throw checkWriteError;
      if (denyCheckWrite) throw httpError(403, "403 Resource not accessible by integration", {});
      const run = { name: options.body.name, conclusion: options.body.conclusion, app: { id: REVIEW_APP_ID, slug: "motorunit-aidanos-bots" } };
      state.checkRuns.push(run);
      state.posts.push({ kind: "check-run", conclusion: options.body.conclusion });
      return run;
    }
    if (options.method === "POST" && pathname.includes("/statuses/")) {
      if (statusWriteError) throw statusWriteError;
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
    get lookups() {
      return state.lookups;
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
  const [owner, repo] = String(process.env.GITHUB_REPOSITORY || "").split("/");
  const apiBase = process.env.GITHUB_API_URL || "https://api.github.com";
  const token = process.env.GITHUB_TOKEN;
  const request = (pathname, options) => githubRequest({ apiBase, pathname, ...options });
  if (process.argv.includes("--parse-request")) {
    const eventPath = process.env.GITHUB_EVENT_PATH;
    if (!eventPath) throw new Error("GITHUB_EVENT_PATH is required");
    const event = JSON.parse(fs.readFileSync(eventPath, "utf8"));
    await parseRequest({
      event,
      request,
      owner,
      repo,
      token,
      writeOutput: (text) => {
        if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, text);
      },
      writeSummary: (text) => {
        if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, text);
      },
      log: (message) => console.log(message),
    });
    return;
  }
  const statusOnly = process.argv.includes("--status-only");
  let args = process.argv.slice(2).filter((arg) => arg !== "--status-only");
  const commentFlag = takeFlag(args, "--comment-id");
  args = commentFlag.args;
  const bodyFlag = takeFlag(args, "--body-sha256");
  args = bodyFlag.args;
  const [number, verdict, sha] = args;
  await postReviewVerdict({
    token,
    owner,
    repo,
    number,
    verdict,
    sha,
    postComment: !statusOnly,
    commentId: commentFlag.value,
    bodySha256: bodyFlag.value,
    request,
    log: (message) => console.log(message),
  });
}

function takeFlag(args, name) {
  const index = args.indexOf(name);
  if (index === -1) return { args, value: undefined };
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} needs a value`);
  return { args: args.slice(0, index).concat(args.slice(index + 2)), value };
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
