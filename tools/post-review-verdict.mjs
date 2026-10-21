#!/usr/bin/env node
/**
 * Post an independent-review verdict as the motorunit-aidanos-bots App.
 *
 * The App private key is pasted into each review environment as
 * REVIEW_APP_PRIVATE_KEY. The gated workflow mints an installation token
 * and passes it as GITHUB_TOKEN. This file never reads the key and never
 * prints the token. When --comment-id is set, the comment is fetched again
 * before the status is written.
 *
 *   GITHUB_TOKEN=... GITHUB_REPOSITORY=owner/repo \
 *     node tools/post-review-verdict.mjs <pr> PASS <head-sha>
 *
 * --status-only sets the status and does not post a comment. The gated
 * workflow uses it because the verdict comment is already on the pull
 * request. The script refuses if the pull request's current head is not
 * that SHA. On PASS it posts the comment first, then sets success, so a
 * failed comment never turns the commit green. On BLOCK it writes the
 * failure signals first, then posts the comment. A failed BLOCK posts no
 * comment, so an earlier PASS stays green until the BLOCK is retried.
 *
 * REVIEW_MODE is "status" or "check-run". Changing it is a code change.
 * --parse-request reads an issue_comment event and accepts a verdict only
 * from VERDICT_AUTHORS, and only when the SHA is still the pull request head.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
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

export const BLOCK_CHECK_RATE_LIMIT_MESSAGE =
  "GitHub rate limited independent-review/approved. BLOCK was not posted, and an earlier PASS stays green until this BLOCK is retried.";

const BLOCK_CHECK_LIST_MESSAGE =
  "Cannot list check runs named independent-review/approved, so a BLOCK cannot see an earlier check run. BLOCK was not posted, and an earlier PASS stays green until this BLOCK is retried.";

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
  if (value !== "status" && value !== "check-run") {
    throw new Error("REVIEW_MODE must be status or check-run");
  }
  return value;
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

export function classifyCommentRequest({ login, body, headSha }) {
  if (!VERDICT_AUTHORS.includes(login)) return { action: "ignore" };
  const parsed = parseVerdictLine(body);
  if (!parsed) return { action: "ignore" };
  const head = String(headSha || "").toLowerCase();
  if (head !== parsed.sha) return { action: "refuse", verdict: parsed.verdict, sha: parsed.sha, head };
  return { action: "accept", verdict: parsed.verdict, sha: parsed.sha };
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
  postComment = true,
  commentId,
  bodySha256,
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
      throw scrubbedError(error, token);
    }
  };

  const pr = await call(`/repos/${owner}/${repo}/pulls/${prNumber}`);
  const head = pr && pr.head && pr.head.sha;
  if (!head || String(head).toLowerCase() !== normalized) {
    throw new Error(`PR #${prNumber} head is ${head || "missing"}, not ${normalized}`);
  }

  if (commentId != null && commentId !== "") {
    const id = Number(commentId);
    if (!Number.isInteger(id) || id <= 0) throw new Error("comment id is required");
    if (!bodySha256) throw new Error("comment body hash is required");
    let current;
    try {
      current = await call(`/repos/${owner}/${repo}/issues/comments/${id}`);
    } catch (error) {
      if (error.status === 404) throw new Error(`Comment ${id} was deleted. ${verdict} was not posted.`);
      throw error;
    }
    if (commentBodySha256(current && current.body) !== bodySha256) {
      throw new Error(`Comment ${id} changed. ${verdict} was not posted.`);
    }
    if (verdict === "PASS") {
      const combined = await call(`/repos/${owner}/${repo}/commits/${encodeURIComponent(head)}/status`);
      const latest = ((combined && combined.statuses) || []).find((item) => item && item.context === STATUS_CONTEXT);
      if (latest && latest.state === "failure") {
        throw new Error(`independent-review/approved is already failure on ${head}. PASS was not posted.`);
      }
      const passCreated = String((current && current.created_at) || "");
      let page = 1;
      for (;;) {
        const listed = await call(
          `/repos/${owner}/${repo}/issues/${prNumber}/comments?per_page=100&page=${page}`,
        );
        const comments = Array.isArray(listed) ? listed : [];
        for (const item of comments) {
          const login = item && item.user && item.user.login;
          if (!VERDICT_AUTHORS.includes(login)) continue;
          const parsed = parseVerdictLine(item && item.body);
          if (!parsed || parsed.verdict !== "BLOCK" || parsed.sha !== normalized) continue;
          if (String(item.created_at || "") > passCreated) {
            throw new Error(`A later BLOCK for ${normalized} exists. PASS was not posted.`);
          }
        }
        if (comments.length < 100) break;
        page += 1;
        if (page > 20) throw new Error("The comment list was truncated. PASS was not posted.");
      }
    }
  }

  const state = verdict === "PASS" ? "success" : "failure";
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

  const failCheckStep = (error, step) => {
    const kind = apiFailureKind(error);
    if (kind === "rate-limit") throw new Error(BLOCK_CHECK_RATE_LIMIT_MESSAGE);
    if (kind === "permission") {
      throw new Error(step === "list" ? BLOCK_CHECK_LIST_MESSAGE : BLOCK_CHECK_PERMISSION_MESSAGE);
    }
    const what = step === "list" ? `list check runs named ${STATUS_CONTEXT}` : "write the failing check run";
    throw new Error(`Could not ${what}. BLOCK was not posted. (${scrubToken(error.message, token)})`);
  };

  const failExistingCheckRuns = async () => {
    let listed;
    try {
      listed = await call(
        `/repos/${owner}/${repo}/commits/${encodeURIComponent(head)}/check-runs?check_name=${encodeURIComponent(STATUS_CONTEXT)}&per_page=100`,
      );
    } catch (error) {
      failCheckStep(error, "list");
    }
    const runs = (listed && listed.check_runs) || [];
    if (!runs.some(isOurCheckRun)) return;
    try {
      await postCheckRun();
    } catch (error) {
      failCheckStep(error, "write");
    }
  };

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

  if (verdict === "BLOCK" && reviewMode === "status") {
    await failExistingCheckRuns();
    await failStatus();
    await writeComment();
  } else if (verdict === "BLOCK") {
    try {
      await postCheckRun();
    } catch (error) {
      failCheckStep(error, "write");
    }
    await failStatus();
    await writeComment();
  } else if (reviewMode === "status") {
    await writeComment();
    await postStatus();
  } else {
    await writeComment();
    await postCheckRun();
  }
  log(
    postComment
      ? `Posted ${verdict} for PR #${prNumber} at ${head}.`
      : `Set independent-review/approved to ${state} for PR #${prNumber} at ${head}.`,
  );
  return { line, state, sha: head, mode: reviewMode, postComment };
}

export async function parseRequest({ event, request, owner, repo, token, writeOutput, writeSummary, log = () => {} }) {
  const login = event && event.comment && event.comment.user && event.comment.user.login;
  const body = event && event.comment && event.comment.body;
  const number = event && event.issue && event.issue.number;
  if (!VERDICT_AUTHORS.includes(login) || !parseVerdictLine(body)) {
    log("No allowlisted verdict on the first line. Nothing to post.");
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
    assert(
      blockApi.calls[1].pathname.includes(`check_name=${encodeURIComponent(STATUS_CONTEXT)}`),
      "check-run lookup is filtered by check_name",
    );
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

    assert(
      VERDICT_AUTHORS.length === 2 &&
        VERDICT_AUTHORS[0] === "MotorUnitRoot" &&
        VERDICT_AUTHORS[1] === "motorunit-aidanos-bots[bot]",
      "verdict authors are the one allowlist",
    );
    assert(
      classifyCommentRequest({ login: "MotorUnitRoot", body: `Independent review: PASS ${sha}\nnote`, headSha: sha }).action ===
        "accept",
      "Colby can request a PASS",
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
      classifyCommentRequest({ login: "octocat", body: `Independent review: PASS ${sha}`, headSha: sha }).action === "ignore",
      "other authors are ignored",
    );
    assert(
      classifyCommentRequest({ login: "MotorUnitRoot", body: "Independent review: BLOCK", headSha: sha }).action === "ignore",
      "a BLOCK without the full commit is ignored",
    );
    assert(
      classifyCommentRequest({ login: "MotorUnitRoot", body: `Independent review: PASS ${sha}`, headSha: `b${"c".repeat(39)}` })
        .action === "refuse",
      "a verdict for an older commit is refused",
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

    let parsedOutput = "";
    const acceptedRequest = await parseRequest({
      event: {
        comment: { id: 15, user: { login: "motorunit-aidanos-bots[bot]" }, body: `Independent review: PASS ${sha}\nlater` },
        issue: { number: 40 },
      },
      request: async () => ({ head: { sha } }),
      owner: "MotorUnitRoot",
      repo: "aidanos",
      token,
      writeOutput: (text) => {
        parsedOutput += text;
      },
    });
    assert(acceptedRequest.action === "accept" && acceptedRequest.verdict === "PASS", "an allowlisted current verdict is accepted");
    assert(parsedOutput.includes("verdict=PASS") && parsedOutput.includes(`sha=${sha}`), "parse writes the verdict outputs");
    assert(parsedOutput.includes("comment_id=15"), "parse passes the comment id");
    assert(
      parsedOutput.includes(`body_sha256=${commentBodySha256(`Independent review: PASS ${sha}\nlater`)}`),
      "parse passes the comment body hash",
    );
    assert(parsedOutput.includes(`environment=${PASS_ENVIRONMENT}`), "PASS names the approval environment");

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
    assert(statusOnlyBlockPosts[0].kind === "check-run" && statusOnlyBlockPosts[0].conclusion === "failure", "status-only BLOCK still fails an earlier check run");
    assert(statusOnlyBlockPosts[1].kind === "status" && statusOnlyBlockPosts[1].state === "failure", "status-only BLOCK sets the failure status");
    assert(!statusOnlyBlockPosts.some((post) => post.kind === "comment"), "status-only BLOCK does not post a comment");

    const statusOnlyPass = memoryApi(sha, token);
    await postReviewVerdict({
      token,
      owner: "MotorUnitRoot",
      repo: "aidanos",
      number: 40,
      verdict: "PASS",
      sha,
      postComment: false,
      request: statusOnlyPass.request,
      log: () => {},
    });
    assert(
      statusOnlyPass.posts().length === 1 && statusOnlyPass.posts()[0].state === "success",
      "status-only PASS sets success and nothing else",
    );
    assert(statusOnlyPass.comments.length === 0, "status-only PASS does not post a comment");

    const rateLimitedList = memoryApi(sha, token, {
      statuses: [{ state: "success", context: STATUS_CONTEXT, source: "earlier-pass" }],
      checkRuns: [{ name: STATUS_CONTEXT, conclusion: "success", app: { id: REVIEW_APP_ID } }],
      listError: httpError(403, "403 API rate limit exceeded", { "x-ratelimit-remaining": "0" }),
    });
    const rateLimitedListError = await postReviewVerdict({
      token,
      owner: "MotorUnitRoot",
      repo: "aidanos",
      number: 40,
      verdict: "BLOCK",
      sha,
      request: rateLimitedList.request,
      log: () => {},
    }).then(
      () => null,
      (error) => error,
    );
    assert(rateLimitedListError instanceof Error && rateLimitedListError.message === BLOCK_CHECK_RATE_LIMIT_MESSAGE, "a 403 with no remaining quota is rate limiting");
    assert(rateLimitedList.comments.length === 0, "a rate-limited list posts no comment");
    assert(rateLimitedList.statuses.length === 1 && rateLimitedList.statuses[0].state === "success", "a rate-limited list leaves the PASS");
    assert(
      rateLimitedList.lookups[0].includes(`check_name=${encodeURIComponent(STATUS_CONTEXT)}`),
      "the rate-limited lookup was still filtered by name",
    );

    const retryAfter = memoryApi(sha, token, {
      listError: httpError(429, "429 too many requests", { "retry-after": "60" }),
    });
    const retryAfterError = await postReviewVerdict({
      token,
      owner: "MotorUnitRoot",
      repo: "aidanos",
      number: 40,
      verdict: "BLOCK",
      sha,
      request: retryAfter.request,
      log: () => {},
    }).then(
      () => null,
      (error) => error,
    );
    assert(retryAfterError instanceof Error && retryAfterError.message === BLOCK_CHECK_RATE_LIMIT_MESSAGE, "a 429 with retry-after is rate limiting");

    const rateLimitedWrite = memoryApi(sha, token, {
      statuses: [{ state: "success", context: STATUS_CONTEXT, source: "earlier-pass" }],
      checkRuns: [{ name: STATUS_CONTEXT, conclusion: "success", app: { id: REVIEW_APP_ID } }],
      checkWriteError: httpError(403, "secondary rate limit", { "x-ratelimit-remaining": "4", "retry-after": "8" }),
    });
    const rateLimitedWriteError = await postReviewVerdict({
      token,
      owner: "MotorUnitRoot",
      repo: "aidanos",
      number: 40,
      verdict: "BLOCK",
      sha,
      request: rateLimitedWrite.request,
      log: () => {},
    }).then(
      () => null,
      (error) => error,
    );
    assert(
      rateLimitedWriteError instanceof Error && rateLimitedWriteError.message === BLOCK_CHECK_RATE_LIMIT_MESSAGE,
      "a rate-limited check write is not a permission error",
    );
    assert(rateLimitedWriteError.message !== BLOCK_CHECK_PERMISSION_MESSAGE, "rate limiting stays distinct from permission");
    assert(rateLimitedWrite.comments.length === 0, "a rate-limited check write posts no comment");
    assert(rateLimitedWrite.statuses[0].state === "success", "a rate-limited check write leaves the PASS");

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
          if (options.method === "GET" && pathname.includes("/check-runs")) return { check_runs: [] };
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

    const deleted = await recheck("PASS", { missing: true });
    assert(deleted.error instanceof Error && deleted.error.message.includes("was deleted"), "a deleted comment refuses the post");
    assert(deleted.posts.length === 0, "a deleted comment sets no status");

    const changed = await recheck("PASS", { comment: { ...passComment, body: `${passBody}\nedited` } });
    assert(changed.error instanceof Error && changed.error.message.includes("changed"), "a changed comment refuses the post");
    assert(changed.posts.length === 0, "a changed comment sets no status");

    const moved = await recheck("PASS", { comment: passComment, head: `b${"c".repeat(39)}` });
    assert(moved.error instanceof Error && moved.error.message.includes("head is"), "PASS re-checks that the head is still the verdict commit");
    assert(moved.posts.length === 0, "a moved head sets no status");

    const alreadyBlocked = await recheck("PASS", { comment: passComment, statusState: "failure" });
    assert(
      alreadyBlocked.error instanceof Error && alreadyBlocked.error.message.includes("already failure"),
      "PASS refuses when the commit is already a BLOCK failure",
    );
    assert(alreadyBlocked.posts.length === 0, "an existing failure is not overwritten with success");

    const laterBlock = await recheck("PASS", {
      comment: passComment,
      comments: [
        {
          user: { login: "MotorUnitRoot" },
          created_at: "2026-10-21T01:00:00Z",
          body: `Independent review: BLOCK ${sha}`,
        },
      ],
    });
    assert(laterBlock.error instanceof Error && laterBlock.error.message.includes("later BLOCK"), "a later BLOCK comment refuses PASS");
    assert(laterBlock.posts.length === 0, "a later BLOCK sets no success");

    const strangerBlock = await recheck("PASS", {
      comment: passComment,
      comments: [
        {
          user: { login: "octocat" },
          created_at: "2026-10-21T01:00:00Z",
          body: `Independent review: BLOCK ${sha}`,
        },
      ],
    });
    assert(strangerBlock.error == null && strangerBlock.posts[0] === "success", "a BLOCK from outside the login allowlist does not stop PASS");

    const earlierBlock = await recheck("PASS", {
      comment: passComment,
      comments: [
        {
          user: { login: "motorunit-aidanos-bots[bot]" },
          created_at: "2026-10-20T00:00:00Z",
          body: `Independent review: BLOCK ${sha}`,
        },
      ],
    });
    assert(earlierBlock.error == null && earlierBlock.posts[0] === "success", "an earlier BLOCK comment does not by itself stop PASS");

    const blockBody = `Independent review: BLOCK ${sha}`;
    const freshBlock = await recheck("BLOCK", {
      comment: { id: 15, body: blockBody, created_at: "2026-10-21T00:00:00Z", user: { login: "MotorUnitRoot" } },
      statusState: "failure",
    });
    assert(freshBlock.error == null && freshBlock.posts[0] === "failure", "BLOCK still posts when the comment is unchanged");

    const deletedBlock = await recheck("BLOCK", { missing: true });
    assert(deletedBlock.error instanceof Error && deletedBlock.error.message.includes("was deleted"), "a deleted BLOCK is not posted");
    assert(deletedBlock.posts.length === 0, "a deleted BLOCK sets no failure");

    const workflow = fs.readFileSync(new URL("../.github/workflows/independent-review-post.yml", import.meta.url), "utf8");
    const jobsAt = workflow.indexOf("\njobs:\n");
    assert(jobsAt > 0, "post workflow has jobs");
    assert(!/^concurrency:/m.test(workflow.slice(0, jobsAt)), "the workflow itself has no concurrency group");
    assert(
      workflow.includes(
        "group: independent-review-post-${{ needs.parse.outputs.pr }}-${{ needs.parse.outputs.verdict }}",
      ),
      "post concurrency is keyed by pull request and verdict",
    );
    assert(workflow.includes("cancel-in-progress: false"), "post concurrency does not cancel an in-progress job");
    assert(
      workflow.includes("environment: ${{ needs.parse.outputs.environment }}"),
      "the post environment comes from the parse job",
    );
    const summaryStep = workflow.split("- name: Record the verdict")[1].split("- name: Checkout")[0];
    const summaryScript = summaryStep.split("run: |")[1];
    assert(summaryScript && !summaryScript.includes("${{"), "the summary script does not inline action expressions");
    assert(summaryStep.includes("REVIEW_PR") && summaryStep.includes("REVIEW_VERDICT"), "the summary script reads env vars");

    console.log("post-review-verdict self-test ok");
  });
}

function httpError(status, message, headers) {
  const error = new Error(message);
  error.status = status;
  error.headers = headers;
  return error;
}

function memoryApi(head, token, { statuses = [], checkRuns = [], denyCheckWrite = false, listError = null, checkWriteError = null } = {}) {
  const state = {
    statuses: statuses.map((item) => ({ ...item })),
    checkRuns: checkRuns.map((item) => ({ ...item })),
    comments: [],
    posts: [],
    lookups: [],
  };
  const request = async (pathname, options) => {
    if (String(options.token) !== token) throw new Error("missing token");
    if (options.method === "GET" && pathname.includes("/pulls/")) return { head: { sha: head } };
    if (options.method === "GET" && pathname.includes("/check-runs")) {
      state.lookups.push(pathname);
      if (listError) throw listError;
      return { check_runs: state.checkRuns };
    }
    if (options.method === "POST" && pathname.endsWith("/check-runs")) {
      if (checkWriteError) throw checkWriteError;
      if (denyCheckWrite) throw httpError(403, "403 Resource not accessible by integration", {});
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
