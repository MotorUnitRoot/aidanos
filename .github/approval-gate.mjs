#!/usr/bin/env node
/**
 * Approval gate for aidanos main.
 *
 * The commit status context is "approval-gate". It is green only when
 * Colby (GitHub user id 146015017, type User) has, on the exact current
 * head:
 * - an approving review that is still his latest decisive review, or
 * - an unedited comment whose first line is
 *   "Independent review: PASS <40-hex head sha>"
 *   and performed_via_github_app is null.
 *
 * Any APPROVED review, PASS comment, or PASS line in a review body for
 * that head from a bot or an app turns the status red, even when Colby
 * also approved. A BLOCK comment for that head from anyone turns it red.
 * Bots cannot make it green.
 *
 * Colby's latest review includes dismissed reviews. Green from a review
 * requires that latest review to be APPROVED on the current head. An
 * older approval followed by a dismissed changes request stays red.
 * A failure this App already wrote for a BLOCK or a bot approval stays
 * red for that commit. Only a status whose creator is this App's bot
 * counts. The login is "<app slug>[bot]" from the token step. The bot
 * user id is optional until Colby sets APPROVAL_GATE_BOT_USER_ID.
 *
 * Each run judges the pull request that started it, plus other open
 * pull requests into main. The cheap check is one page of
 * GET /commits/{sha}/statuses (newest first, creator included).
 * Combined status is not used: its rows have no creator. The first
 * approval-gate row from this App's bot decides. Success is judged
 * again. Pending or red is left alone. A page of approval-gate rows
 * with none from this bot is judged anyway. A full page of 100 rows
 * with no approval-gate row from this bot is judged anyway, because
 * an older green can sit on the next page. A rate-limit error writes
 * pending "gate error" when that head is already known. The write uses
 * the same hourly allowance, so it only helps for a secondary limit.
 *
 * The Dependabot path is phase 2 and is off. There is no hardware-key
 * sign-off.
 *
 * This file does not read an App private key. The workflow mints a token
 * for the gate-only App and passes it as GITHUB_TOKEN. That token is not
 * Actions' default token and not the shared motorunit-aidanos-bots key.
 * Comment and title text is never passed to a shell.
 */
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import {
  BLOCK_PREFIX,
  attachEditHistory,
  commentKind,
  commentListComplete,
  commentWasEdited,
} from "./independent-review.mjs";

export const COLBY_USER_ID = 146015017;
export const SHARED_APP_ID = 5413571;
export const SHARED_APP_BOT_USER_ID = 345922838;
export const CURSOR_BOT_USER_ID = 206951365;
export const DEPENDABOT_BOT_USER_ID = 49699333;

// The machine account login is motorunitbots. Pin its numeric user id
// on the next line once it is known. Until then the gate matches the
// login only. Do not put a guessed id here, and do not match a null id.
export const MOTORUNIT_BOT_USER_ID = null;
export const NAMED_MACHINE_LOGINS = Object.freeze(["motorunitbots"]);

export const KNOWN_BOT_USER_IDS = Object.freeze([
  SHARED_APP_BOT_USER_ID,
  CURSOR_BOT_USER_ID,
  DEPENDABOT_BOT_USER_ID,
]);

// Phase 2 is not built. Leaving this false is the launch switch.
export const DEPENDABOT_PATH_ENABLED = false;

export const STATUS_CONTEXT = "approval-gate";
export const STATUS_DESCRIPTION_LIMIT = 140;

export function dependabotSecurityUpdate() {
  return false;
}

export function isColby(user) {
  if (!user || user.type !== "User") return false;
  return Number(user.id) === COLBY_USER_ID;
}

export function isMachine(user, viaApp) {
  if (viaApp != null) return true;
  if (!user) return false;
  if (user.type === "Bot") return true;
  const login = typeof user.login === "string" ? user.login : "";
  if (login.endsWith("[bot]")) return true;
  if (NAMED_MACHINE_LOGINS.includes(login)) return true;
  const id = Number(user.id);
  if (MOTORUNIT_BOT_USER_ID != null && id === Number(MOTORUNIT_BOT_USER_ID)) return true;
  if (KNOWN_BOT_USER_IDS.includes(id)) return true;
  return false;
}

function sameSha(left, right) {
  const a = String(left || "").toLowerCase();
  const b = String(right || "").toLowerCase();
  return /^[0-9a-f]{40}$/.test(a) && a === b;
}

function safeLogin(value) {
  const login = String(value || "");
  if (/^[A-Za-z0-9][A-Za-z0-9-]{0,38}(\[bot\])?$/.test(login)) return login;
  return "unknown";
}

function sourceLogin(user, viaApp) {
  if (viaApp && typeof viaApp.slug === "string" && viaApp.slug) return safeLogin(viaApp.slug);
  if (viaApp && typeof viaApp.name === "string" && viaApp.name) return safeLogin(viaApp.name);
  return safeLogin(user && user.login);
}

function clip(text) {
  const value = String(text || "");
  if (value.length <= STATUS_DESCRIPTION_LIMIT) return value;
  return value.slice(0, STATUS_DESCRIPTION_LIMIT);
}

function byTimeThenId(left, right) {
  const time = String(left.at || "").localeCompare(String(right.at || ""));
  if (time !== 0) return time;
  return Number(left.id || 0) - Number(right.id || 0);
}

function commentBodies(comment) {
  const bodies = [];
  if (comment && Array.isArray(comment.versions)) {
    for (const version of comment.versions) bodies.push(version && version.body);
  }
  if (comment) bodies.push(comment.body);
  return bodies;
}

function machineApprovals(reviews, comments, head) {
  const found = [];
  for (const review of reviews || []) {
    if (!review || !isMachine(review.user, review.performed_via_github_app)) continue;
    const approved = review.state === "APPROVED" && sameSha(review.commit_id, head);
    const passInBody = commentKind(review.body, head) === "pass";
    if (!approved && !passInBody) continue;
    found.push({
      login: sourceLogin(review.user, review.performed_via_github_app),
      at: review.submitted_at || "",
      id: review.id || 0,
    });
  }
  for (const comment of comments || []) {
    if (!comment || !isMachine(comment.user, comment.performed_via_github_app)) continue;
    const pass = commentBodies(comment).some((body) => commentKind(body, head) === "pass");
    if (!pass) continue;
    found.push({
      login: sourceLogin(comment.user, comment.performed_via_github_app),
      at: comment.created_at || "",
      id: comment.id || 0,
    });
  }
  found.sort(byTimeThenId);
  return found;
}

export function commentBlocks(comment, head) {
  if (!comment) return false;
  if (comment.historyUnavailable && isMachine(comment.user, comment.performed_via_github_app)) return true;
  return commentBodies(comment).some((body) => commentKind(body, head) === "block");
}

function blockFrom(comments, head) {
  const blocks = [];
  for (const comment of comments || []) {
    if (!commentBlocks(comment, head)) continue;
    blocks.push({
      login: sourceLogin(comment.user, comment.performed_via_github_app),
      at: comment.updated_at || comment.created_at || "",
      id: comment.id || 0,
    });
  }
  blocks.sort(byTimeThenId);
  return blocks;
}

function colbyReviews(reviews) {
  const rows = [];
  for (const review of reviews || []) {
    if (!review || !isColby(review.user)) continue;
    if (review.performed_via_github_app != null) continue;
    if (review.state !== "APPROVED" && review.state !== "CHANGES_REQUESTED" && review.state !== "DISMISSED") continue;
    rows.push(review);
  }
  rows.sort((left, right) => {
    const time = String(left.submitted_at || "").localeCompare(String(right.submitted_at || ""));
    if (time !== 0) return time;
    return Number(left.id || 0) - Number(right.id || 0);
  });
  return rows;
}

function colbyLatestDecisive(reviews) {
  const rows = colbyReviews(reviews);
  return rows.length ? rows[rows.length - 1] : null;
}

// Dismissing a review changes that review to DISMISSED and leaves older
// reviews in place. An older APPROVED must not become the latest again.
function dismissedChangesRequest(reviews) {
  const rows = colbyReviews(reviews);
  if (!rows.length) return false;
  const latest = rows[rows.length - 1];
  if (latest.state !== "DISMISSED") return false;
  return rows.slice(0, -1).some((review) => review.state === "APPROVED");
}

const STICKY_FAILURE_PREFIXES = Object.freeze(["Blocked: bot approval from ", "Blocked: BLOCK from "]);

// Empty means "not configured yet": match the bot login only.
// A non-empty value that is not a positive integer matches nothing.
export function parseGateBotUserId(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  if (!/^[1-9][0-9]*$/.test(raw)) return false;
  return Number(raw);
}

export function gateFromEnv(env = process.env) {
  return {
    slug: String((env && env.APPROVAL_GATE_APP_SLUG) || "").trim(),
    botUserId: parseGateBotUserId(env && env.APPROVAL_GATE_BOT_USER_ID),
  };
}

export function gateSlug(gate) {
  const slug = String((gate && gate.slug) || "").trim();
  if (!/^[a-z0-9][a-z0-9-]{0,38}$/.test(slug)) return "";
  return slug;
}

function creatorIsGate(creator, gate) {
  const slug = gateSlug(gate);
  if (!slug) return false;
  if (!creator || creator.type !== "Bot" || creator.login !== `${slug}[bot]`) return false;
  const botUserId = gate.botUserId;
  if (botUserId == null) return true;
  if (botUserId === false) return false;
  return Number(creator.id) === Number(botUserId);
}

function stickingFailure(statuses, gate) {
  for (const status of statuses || []) {
    if (!status || status.context !== STATUS_CONTEXT || status.state !== "failure") continue;
    if (!creatorIsGate(status.creator, gate)) continue;
    const description = String(status.description || "");
    if (!STICKY_FAILURE_PREFIXES.some((prefix) => description.startsWith(prefix))) continue;
    return {
      state: "failure",
      description: clip(description),
      reasons: ["sticky", description.startsWith("Blocked: bot approval from ") ? "bot-approval" : "block"],
    };
  }
  return null;
}

function colbyPassComments(comments, head) {
  const found = [];
  for (const comment of comments || []) {
    if (!comment || comment.deleted) continue;
    if (!isColby(comment.user)) continue;
    if (comment.performed_via_github_app != null) continue;
    if (!comment.created_at || comment.created_at !== comment.updated_at) continue;
    if (commentWasEdited(comment) || comment.historyUnavailable || comment.originalUnseen) continue;
    if (commentKind(comment.body, head) !== "pass") continue;
    found.push(comment);
  }
  return found;
}

/**
 * @returns {{state: "success"|"failure"|"pending"|null, description: string, reasons: string[], login?: string}}
 */
export function evaluate({ pr, reviews, comments, statuses, gate } = {}) {
  if (!pr || pr.state === "closed") {
    return { state: null, description: "", reasons: ["closed"] };
  }
  const head = pr.head && pr.head.sha;
  if (!/^[0-9a-fA-F]{40}$/.test(String(head || ""))) {
    return { state: null, description: "", reasons: ["bad-head"] };
  }
  if (!pr.base || pr.base.ref !== "main") {
    return { state: null, description: "", reasons: ["base"] };
  }
  const sha = String(head).toLowerCase();
  const short = sha.slice(0, 7);

  const machines = machineApprovals(reviews, comments, sha);
  if (machines.length) {
    const login = machines[0].login;
    return {
      state: "failure",
      description: clip(`Blocked: bot approval from ${login}`),
      reasons: ["bot-approval"],
      login,
    };
  }

  const blocks = blockFrom(comments, sha);
  if (blocks.length) {
    const login = blocks[0].login;
    return {
      state: "failure",
      description: clip(`Blocked: BLOCK from ${login}`),
      reasons: ["block"],
      login,
    };
  }

  const stuck = stickingFailure(statuses, gate);
  if (stuck) return stuck;

  const decisive = colbyLatestDecisive(reviews);
  if (dismissedChangesRequest(reviews)) {
    return {
      state: "failure",
      description: clip("Blocked: dismissed review"),
      reasons: ["dismissed"],
    };
  }
  if (decisive && decisive.state === "APPROVED" && sameSha(decisive.commit_id, sha)) {
    return {
      state: "success",
      description: clip(`Colby approved ${short}`),
      reasons: ["colby-review"],
    };
  }

  const passes = colbyPassComments(comments, sha);
  if (passes.length) {
    return {
      state: "success",
      description: clip(`Colby PASS ${short}`),
      reasons: ["colby-pass"],
    };
  }

  // Phase 2 stays off. dependabotSecurityUpdate() is a stub that
  // returns false, and the flag is false, so this cannot succeed.
  if (DEPENDABOT_PATH_ENABLED && dependabotSecurityUpdate()) {
    return {
      state: "success",
      description: clip("Dependabot security update approved"),
      reasons: ["dependabot"],
    };
  }

  return {
    state: "pending",
    description: clip(`Waiting for Colby on ${short}`),
    reasons: ["waiting"],
  };
}

export async function listAll(fetchPage) {
  const items = [];
  for (let page = 1; ; page += 1) {
    const batch = await fetchPage(page);
    if (!Array.isArray(batch)) throw new Error("page is not a list");
    items.push(...batch);
    if (commentListComplete(page, batch.length)) return items;
  }
}

export async function prepareComments(comments, event, listEditsFn, log = () => {}) {
  const list = [...(comments || [])];
  if (event && event.action === "deleted" && event.comment) {
    const deleted = { ...event.comment, deleted: true };
    const already = deleted.id != null && list.some((item) => item && item.id === deleted.id);
    if (!already) list.push(deleted);
  }
  for (const comment of list) {
    if (!commentWasEdited(comment)) {
      comment.versions = [{ body: comment && comment.body, at: comment && comment.created_at }];
      continue;
    }
    try {
      if (!comment.node_id) throw new Error("edited comment has no node id");
      attachEditHistory(comment, await listEditsFn(comment.node_id));
    } catch (error) {
      comment.historyUnavailable = true;
      log(`Could not read edit history for comment ${comment && comment.id ? comment.id : "unknown"}.`);
    }
  }
  return list;
}

export async function judgeAndWrite({
  prNumber,
  advisory = false,
  readPull,
  readReviews,
  readComments,
  readStatuses = async () => [],
  writeStatus,
  gate = {},
  knownSha = null,
  writeErrorWithoutHead = false,
}) {
  let judgedSha = null;
  try {
    const pr = await readPull(prNumber);
    const early = evaluate({ pr, reviews: [], comments: [], statuses: [] });
    if (!pr || early.reasons[0] === "closed" || early.reasons[0] === "bad-head" || early.reasons[0] === "base") {
      return { wrote: false, reason: early.reasons[0] || "skip", result: early, judgedSha: null };
    }
    judgedSha = String(pr.head.sha).toLowerCase();
    if (!advisory && !gateSlug(gate)) {
      await writeStatus({
        sha: judgedSha,
        state: "pending",
        description: "gate error",
        context: STATUS_CONTEXT,
      });
      return {
        wrote: true,
        reason: "missing-slug",
        result: { state: "pending", description: "gate error", reasons: ["missing-slug"] },
        judgedSha,
      };
    }
    const reviews = await readReviews(prNumber);
    const comments = await readComments(prNumber);
    const statuses = await readStatuses(judgedSha);
    let result = evaluate({ pr, reviews, comments, statuses, gate });
    if (advisory) return { wrote: false, reason: "advisory", result, judgedSha };
    const fresh = await readPull(prNumber);
    const freshSha = fresh && fresh.head && fresh.head.sha;
    if (!sameSha(freshSha, judgedSha)) {
      return { wrote: false, reason: "head-moved", result, judgedSha };
    }
    const freshReviews = await readReviews(prNumber);
    const freshComments = await readComments(prNumber);
    const freshStatuses = await readStatuses(judgedSha);
    result = evaluate({ pr: fresh, reviews: freshReviews, comments: freshComments, statuses: freshStatuses, gate });
    if (!result.state) return { wrote: false, reason: result.reasons[0] || "skip", result, judgedSha };
    await writeStatus({
      sha: judgedSha,
      state: result.state,
      description: result.description,
      context: STATUS_CONTEXT,
    });
    return { wrote: true, reason: "wrote", result, judgedSha };
  } catch (error) {
    const fallbackSha = judgedSha || ((writeErrorWithoutHead || isRateLimitError(error)) ? validHeadSha(knownSha) : null);
    if (!advisory && fallbackSha && writeStatus) {
      try {
        await writeStatus({
          sha: fallbackSha,
          state: "pending",
          description: "gate error",
          context: STATUS_CONTEXT,
        });
      } catch {
        // The original error is the one that failed the run.
      }
    }
    throw error;
  }
}

export function validHeadSha(value) {
  const sha = String(value || "");
  if (!/^[0-9a-fA-F]{40}$/.test(sha)) return null;
  return sha.toLowerCase();
}

export function headShaOf(pr) {
  return validHeadSha(pr && pr.head && pr.head.sha);
}

// The head comes from the event payload GitHub already stored. A comment
// body is not a commit id, even when it contains one.
export function headShaFromEvent(eventName, event) {
  if (eventName === "pull_request" || eventName === "pull_request_target") {
    return headShaOf(event && event.pull_request);
  }
  if (eventName === "workflow_run") {
    return validHeadSha(event && event.workflow_run && event.workflow_run.head_sha);
  }
  return null;
}

function headerValue(headers, name) {
  if (!headers) return "";
  const raw = typeof headers.get === "function" ? headers.get(name) : headers[name];
  if (raw == null) return "";
  return String(raw).trim();
}

// 403 and 429 are the rate-limit statuses. A used-up allowance also
// reports x-ratelimit-remaining 0, including on another status code.
export function isRateLimitError(error) {
  if (!error || typeof error !== "object") return false;
  const status = Number(error.status);
  if (status === 403 || status === 429) return true;
  return headerValue(error.headers, "x-ratelimit-remaining") === "0";
}

// One page of GET /commits/{sha}/statuses, newest first. Each row has a
// creator. Combined status (GET /commits/{sha}/status) does not, so a
// combined-status object is not a selection input.
// The first approval-gate row from the gate bot is that bot's latest
// status on the page. Success is re-judged. Anything else from the gate
// bot already blocks. Approval-gate rows from anyone else, with no gate
// bot row on the page, are judged anyway: the gate's own green may be
// the required check and this page cannot see it.
export function statusPageNeedsJudge(page, gate) {
  if (!Array.isArray(page)) return false;
  let sawApprovalGate = false;
  for (const status of page) {
    if (!status || status.context !== STATUS_CONTEXT) continue;
    sawApprovalGate = true;
    if (!creatorIsGate(status.creator, gate)) continue;
    return status.state === "success";
  }
  if (sawApprovalGate) return true;
  // per_page=100. A full page of other contexts can hide the gate bot's
  // older success on the next page, so that pull request is judged too.
  return page.length >= 100;
}

function openMainPulls(pulls) {
  const rows = [];
  for (const pr of pulls) {
    if (!pr || pr.state !== "open" || !pr.base || pr.base.ref !== "main") continue;
    const number = Number(pr.number);
    if (!Number.isInteger(number) || number <= 0) continue;
    rows.push({ number, sha: headShaOf(pr) });
  }
  return rows;
}

export async function judgeRelevantPulls({
  listPulls,
  readStatusPage,
  judgeOne,
  writeGateError,
  triggering = null,
  triggeringSha = null,
  advisory = false,
  gate = {},
}) {
  const outcomes = [];
  const errors = [];
  const selected = [];
  const triggerSha = validHeadSha(triggeringSha);
  const trigger = Number(triggering);
  const triggerIsNumber = Number.isInteger(trigger) && trigger > 0;

  async function judgeNumber(number, knownSha, writeErrorWithoutHead) {
    selected.push(number);
    try {
      outcomes.push({ number, outcome: await judgeOne(number, { knownSha, writeErrorWithoutHead }) });
    } catch (error) {
      errors.push({ number, error });
    }
  }

  async function protectSha(number, sha, error) {
    if (sha && writeGateError) {
      try {
        await writeGateError(sha);
      } catch (writeError) {
        errors.push({ number, error: writeError });
        return;
      }
    }
    errors.push({ number, error });
  }

  if (advisory) {
    if (!triggerIsNumber) return { outcomes, errors, selected, listFailed: false, listError: null };
    await judgeNumber(trigger, triggerSha, false);
    return { outcomes, errors, selected, listFailed: false, listError: null };
  }

  let pulls;
  try {
    pulls = await listPulls();
    if (!Array.isArray(pulls)) throw new Error("pull list is not a list");
  } catch (error) {
    if (!triggerIsNumber) {
      if (triggerSha) await protectSha(null, triggerSha, error);
      else errors.push({ number: null, error });
      return { outcomes, errors, selected, listFailed: true, listError: error };
    }
    await judgeNumber(trigger, triggerSha, true);
    return { outcomes, errors, selected, listFailed: true, listError: error };
  }

  const openMain = openMainPulls(pulls);
  if (triggerIsNumber) {
    const listed = openMain.find((item) => item.number === trigger);
    await judgeNumber(trigger, (listed && listed.sha) || triggerSha, false);
  }

  let rateLimited = errors.some((item) => isRateLimitError(item.error));
  for (const item of openMain) {
    if (triggerIsNumber && item.number === trigger) continue;
    if (!item.sha) continue;
    if (rateLimited) {
      await protectSha(item.number, item.sha, new Error("rate limit"));
      continue;
    }
    let page;
    try {
      page = await readStatusPage(item.sha);
    } catch (error) {
      if (isRateLimitError(error)) {
        rateLimited = true;
        await protectSha(item.number, item.sha, error);
        continue;
      }
      errors.push({ number: item.number, error });
      continue;
    }
    if (!statusPageNeedsJudge(page, gate)) continue;
    await judgeNumber(item.number, item.sha, false);
    const latest = errors[errors.length - 1];
    if (latest && latest.number === item.number && isRateLimitError(latest.error)) rateLimited = true;
  }

  return { outcomes, errors, selected, listFailed: false, listError: null };
}

export function pullNumberFromEvent(eventName, event, envPr) {
  if (eventName === "workflow_dispatch") {
    const value = String(envPr || "").trim();
    if (!/^[1-9][0-9]*$/.test(value)) return { number: null, reason: "bad-pr" };
    return { number: Number(value) };
  }
  if (eventName === "pull_request" || eventName === "pull_request_target") {
    const number = event && event.pull_request && event.pull_request.number;
    return number ? { number } : { number: null, reason: "missing-pr" };
  }
  if (eventName === "issue_comment") {
    if (!(event && event.issue && event.issue.pull_request)) return { number: null, reason: "not-pr" };
    return { number: event.issue.number };
  }
  if (eventName === "workflow_run") {
    const prs = event && event.workflow_run && event.workflow_run.pull_requests;
    const number = prs && prs[0] && prs[0].number;
    if (number) return { number };
    const headSha = event && event.workflow_run && event.workflow_run.head_sha;
    return { number: null, headSha: headSha || null, reason: headSha ? "lookup" : "missing-pr" };
  }
  return { number: null, reason: "event" };
}

export function summaryText(outcome) {
  const result = outcome && outcome.result;
  const lines = [
    `Judged SHA: ${outcome && outcome.judgedSha ? outcome.judgedSha : "(none)"}`,
    `Result: ${result && result.state ? result.state : outcome && outcome.reason}`,
  ];
  if (result && result.description) lines.push(result.description);
  if (outcome && outcome.wrote) lines.push(`Status write: approval-gate on ${outcome.judgedSha}`);
  else lines.push(`Status write: no (${outcome && outcome.reason ? outcome.reason : "skip"})`);
  return lines.join("\n");
}

export function runScriptBodies(text) {
  const lines = String(text || "").split(/\n/);
  const scripts = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const match = /^(\s*)run:\s*(.*)$/.exec(line);
    if (!match) continue;
    const indent = match[1].length;
    const rest = match[2];
    if (rest === "|" || rest === "|-" || rest === "|+" || rest === ">" || rest === ">-" || rest === ">+") {
      const body = [];
      for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
        const next = lines[cursor];
        if (next.trim() === "") {
          body.push(next);
          continue;
        }
        const nextIndent = /^(\s*)/.exec(next)[1].length;
        if (nextIndent <= indent) break;
        body.push(next);
      }
      scripts.push(body.join("\n"));
    } else {
      scripts.push(rest);
    }
  }
  return scripts;
}

const FORBIDDEN_WORKFLOW_SNIPPETS = [
  "github.event.pull_request.head",
  "github.event.pull_request.title",
  "github.event.pull_request.body",
  "github.event.issue.title",
  "github.event.issue.body",
  "github.head_ref",
];

// Comment text may appear in a job `if` (GitHub evaluates it, not a shell).
// It must never appear inside a run script.
const FORBIDDEN_RUN_SNIPPETS = ["github.event.comment.body", "github.event.changes.body.from"];

export function lintWorkflow(name, text) {
  const errors = [];
  const source = String(text || "");
  for (const script of runScriptBodies(source)) {
    if (script.includes("${{")) errors.push(`${name} interpolates an expression inside run`);
    for (const snippet of FORBIDDEN_RUN_SNIPPETS) {
      if (script.includes(snippet)) errors.push(`${name} run script contains ${snippet}`);
    }
  }
  const uses = source.matchAll(/^\s*uses:\s*['"]?([^'"\s#]+)/gm);
  for (const match of uses) {
    const spec = match[1];
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+@[0-9a-f]{40}$/.test(spec)) {
      errors.push(`${name} action is not pinned to a full commit: ${spec}`);
    }
  }
  for (const snippet of FORBIDDEN_WORKFLOW_SNIPPETS) {
    if (source.includes(snippet)) errors.push(`${name} contains ${snippet}`);
  }
  if (source.includes("pull_request_target:")) {
    if (!source.includes("ref: ${{ github.sha }}")) {
      errors.push(`${name} pull_request_target checkout is not pinned to github.sha`);
    }
    if (!source.includes("persist-credentials: false")) {
      errors.push(`${name} checkout keeps credentials`);
    }
  }
  return errors;
}

export function scrubToken(text, token) {
  const source = String(text ?? "");
  if (!token) return source;
  return source.split(token).join("[redacted]");
}

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

export async function selfTest() {
  const sha = "a".repeat(40);
  const other = "b".repeat(40);
  const t0 = "2026-10-24T00:00:00Z";
  const t1 = "2026-10-24T00:00:01Z";
  const t2 = "2026-10-24T00:00:02Z";
  const colby = { login: "MotorUnitRoot", id: COLBY_USER_ID, type: "User" };
  const appBot = { login: "motorunit-aidanos-bots[bot]", id: SHARED_APP_BOT_USER_ID, type: "Bot" };
  const cursorBot = { login: "cursor[bot]", id: CURSOR_BOT_USER_ID, type: "Bot" };
  const gateBot = { login: "motorunit-approval-gate[bot]", id: 999001, type: "Bot" };
  const open = { state: "open", base: { ref: "main" }, head: { sha } };

  function review(user, state, commit, extra) {
    return {
      id: 1,
      user,
      state,
      commit_id: commit,
      submitted_at: t0,
      ...extra,
    };
  }
  function note(body, user, extra) {
    return {
      id: 1,
      body,
      user,
      created_at: t0,
      updated_at: t0,
      performed_via_github_app: null,
      ...extra,
    };
  }
  function judge(reviews, comments, pr) {
    return evaluate({ pr: pr || open, reviews, comments });
  }

  const fixtures = [
    ["Colby approval on head", [review(colby, "APPROVED", sha)], [], "success", `Colby approved ${sha.slice(0, 7)}`],
    ["stale approval on an old sha", [review(colby, "APPROVED", other)], [], "pending", `Waiting for Colby on ${sha.slice(0, 7)}`],
    [
      "approval then changes requested",
      [review(colby, "APPROVED", sha, { id: 1, submitted_at: t0 }), review(colby, "CHANGES_REQUESTED", sha, { id: 2, submitted_at: t1 })],
      [],
      "pending",
      `Waiting for Colby on ${sha.slice(0, 7)}`,
    ],
    [
      "changes requested then a later approval",
      [review(colby, "CHANGES_REQUESTED", sha, { id: 1, submitted_at: t0 }), review(colby, "APPROVED", sha, { id: 2, submitted_at: t1 })],
      [],
      "success",
      `Colby approved ${sha.slice(0, 7)}`,
    ],
    ["dismissed approval", [review(colby, "DISMISSED", sha)], [], "pending", `Waiting for Colby on ${sha.slice(0, 7)}`],
    [
      "approve, request changes, dismiss",
      [review(colby, "APPROVED", sha, { id: 1, submitted_at: t0 }), review(colby, "DISMISSED", sha, { id: 2, submitted_at: t1 })],
      [],
      "failure",
      "Blocked: dismissed review",
    ],
    [
      "a PASS comment does not restore a dismissed changes request",
      [review(colby, "APPROVED", sha, { id: 1, submitted_at: t0 }), review(colby, "DISMISSED", sha, { id: 2, submitted_at: t1 })],
      [note(`Independent review: PASS ${sha}`, colby)],
      "failure",
      "Blocked: dismissed review",
    ],
    [
      "a new approval after a dismissed changes request",
      [
        review(colby, "APPROVED", sha, { id: 1, submitted_at: t0 }),
        review(colby, "DISMISSED", sha, { id: 2, submitted_at: t1 }),
        review(colby, "APPROVED", sha, { id: 3, submitted_at: t2 }),
      ],
      [],
      "success",
      `Colby approved ${sha.slice(0, 7)}`,
    ],
    ["PASS for the exact head", [], [note(`Independent review: PASS ${sha}`, colby)], "success", `Colby PASS ${sha.slice(0, 7)}`],
    ["PASS with a leading space and a note", [], [note(`  Independent review: PASS ${sha}\nlooks good`, colby)], "success", `Colby PASS ${sha.slice(0, 7)}`],
    ["PASS with a short sha", [], [note(`Independent review: PASS ${sha.slice(0, 7)}`, colby)], "pending", null],
    ["PASS with the wrong sha", [], [note(`Independent review: PASS ${other}`, colby)], "pending", null],
    ["PASS with the sha only on the second line", [], [note(`Independent review: PASS\n${sha}`, colby)], "pending", null],
    ["edited PASS", [], [note(`Independent review: PASS ${sha}`, colby, { updated_at: t1, originalUnseen: true })], "pending", null],
    ["deleted PASS", [], [note(`Independent review: PASS ${sha}`, colby, { deleted: true })], "pending", null],
    [
      "PASS made through an app",
      [],
      [note(`Independent review: PASS ${sha}`, colby, { performed_via_github_app: { id: 1210556, slug: "cursor" } })],
      "failure",
      "Blocked: bot approval from cursor",
    ],
    [
      "look-alike login with another id",
      [],
      [note(`Independent review: PASS ${sha}`, { login: "MotorUnitRoot", id: 999, type: "User" })],
      "pending",
      null,
    ],
    [
      "look-alike login with type Bot",
      [],
      [note(`Independent review: PASS ${sha}`, { login: "MotorUnitRoot", id: COLBY_USER_ID, type: "Bot" })],
      "failure",
      "Blocked: bot approval from MotorUnitRoot",
    ],
    ["Colby matched by id when the login differs", [review({ login: "renamed-colby", id: String(COLBY_USER_ID), type: "User" }, "APPROVED", sha)], [], "success", null],
    ["shared App approval", [review(appBot, "APPROVED", sha)], [], "failure", "Blocked: bot approval from motorunit-aidanos-bots[bot]"],
    ["motorunitbots approval", [review({ login: "motorunitbots", type: "User" }, "APPROVED", sha)], [], "failure", "Blocked: bot approval from motorunitbots"],
    ["cursor bot approval", [review(cursorBot, "APPROVED", sha)], [], "failure", "Blocked: bot approval from cursor[bot]"],
    ["future gate App approval", [review(gateBot, "APPROVED", sha)], [], "failure", "Blocked: bot approval from motorunit-approval-gate[bot]"],
    [
      "bot approval plus Colby approval",
      [review(colby, "APPROVED", sha, { id: 1 }), review(appBot, "APPROVED", sha, { id: 2, submitted_at: t1 })],
      [],
      "failure",
      "Blocked: bot approval from motorunit-aidanos-bots[bot]",
    ],
    [
      "a later bot changes-requested does not clear its approval",
      [
        review(appBot, "APPROVED", sha, { id: 1, submitted_at: t0 }),
        review(appBot, "CHANGES_REQUESTED", sha, { id: 2, submitted_at: t1 }),
        review(colby, "APPROVED", sha, { id: 3, submitted_at: t2 }),
      ],
      [],
      "failure",
      "Blocked: bot approval from motorunit-aidanos-bots[bot]",
    ],
    [
      "App PASS plus Colby PASS",
      [],
      [note(`Independent review: PASS ${sha}`, colby, { id: 1 }), note(`Independent review: PASS ${sha}`, appBot, { id: 2 })],
      "failure",
      "Blocked: bot approval from motorunit-aidanos-bots[bot]",
    ],
    [
      "dismissed bot approval does not trip",
      [review(cursorBot, "DISMISSED", sha, { id: 1 }), review(colby, "APPROVED", sha, { id: 2 })],
      [],
      "success",
      null,
    ],
    [
      "bot approval of an older sha does not trip",
      [review(cursorBot, "APPROVED", other, { id: 1 }), review(colby, "APPROVED", sha, { id: 2 })],
      [],
      "success",
      null,
    ],
    [
      "bot PASS in a review body",
      [
        review(colby, "APPROVED", sha, { id: 1 }),
        review(cursorBot, "COMMENTED", sha, { id: 2, submitted_at: t1, body: `Independent review: PASS ${sha}` }),
      ],
      [],
      "failure",
      "Blocked: bot approval from cursor[bot]",
    ],
    [
      "bot PASS in a review body for another sha",
      [
        review(colby, "APPROVED", sha, { id: 1 }),
        review(cursorBot, "COMMENTED", other, { id: 2, body: `Independent review: PASS ${other}` }),
      ],
      [],
      "success",
      null,
    ],
    [
      "Colby PASS in a review body is not a comment",
      [review(colby, "COMMENTED", sha, { body: `Independent review: PASS ${sha}` })],
      [],
      "pending",
      null,
    ],
    [
      "BLOCK after PASS",
      [],
      [
        note(`Independent review: PASS ${sha}`, colby, { id: 1, created_at: t0, updated_at: t0 }),
        note(`Independent review: BLOCK ${sha}`, colby, { id: 2, created_at: t1, updated_at: t1 }),
      ],
      "failure",
      "Blocked: BLOCK from MotorUnitRoot",
    ],
    [
      "BLOCK before PASS",
      [],
      [
        note("Independent review: BLOCK", colby, { id: 1, created_at: t0, updated_at: t0 }),
        note(`Independent review: PASS ${sha}`, colby, { id: 2, created_at: t1, updated_at: t1 }),
      ],
      "failure",
      null,
    ],
    [
      "BLOCK and PASS at the same time",
      [],
      [
        note(`Independent review: PASS ${sha}`, colby, { id: 1 }),
        note(`Independent review: BLOCK ${sha}`, colby, { id: 2 }),
      ],
      "failure",
      null,
    ],
    [
      "App BLOCK still blocks Colby",
      [review(colby, "APPROVED", sha)],
      [note(`Independent review: BLOCK ${sha}`, appBot)],
      "failure",
      "Blocked: BLOCK from motorunit-aidanos-bots[bot]",
    ],
    [
      "a BLOCK from any reviewer",
      [review(colby, "APPROVED", sha)],
      [note(`Independent review: BLOCK ${sha}`, { login: "octocat", id: 1, type: "User" })],
      "failure",
      "Blocked: BLOCK from octocat",
    ],
    [
      "a BLOCK for another sha does not block this head",
      [review(colby, "APPROVED", sha)],
      [note(`Independent review: BLOCK ${other}`, colby)],
      "success",
      null,
    ],
    [
      "an ordinary comment made through an app",
      [review(colby, "APPROVED", sha)],
      [note("Ship it", { login: "someone", id: 7, type: "User" }, { performed_via_github_app: { id: 1210556, slug: "cursor" } })],
      "success",
      null,
    ],
    [
      "injection on its own line",
      [],
      [note("$(rm -rf /)\n`id`\nIndependent review: PASS " + sha, colby)],
      "pending",
      `Waiting for Colby on ${sha.slice(0, 7)}`,
    ],
    [
      "injection after a real PASS",
      [],
      [note(`Independent review: PASS ${sha}\n$(reboot)\n\`id\``, colby)],
      "success",
      `Colby PASS ${sha.slice(0, 7)}`,
    ],
  ];

  for (const [name, reviews, comments, want, description] of fixtures) {
    const got = judge(reviews, comments);
    assert(got.state === want, `${name}: got ${got.state} (${got.description}), want ${want}`);
    if (description) assert(got.description === description, `${name}: description ${got.description}`);
    assert(!got.description.includes("$("), `${name}: description contains a command substitution`);
    assert(!got.description.includes("`"), `${name}: description contains a backtick`);
    assert(!got.description.includes("\n"), `${name}: description contains a newline`);
  }

  const hostileLogin = judge([], [note(`Independent review: BLOCK ${sha}`, { login: "$(rm)", id: 5, type: "User" })]);
  assert(
    hostileLogin.state === "failure" && hostileLogin.description === "Blocked: BLOCK from unknown",
    "a hostile login is not copied into the status",
  );
  assert(!hostileLogin.description.includes("$("), "the hostile login is not a command");

  const renamed = judge(
    [review({ login: "not-colby", id: COLBY_USER_ID, type: "User" }, "APPROVED", sha.toUpperCase())],
    [],
  );
  assert(renamed.state === "success" && renamed.reasons[0] === "colby-review", "uppercase head sha still matches Colby");

  const phase2 = evaluate({
    pr: {
      ...open,
      user: { login: "dependabot[bot]", id: DEPENDABOT_BOT_USER_ID, type: "Bot" },
    },
    reviews: [review(appBot, "APPROVED", sha)],
    comments: [],
    commits: [{ verification: { verified: true } }],
    activity: [{ actor: "dependabot[bot]" }],
    alerts: [{ package: "example" }],
    checks: [{ name: "tests", state: "success" }],
    config: { dependabotEnabled: true },
  });
  assert(DEPENDABOT_PATH_ENABLED === false, "dependabot path is off");
  assert(dependabotSecurityUpdate() === false, "dependabot stub never approves");
  assert(phase2.state === "failure" && phase2.reasons[0] === "bot-approval", "phase 2 cannot turn an App approval green");

  assert(evaluate({ pr: { state: "closed", head: { sha }, base: { ref: "main" } } }).state === null, "a closed pull request writes nothing");
  assert(evaluate({ pr: { state: "open", head: { sha: "abc" }, base: { ref: "main" } } }).reasons[0] === "bad-head", "a short head is not judged");
  assert(evaluate({ pr: { state: "open", head: { sha }, base: { ref: "feature" } } }).reasons[0] === "base", "only main is gated");

  const page2 = await listAll(async (page) => {
    if (page === 1) {
      return Array.from({ length: 100 }, (_, index) =>
        review({ login: "octocat", id: 50 + index, type: "User" }, "COMMENTED", sha, { id: index + 1 }),
      );
    }
    if (page === 2) return [review(colby, "APPROVED", sha, { id: 500 })];
    return [];
  });
  assert(page2.length === 101, "pagination keeps the second page");
  assert(judge(page2, []).state === "success", "Colby's approval on page 2 of reviews counts");

  const commentPage = await listAll(async (page) => {
    if (page === 1) return Array.from({ length: 100 }, (_, index) => note("thanks", { login: "octocat", id: index + 2, type: "User" }, { id: index + 1 }));
    if (page === 2) return [note(`Independent review: PASS ${sha}`, colby, { id: 250 })];
    return [];
  });
  assert(judge([], commentPage).state === "success", "Colby's PASS on page 2 of comments counts");

  const testGate = { slug: "motorunit-approval-gate", botUserId: null };
  let pulls = 0;
  const movedWrites = [];
  const moved = await judgeAndWrite({
    prNumber: 12,
    gate: testGate,
    readPull: async () => {
      pulls += 1;
      return { state: "open", base: { ref: "main" }, head: { sha: pulls === 1 ? sha : other } };
    },
    readReviews: async () => [review(colby, "APPROVED", sha)],
    readComments: async () => [],
    writeStatus: async (body) => {
      movedWrites.push(body);
    },
  });
  assert(moved.wrote === false && moved.reason === "head-moved", "a moved head does not write");
  assert(movedWrites.length === 0, "a moved head posts no status");
  assert(moved.judgedSha === sha, "the judged sha stays the sha that was evaluated");

  const stableWrites = [];
  const stable = await judgeAndWrite({
    prNumber: 12,
    gate: testGate,
    readPull: async () => open,
    readReviews: async () => [review(colby, "APPROVED", sha, { id: 7 })],
    readComments: async () => [],
    writeStatus: async (body) => {
      stableWrites.push(body);
    },
  });
  assert(stable.wrote === true && stableWrites.length === 1, "a stable head writes one status");
  assert(stableWrites[0].sha === sha, "the status is written only to the judged sha");
  assert(stableWrites[0].context === STATUS_CONTEXT && stableWrites[0].state === "success", "the status is approval-gate success");
  assert(stableWrites[0].description === `Colby approved ${sha.slice(0, 7)}`, "the written description is the judged one");

  const waitingWrites = [];
  const waiting = await judgeAndWrite({
    prNumber: 12,
    gate: testGate,
    readPull: async () => open,
    readReviews: async () => [],
    readComments: async () => [],
    writeStatus: async (body) => {
      waitingWrites.push(body);
    },
  });
  assert(waiting.wrote === true && waitingWrites.length === 1 && waitingWrites[0].state === "pending", "waiting writes one pending status");
  assert(waitingWrites[0].sha === sha && waitingWrites[0].context === STATUS_CONTEXT, "waiting is written to the judged sha");
  assert(waitingWrites[0].description === `Waiting for Colby on ${sha.slice(0, 7)}`, "waiting description");

  const redWrites = [];
  const red = await judgeAndWrite({
    prNumber: 12,
    gate: testGate,
    readPull: async () => open,
    readReviews: async () => [review(appBot, "APPROVED", sha)],
    readComments: async () => [note(`Independent review: PASS ${sha}`, colby)],
    writeStatus: async (body) => {
      redWrites.push(body);
    },
  });
  assert(red.wrote === true && redWrites[0].state === "failure", "a bot approval writes failure");
  assert(redWrites[0].sha === sha && redWrites[0].description === "Blocked: bot approval from motorunit-aidanos-bots[bot]", "failure stays on the judged sha");

  const advisoryWrites = [];
  const advisory = await judgeAndWrite({
    prNumber: 12,
    advisory: true,
    readPull: async () => open,
    readReviews: async () => [review(colby, "APPROVED", sha)],
    readComments: async () => [],
    writeStatus: async (body) => {
      advisoryWrites.push(body);
    },
  });
  assert(advisory.wrote === false && advisory.reason === "advisory" && advisoryWrites.length === 0, "advisory mode does not write");

  const closedWrites = [];
  const closed = await judgeAndWrite({
    prNumber: 12,
    readPull: async () => ({ state: "closed", base: { ref: "main" }, head: { sha } }),
    readReviews: async () => {
      throw new Error("should not list reviews");
    },
    readComments: async () => [],
    writeStatus: async (body) => {
      closedWrites.push(body);
    },
  });
  assert(closed.wrote === false && closed.reason === "closed" && closedWrites.length === 0, "a closed pull request does not write");

  let reviewReads = 0;
  const overlapWrites = [];
  const overlap = await judgeAndWrite({
    prNumber: 12,
    gate: testGate,
    readPull: async () => open,
    readReviews: async () => {
      reviewReads += 1;
      if (reviewReads === 1) return [review(colby, "APPROVED", sha, { id: 1 })];
      return [review(colby, "APPROVED", sha, { id: 1 }), review(appBot, "APPROVED", sha, { id: 2, submitted_at: t1 })];
    },
    readComments: async () => [],
    readStatuses: async () => [],
    writeStatus: async (body) => {
      overlapWrites.push(body);
    },
  });
  assert(reviewReads === 2, "reviews are read again immediately before the write");
  assert(overlap.wrote === true && overlapWrites.length === 1, "the second read is what gets written");
  assert(
    overlapWrites[0].state === "failure" &&
      overlapWrites[0].description === "Blocked: bot approval from motorunit-aidanos-bots[bot]" &&
      overlapWrites[0].sha === sha,
    "a bot approval that arrives before the write replaces the green",
  );

  const gate = { slug: "motorunit-approval-gate", botUserId: null };
  const gateCreator = { login: "motorunit-approval-gate[bot]", id: 999001, type: "Bot" };
  function gateFailure(description, creator) {
    return { context: STATUS_CONTEXT, state: "failure", description, creator: creator || gateCreator };
  }
  const stuckBlock = evaluate({
    pr: open,
    reviews: [review(colby, "APPROVED", sha)],
    comments: [],
    statuses: [gateFailure("Blocked: BLOCK from octocat")],
    gate,
  });
  assert(
    stuckBlock.state === "failure" && stuckBlock.description === "Blocked: BLOCK from octocat" && stuckBlock.reasons[0] === "sticky",
    "a deleted BLOCK stays red from the gate's earlier failure",
  );
  const stuckBot = evaluate({
    pr: open,
    reviews: [review(colby, "APPROVED", sha)],
    comments: [],
    statuses: [gateFailure("Blocked: bot approval from cursor[bot]")],
    gate,
  });
  assert(stuckBot.state === "failure" && stuckBot.reasons.includes("bot-approval"), "an earlier bot-approval failure stays red");
  const foreignBlock = evaluate({
    pr: open,
    reviews: [review(colby, "APPROVED", sha)],
    comments: [],
    statuses: [gateFailure("Blocked: BLOCK from octocat", { login: "motorunit-aidanos-bots[bot]", id: SHARED_APP_BOT_USER_ID, type: "Bot" })],
    gate,
  });
  assert(foreignBlock.state === "success", "a failure written by the shared App does not stick");
  const actionsBlock = evaluate({
    pr: open,
    reviews: [review(colby, "APPROVED", sha)],
    comments: [],
    statuses: [gateFailure("Blocked: BLOCK from octocat", { login: "github-actions[bot]", id: 41898282, type: "Bot" })],
    gate,
  });
  assert(actionsBlock.state === "success", "a failure written by the Actions token does not stick");
  const matchedId = evaluate({
    pr: open,
    reviews: [review(colby, "APPROVED", sha)],
    comments: [],
    statuses: [gateFailure("Blocked: BLOCK from octocat")],
    gate: { slug: "motorunit-approval-gate", botUserId: 999001 },
  });
  assert(matchedId.state === "failure", "a configured bot user id sticks when it matches the creator");
  const otherId = evaluate({
    pr: open,
    reviews: [review(colby, "APPROVED", sha)],
    comments: [],
    statuses: [gateFailure("Blocked: BLOCK from octocat")],
    gate: { slug: "motorunit-approval-gate", botUserId: 111 },
  });
  assert(otherId.state === "success", "a matching login with a different bot id does not stick");
  const humanCreator = evaluate({
    pr: open,
    reviews: [review(colby, "APPROVED", sha)],
    comments: [],
    statuses: [gateFailure("Blocked: BLOCK from octocat", { login: "motorunit-approval-gate[bot]", id: 999001, type: "User" })],
    gate,
  });
  assert(humanCreator.state === "success", "a creator that is not a bot does not stick");
  assert(parseGateBotUserId("") === null && parseGateBotUserId("999001") === 999001, "an empty bot id stays unset and a number is kept");
  assert(parseGateBotUserId("nope") === false, "a bot id that is not a number matches nothing");
  const badId = evaluate({
    pr: open,
    reviews: [review(colby, "APPROVED", sha)],
    comments: [],
    statuses: [gateFailure("Blocked: BLOCK from octocat")],
    gate: { slug: "motorunit-approval-gate", botUserId: parseGateBotUserId("12abc") },
  });
  assert(badId.state === "success", "a malformed bot id does not stick a failure");
  const otherContext = evaluate({
    pr: open,
    reviews: [review(colby, "APPROVED", sha)],
    comments: [],
    statuses: [{ context: "independent-review/approved", state: "failure", description: "Blocked: BLOCK from octocat", creator: gateCreator }],
    gate,
  });
  assert(otherContext.state === "success", "a failure on another context does not stick");
  const priorSuccess = evaluate({
    pr: open,
    reviews: [],
    comments: [],
    statuses: [{ context: STATUS_CONTEXT, state: "success", description: `Colby approved ${sha.slice(0, 7)}`, creator: gateCreator }],
    gate,
  });
  assert(priorSuccess.state === "pending", "an earlier success does not stick");
  const priorPending = evaluate({
    pr: open,
    reviews: [review(colby, "APPROVED", sha)],
    comments: [],
    statuses: [{ id: 1, context: STATUS_CONTEXT, state: "pending", description: "gate error", created_at: t0, updated_at: t0, creator: gateCreator }],
  });
  assert(priorPending.state === "success", "a gate error does not stick");

  const errorWrites = [];
  let reviewError = null;
  try {
    await judgeAndWrite({
      prNumber: 12,
      gate: testGate,
      readPull: async () => open,
      readReviews: async () => {
        throw new Error("reviews failed");
      },
      readComments: async () => [],
      writeStatus: async (body) => {
        errorWrites.push(body);
      },
    });
  } catch (error) {
    reviewError = error;
  }
  assert(reviewError instanceof Error && reviewError.message === "reviews failed", "an API error still fails the run");
  assert(errorWrites.length === 1, "an API error writes one status");
  assert(
    errorWrites[0].sha === sha && errorWrites[0].state === "pending" && errorWrites[0].description === "gate error" && errorWrites[0].context === STATUS_CONTEXT,
    "an API error writes pending gate error on the head that was read",
  );

  const advisoryErrorWrites = [];
  let advisoryError = null;
  try {
    await judgeAndWrite({
      prNumber: 12,
      advisory: true,
      readPull: async () => open,
      readReviews: async () => {
        throw new Error("reviews failed");
      },
      readComments: async () => [],
      writeStatus: async (body) => {
        advisoryErrorWrites.push(body);
      },
    });
  } catch (error) {
    advisoryError = error;
  }
  assert(advisoryError instanceof Error && advisoryErrorWrites.length === 0, "advisory mode does not write gate error");

  const earlyWrites = [];
  let earlyError = null;
  try {
    await judgeAndWrite({
      prNumber: 12,
      readPull: async () => {
        throw new Error("pull failed");
      },
      readReviews: async () => [],
      readComments: async () => [],
      writeStatus: async (body) => {
        earlyWrites.push(body);
      },
    });
  } catch (error) {
    earlyError = error;
  }
  assert(earlyError instanceof Error && earlyError.message === "pull failed" && earlyWrites.length === 0, "a failure before the head is read writes nothing");

  let writeError = null;
  try {
    await judgeAndWrite({
      prNumber: 12,
      gate: testGate,
      readPull: async () => open,
      readReviews: async () => {
        throw new Error("reviews failed");
      },
      readComments: async () => [],
      writeStatus: async () => {
        throw new Error("status failed");
      },
    });
  } catch (error) {
    writeError = error;
  }
  assert(writeError instanceof Error && writeError.message === "reviews failed", "a failed gate-error write still surfaces the original error");

  const missingSlugWrites = [];
  const missingSlug = await judgeAndWrite({
    prNumber: 12,
    gate: { slug: "", botUserId: null },
    readPull: async () => open,
    readReviews: async () => {
      throw new Error("should not read reviews");
    },
    readComments: async () => [],
    writeStatus: async (body) => {
      missingSlugWrites.push(body);
    },
  });
  assert(missingSlug.wrote === true && missingSlug.reason === "missing-slug", "an empty app slug does not judge");
  assert(
    missingSlugWrites.length === 1 &&
      missingSlugWrites[0].sha === sha &&
      missingSlugWrites[0].state === "pending" &&
      missingSlugWrites[0].description === "gate error" &&
      missingSlugWrites[0].context === STATUS_CONTEXT,
    "an empty app slug writes pending gate error",
  );

  const sha2 = "c".repeat(40);
  const sharedSha = "d".repeat(40);
  const pendingSha = "e".repeat(40);
  const missingSha = "f".repeat(40);
  const actionsSha = "1".repeat(40);
  const actionsBot = { login: "github-actions[bot]", id: 41898282, type: "Bot" };
  function listStatus(state, creator, description, context = STATUS_CONTEXT) {
    return {
      id: 1,
      state,
      description: description || "",
      context,
      created_at: t0,
      updated_at: t0,
      creator,
    };
  }
  const combinedGreen = {
    state: "success",
    sha,
    total_count: 1,
    statuses: [
      {
        id: 1,
        state: "success",
        description: "Colby approved",
        context: STATUS_CONTEXT,
        created_at: t0,
        updated_at: t0,
      },
    ],
  };
  assert(!Object.prototype.hasOwnProperty.call(combinedGreen.statuses[0], "creator"), "a combined-status row has no creator");
  assert(statusPageNeedsJudge(combinedGreen, testGate) === false, "combined status is not the selection input");
  assert(listStatus("success", gateCreator).creator.type === "Bot", "a statuses-list row carries its creator");
  assert(statusPageNeedsJudge([listStatus("success", gateCreator)], testGate), "the gate bot's latest success is re-judged");
  assert(
    statusPageNeedsJudge([listStatus("pending", appBot, "pending"), listStatus("success", gateCreator)], testGate),
    "a newer status from someone else does not hide the gate bot's success",
  );
  assert(
    statusPageNeedsJudge([listStatus("success", gateCreator), listStatus("failure", gateCreator, "Blocked: BLOCK from octocat")], testGate),
    "the newest gate-bot approval-gate row is the one that counts",
  );
  assert(
    !statusPageNeedsJudge([listStatus("failure", gateCreator, "Blocked: BLOCK from octocat"), listStatus("success", gateCreator)], testGate),
    "a red status from the gate bot is not re-judged",
  );
  assert(
    statusPageNeedsJudge([listStatus("success", appBot)], testGate),
    "approval-gate rows with no gate-bot creator are judged",
  );
  assert(
    statusPageNeedsJudge([listStatus("success", actionsBot)], testGate),
    "an Actions approval-gate row with no gate-bot creator is judged",
  );
  assert(!statusPageNeedsJudge([listStatus("pending", gateCreator, "gate error")], testGate), "a pending status from the gate bot is not re-judged");
  assert(!statusPageNeedsJudge([listStatus("success", actionsBot, "ok", "tests")], testGate), "a page with no approval-gate row is not re-judged");
  assert(!statusPageNeedsJudge([], testGate), "a missing status page is not re-judged");
  const junkRow = listStatus("success", actionsBot, "ok", "tests");
  const fullJunk = Array.from({ length: 100 }, () => junkRow);
  assert(statusPageNeedsJudge(fullJunk, testGate), "a full page with no gate-bot approval-gate row is judged");
  assert(!statusPageNeedsJudge(fullJunk.slice(0, 99), testGate), "a short page of other statuses is left alone");
  assert(
    !statusPageNeedsJudge([listStatus("failure", gateCreator, "Blocked: BLOCK from octocat"), ...fullJunk.slice(0, 99)], testGate),
    "a full page still trusts a red status from the gate bot",
  );
  const fullPageSeen = [];
  const fullPage = await judgeRelevantPulls({
    gate: testGate,
    listPulls: async () => [{ number: 21, state: "open", base: { ref: "main" }, head: { sha } }],
    readStatusPage: async () => fullJunk,
    judgeOne: async (number) => {
      fullPageSeen.push(number);
      return { wrote: false, reason: "skip", result: { state: null, reasons: ["skip"] }, judgedSha: sha };
    },
  });
  assert(fullPage.errors.length === 0 && fullPageSeen.length === 1 && fullPageSeen[0] === 21, "a full status page is judged even with no gate-bot row");
  assert(
    statusPageNeedsJudge([listStatus("success", gateCreator)], { slug: "", botUserId: null }),
    "an empty slug matches no creator, so an approval-gate page is judged",
  );
  assert(NAMED_MACHINE_LOGINS.includes("motorunitbots") && !NAMED_MACHINE_LOGINS.includes("motorunit-bot"), "the machine login is motorunitbots");
  assert(MOTORUNIT_BOT_USER_ID == null, "the motorunitbots user id is not guessed");

  const sweepWrites = [];
  const sweepSeen = [];
  const combinedReads = [];
  const sweep = await judgeRelevantPulls({
    triggering: 1,
    triggeringSha: sha,
    gate: testGate,
    listPulls: () =>
      listAll(async (page) => {
        if (page === 1) {
          return [
            { number: 1, state: "open", base: { ref: "main" }, head: { sha }, title: "$(rm)" },
            ...Array.from({ length: 99 }, (_, index) => ({ number: index + 10, state: "closed", base: { ref: "main" }, head: { sha } })),
          ];
        }
        if (page === 2) {
          return [
            { number: 2, state: "open", base: { ref: "main" }, head: { sha: sha2 } },
            { number: 3, state: "open", base: { ref: "main" }, head: { sha: other } },
            { number: 4, state: "open", base: { ref: "main" }, head: { sha: sharedSha } },
            { number: 5, state: "open", base: { ref: "main" }, head: { sha: pendingSha } },
            { number: 6, state: "open", base: { ref: "main" }, head: { sha: missingSha } },
            { number: 7, state: "open", base: { ref: "main" }, head: { sha: actionsSha } },
            { number: 8, state: "open", base: { ref: "feature" }, head: { sha } },
          ];
        }
        return [];
      }),
    readStatusPage: async (head) => {
      combinedReads.push(head);
      if (head === sha2) return [listStatus("pending", appBot, "pending"), listStatus("success", gateCreator, "Colby approved")];
      if (head === other) {
        return [
          listStatus("failure", gateCreator, "Blocked: BLOCK from octocat"),
          listStatus("success", gateCreator, "Colby approved"),
        ];
      }
      if (head === sharedSha) return [listStatus("success", appBot, "Colby approved")];
      if (head === pendingSha) return [listStatus("pending", gateCreator, "Waiting")];
      if (head === missingSha) return [listStatus("success", actionsBot, "ok", "tests")];
      if (head === actionsSha) return [listStatus("success", actionsBot, "ok")];
      throw new Error(`unexpected status page ${head}`);
    },
    writeGateError: async () => {
      throw new Error("should not write gate error while selecting");
    },
    judgeOne: async (number, options) => {
      sweepSeen.push(number);
      if (number !== 1 && number !== 2 && number !== 4 && number !== 7) throw new Error(`should not judge ${number}`);
      const head = number === 1 ? sha : number === 2 ? sha2 : number === 4 ? sharedSha : actionsSha;
      return judgeAndWrite({
        prNumber: number,
        gate: testGate,
        knownSha: options.knownSha,
        readPull: async () => ({ state: "open", base: { ref: "main" }, head: { sha: head } }),
        readReviews: async () => {
          if (number !== 1 && number !== 2 && number !== 4 && number !== 7) throw new Error(`reviews for ${number}`);
          return [review(colby, "APPROVED", head)];
        },
        readComments: async () =>
          number === 2 ? [note(`Independent review: BLOCK ${sha2}`, { login: "octocat", id: 9, type: "User" })] : [],
        readStatuses: async () => [],
        writeStatus: async (body) => {
          sweepWrites.push(body);
        },
      });
    },
  });
  assert(
    sweep.errors.length === 0 && sweepSeen.length === 4 && sweepSeen[0] === 1 && sweepSeen[1] === 2 && sweepSeen[2] === 4 && sweepSeen[3] === 7,
    "one run judges the triggering pull request, a gate-bot success, and a page with no gate-bot row",
  );
  assert(
    !combinedReads.includes(sha) && combinedReads.includes(sha2) && combinedReads.includes(other) && !sweepSeen.includes(3) && !sweepSeen.includes(5) && !sweepSeen.includes(6),
    "a red or pending gate-bot status is not re-judged, and the trigger skips the status page",
  );
  assert(
    sweepWrites.some((body) => body.sha === sha && body.state === "success") &&
      sweepWrites.some((body) => body.sha === sha2 && body.state === "failure" && body.description === "Blocked: BLOCK from octocat"),
    "a BLOCK on another still-green pull request turns that commit red in the same run",
  );

  const repairWrites = [];
  const repair = await judgeRelevantPulls({
    gate: testGate,
    listPulls: async () => [
      { number: 11, state: "open", base: { ref: "main" }, head: { sha } },
      { number: 12, state: "open", base: { ref: "main" }, head: { sha: sha2 } },
    ],
    readStatusPage: async () => [listStatus("success", gateCreator, "Colby approved")],
    judgeOne: (number, options) =>
      judgeAndWrite({
        prNumber: number,
        gate: testGate,
        knownSha: options.knownSha,
        readPull: async () => ({ state: "open", base: { ref: "main" }, head: { sha: number === 11 ? sha : sha2 } }),
        readReviews: async () => {
          if (number === 11) throw new Error("reviews failed");
          return [];
        },
        readComments: async () =>
          number === 12 ? [note(`Independent review: BLOCK ${sha2}`, { login: "octocat", id: 9, type: "User" })] : [],
        writeStatus: async (body) => {
          repairWrites.push(body);
        },
      }),
  });
  assert(repair.errors.length === 1 && repair.errors[0].number === 11 && repair.outcomes.length === 1, "one pull request error does not stop the next");
  assert(
    repairWrites.some((body) => body.sha === sha && body.state === "pending" && body.description === "gate error") &&
      repairWrites.some((body) => body.sha === sha2 && body.state === "failure"),
    "the next pull request still gets its own status",
  );

  let fallbackListed = false;
  let fallbackCombined = false;
  const fallbackWrites = [];
  const fallbackJudged = [];
  const fallback = await judgeRelevantPulls({
    triggering: 8,
    triggeringSha: sha,
    gate: testGate,
    listPulls: async () => {
      fallbackListed = true;
      throw new Error("list failed");
    },
    readStatusPage: async () => {
      fallbackCombined = true;
      throw new Error("should not read the status page");
    },
    writeGateError: async () => {
      throw new Error("should not write outside the judgment");
    },
    judgeOne: (number, options) => {
      fallbackJudged.push({ number, knownSha: options.knownSha, writeErrorWithoutHead: options.writeErrorWithoutHead });
      return judgeAndWrite({
        prNumber: number,
        gate: testGate,
        knownSha: options.knownSha,
        writeErrorWithoutHead: options.writeErrorWithoutHead,
        readPull: async () => {
          throw new Error("pull failed");
        },
        readReviews: async () => {
          throw new Error("should not read reviews");
        },
        readComments: async () => [],
        writeStatus: async (body) => {
          fallbackWrites.push(body);
        },
      });
    },
  });
  assert(fallbackListed && !fallbackCombined && fallback.listFailed === true, "a pull list failure does not read other pull requests");
  assert(
    fallbackJudged.length === 1 && fallbackJudged[0].number === 8 && fallbackJudged[0].knownSha === sha && fallbackJudged[0].writeErrorWithoutHead === true,
    "a pull list failure judges the triggering pull request",
  );
  assert(fallback.errors.length === 1 && fallback.errors[0].number === 8 && fallback.outcomes.length === 0, "no other pull request is judged when the list fails");
  assert(
    fallbackWrites.length === 1 &&
      fallbackWrites[0].sha === sha &&
      fallbackWrites[0].state === "pending" &&
      fallbackWrites[0].description === "gate error" &&
      fallbackWrites[0].context === STATUS_CONTEXT,
    "a pull list failure writes gate error on the known triggering head",
  );

  const orphanWrites = [];
  let orphanJudged = false;
  const orphan = await judgeRelevantPulls({
    triggering: null,
    triggeringSha: sha,
    gate: testGate,
    listPulls: async () => {
      throw new Error("list failed");
    },
    readStatusPage: async () => {
      throw new Error("should not read the status page");
    },
    writeGateError: async (head) => {
      orphanWrites.push(head);
    },
    judgeOne: async () => {
      orphanJudged = true;
    },
  });
  assert(!orphanJudged && orphanWrites.length === 1 && orphanWrites[0] === sha && orphan.errors.length === 1, "a list failure with only a known head still writes gate error");

  function rateError(status, remaining) {
    const error = new Error(`GET /pulls/12 -> ${status}`);
    error.status = status;
    if (typeof remaining === "string") {
      error.headers = {
        get(name) {
          return String(name).toLowerCase() === "x-ratelimit-remaining" ? remaining : null;
        },
      };
    } else if (remaining != null) {
      error.headers = { "x-ratelimit-remaining": remaining };
    }
    return error;
  }
  assert(isRateLimitError(rateError(429, "0")) && isRateLimitError(rateError(403, "0")) && isRateLimitError(rateError(500, 0)), "403, 429, and a remaining allowance of 0 are rate limits");
  assert(!isRateLimitError(rateError(500, "50")) && !isRateLimitError(new Error("pull failed")), "an ordinary API error is not a rate limit");

  const limitCases = [
    ["a 429 before the head is read", rateError(429, "0")],
    ["a 403 before the head is read", rateError(403, "0")],
    ["a used-up allowance before the head is read", rateError(500, "0")],
  ];
  for (const [label, error] of limitCases) {
    const limitWrites = [];
    let limitError = null;
    try {
      await judgeAndWrite({
        prNumber: 12,
        gate: testGate,
        knownSha: sha,
        readPull: async () => {
          throw error;
        },
        readReviews: async () => {
          throw new Error("should not read reviews");
        },
        readComments: async () => [],
        writeStatus: async (body) => {
          limitWrites.push(body);
        },
      });
    } catch (caught) {
      limitError = caught;
    }
    assert(limitError === error, `${label} still fails the run`);
    assert(
      limitWrites.length === 1 &&
        limitWrites[0].sha === sha &&
        limitWrites[0].state === "pending" &&
        limitWrites[0].description === "gate error" &&
        limitWrites[0].context === STATUS_CONTEXT,
      `${label} writes pending gate error when the head is known`,
    );
  }

  const plainWrites = [];
  let plainError = null;
  try {
    await judgeAndWrite({
      prNumber: 12,
      gate: testGate,
      knownSha: sha,
      readPull: async () => {
        throw rateError(500, "50");
      },
      readReviews: async () => [],
      readComments: async () => [],
      writeStatus: async (body) => {
        plainWrites.push(body);
      },
    });
  } catch (error) {
    plainError = error;
  }
  assert(plainError instanceof Error && plainWrites.length === 0, "a non-rate-limit failure before the head is read writes nothing");

  const protectedWrites = [];
  const protectedReads = [];
  const protectedJudged = [];
  const protectedRun = await judgeRelevantPulls({
    triggering: 1,
    triggeringSha: sha,
    gate: testGate,
    listPulls: async () => [
      { number: 1, state: "open", base: { ref: "main" }, head: { sha } },
      { number: 2, state: "open", base: { ref: "main" }, head: { sha: other } },
      { number: 3, state: "open", base: { ref: "main" }, head: { sha: sha2 } },
    ],
    readStatusPage: async (head) => {
      protectedReads.push(head);
      throw rateError(403, "0");
    },
    writeGateError: async (head) => {
      protectedWrites.push(head);
    },
    judgeOne: async (number) => {
      protectedJudged.push(number);
      return { wrote: true, reason: "wrote", judgedSha: sha, result: { state: "success", description: "ok" } };
    },
  });
  assert(protectedJudged.length === 1 && protectedJudged[0] === 1, "a rate limit does not spend a full judgment on the other pull requests");
  assert(protectedReads.length === 1 && protectedReads[0] === other, "a rate limit stops further status reads");
  assert(
    protectedWrites.length === 2 && protectedWrites[0] === other && protectedWrites[1] === sha2 && protectedRun.errors.length === 2,
    "a rate limit writes gate error on each known head",
  );

  let advisoryListed = false;
  const advisoryJudged = [];
  const advisoryRun = await judgeRelevantPulls({
    advisory: true,
    triggering: 4,
    triggeringSha: sha,
    gate: testGate,
    listPulls: async () => {
      advisoryListed = true;
      return [
        { number: 4, state: "open", base: { ref: "main" }, head: { sha } },
        { number: 5, state: "open", base: { ref: "main" }, head: { sha: other } },
      ];
    },
    readStatusPage: async () => {
      throw new Error("advisory should not read combined status");
    },
    writeGateError: async () => {
      throw new Error("advisory should not write");
    },
    judgeOne: async (number) => {
      advisoryJudged.push(number);
      return { wrote: false, reason: "advisory", judgedSha: sha, result: { state: "pending", description: "waiting" } };
    },
  });
  assert(!advisoryListed && advisoryJudged.length === 1 && advisoryJudged[0] === 4 && advisoryRun.selected.length === 1, "advisory mode judges only the triggering pull request");

  assert(headShaFromEvent("pull_request_target", { pull_request: { head: { sha } } }) === sha, "a pull request event carries the head");
  assert(headShaFromEvent("workflow_run", { workflow_run: { head_sha: sha.toUpperCase() } }) === sha, "a review relay event carries the head");
  assert(
    headShaFromEvent("issue_comment", { comment: { body: `Independent review: BLOCK ${sha}` }, issue: { number: 4, pull_request: {} } }) === null,
    "a comment body is not read as a head sha",
  );
  assert(headShaFromEvent("workflow_dispatch", {}) === null, "a manual run has no head sha");

  const failedHistory = await prepareComments(
    [note("hello", cursorBot, { id: 9, updated_at: t1, node_id: "BOT" })],
    {},
    async () => {
      throw new Error("history missing");
    },
  );
  const failedClosed = judge([review(colby, "APPROVED", sha)], failedHistory);
  assert(failedClosed.state === "failure" && failedClosed.reasons[0] === "block", "unreadable bot edit history fails closed");

  const humanHistory = await prepareComments(
    [note("thanks", { login: "octocat", id: 3, type: "User" }, { id: 11, updated_at: t1, node_id: "HUMAN" })],
    {},
    async () => {
      throw new Error("history missing");
    },
  );
  assert(judge([review(colby, "APPROVED", sha)], humanHistory).state === "success", "an ordinary edited human comment does not block");

  const helloBot = note("hello", cursorBot, {
    id: 12,
    updated_at: t1,
    originalUnseen: true,
    versions: [{ body: "hello", at: t1 }],
  });
  assert(judge([review(colby, "APPROVED", sha)], [helloBot]).state === "success", "an edited bot note that is not a PASS does not trip");

  const hiddenPass = note("hello", appBot, {
    id: 13,
    updated_at: t1,
    versions: [
      { body: `Independent review: PASS ${sha}`, at: t0 },
      { body: "hello", at: t1 },
    ],
  });
  const hidden = judge([review(colby, "APPROVED", sha)], [hiddenPass]);
  assert(hidden.state === "failure" && hidden.reasons[0] === "bot-approval", "a bot cannot edit a PASS away");

  const editedBlock = note(`Independent review: PASS ${sha}`, colby, {
    id: 14,
    updated_at: t2,
    versions: [
      { body: `Independent review: BLOCK ${sha}`, at: t1 },
      { body: `Independent review: PASS ${sha}`, at: t2 },
    ],
  });
  assert(judge([], [editedBlock]).state === "failure", "editing a BLOCK into a PASS does not lift it");

  const deletedBotPass = note(`Independent review: PASS ${sha}`, appBot, { deleted: true });
  assert(judge([review(colby, "APPROVED", sha)], [deletedBotPass]).state === "failure", "deleting a bot PASS does not clear it");

  const deletedEvent = await prepareComments([], {
    action: "deleted",
    comment: note(`Independent review: BLOCK ${sha}\n$(reboot)`, { login: "octocat", id: 1, type: "User" }, { id: 77 }),
  }, async () => []);
  const deletedBlock = judge([review(colby, "APPROVED", sha)], deletedEvent);
  assert(deletedBlock.state === "failure" && !deletedBlock.description.includes("$("), "a deleted BLOCK still blocks and its text is not echoed");

  assert(pullNumberFromEvent("workflow_dispatch", {}, "$(rm -rf /)").number === null, "a shell-like PR number is rejected");
  assert(pullNumberFromEvent("workflow_dispatch", {}, "12\nrm").number === null, "a PR number with a newline is rejected");
  assert(pullNumberFromEvent("workflow_dispatch", {}, "12").number === 12, "a numeric PR number is accepted");
  const injectedComment = { comment: { body: "$(rm)\n`id`" }, issue: { number: 4, title: "nope", pull_request: { url: "x" } } };
  assert(pullNumberFromEvent("issue_comment", injectedComment).number === 4, "comment text is not read as the pull request number");
  const relayEvent = { workflow_run: { pull_requests: [{ number: 9, title: "$(rm)", body: "`id`" }] } };
  assert(pullNumberFromEvent("workflow_run", relayEvent).number === 9, "the relay uses the pull request number, not the title");

  const token = "ghs_test_token_value_not_real";
  assert(scrubToken(`API said ${token}`, token) === "API said [redacted]", "errors redact the token");
  assert(!summaryText(stable).includes(token), "the summary has no token");
  assert(!summaryText(stable).includes("$(reboot)"), "the summary has no comment text");

  const source = fs.readFileSync(fileURLToPath(import.meta.url), "utf8");
  const childImport = ["node", "child_process"].join(":");
  const execName = ["exec", "Sync"].join("");
  assert(!source.includes(`from "${childImport}"`) && !source.includes(`from '${childImport}'`), "the gate does not spawn a shell");
  assert(!source.includes(execName), "the gate does not exec");
  const sharedKeyName = ["REVIEW_APP", "PRIVATE_KEY"].join("_");
  assert(!source.includes(sharedKeyName), "the gate does not name the shared App key");
  const statusPageQuery = ["/statuses?per_page=100", "`"].join("");
  const combinedStatusQuery = ["/status", "`"].join("");
  assert(source.includes(statusPageQuery), "the still-green check reads one statuses page");
  assert(!source.includes(combinedStatusQuery), "the still-green check does not read combined status");

  const workflowDir = fileURLToPath(new URL("./workflows/", import.meta.url));
  const workflowNames = fs.readdirSync(workflowDir).filter((entry) => entry.endsWith(".yml") || entry.endsWith(".yaml"));
  assert(workflowNames.includes("approval-gate.yml"), "the binding workflow exists");
  assert(workflowNames.includes("approval-gate-trigger.yml"), "the review relay exists");
  assert(!workflowNames.includes("approval-gate-live-test-9.yml"), "live test 9 is not an active workflow");
  const gateDoc = fs.readFileSync(fileURLToPath(new URL("../docs/approval-gate.md", import.meta.url)), "utf8");
  assert(gateDoc.includes("workflow_dispatch:"), "live test 9 is a workflow_dispatch snippet");
  assert(gateDoc.includes("statuses: write"), "live test 9 uses the Actions status permission");
  assert(gateDoc.includes("secrets.GITHUB_TOKEN"), "live test 9 uses the Actions token");
  assert(gateDoc.includes("Delete `.github/workflows/approval-gate-live-test-9.yml` from `main`."), "live test 9 says to remove the workflow");
  const workflowErrors = [];
  for (const entry of workflowNames) {
    const body = fs.readFileSync(`${workflowDir}${entry}`, "utf8");
    workflowErrors.push(...lintWorkflow(entry, body));
  }
  assert(workflowErrors.length === 0, `workflow lint: ${workflowErrors.join("; ")}`);

  const gateYaml = fs.readFileSync(`${workflowDir}approval-gate.yml`, "utf8");
  const relayYaml = fs.readFileSync(`${workflowDir}approval-gate-trigger.yml`, "utf8");
  assert(gateYaml.includes("environment: approval-gate"), "the gate job uses the approval-gate environment");
  assert(gateYaml.includes("secrets.APPROVAL_GATE_APP_ID"), "the App id comes from the environment secret");
  assert(gateYaml.includes("secrets.APPROVAL_GATE_APP_PRIVATE_KEY"), "the App key comes from the environment secret");
  assert(gateYaml.includes("GITHUB_TOKEN: ${{ steps.app-token.outputs.token }}"), "the status writer uses the gate App token");
  assert(gateYaml.includes("permission-statuses: write"), "the App token can write statuses");
  assert(gateYaml.includes("permission-pull-requests: read"), "the App token can read pull requests");
  assert(gateYaml.includes("permission-contents: read"), "the App token can read contents");
  assert(!gateYaml.includes("secrets.GITHUB_TOKEN"), "Actions' token is not the status writer");
  assert(!gateYaml.includes(sharedKeyName), "the shared App key is not used");
  assert(!gateYaml.includes("vars.REVIEW_APP_ID"), "the shared App id is not used");
  assert(!/^\s*statuses:\s*write/m.test(gateYaml), "the workflow token is not granted statuses write");
  assert(gateYaml.includes("ref: ${{ github.sha }}"), "the gate checks out the base sha");
  assert(gateYaml.includes("persist-credentials: false"), "the gate checkout drops credentials");
  assert(!gateYaml.includes("workflow_run.id"), "review events do not get their own concurrency group");
  assert(!gateYaml.includes("workflow_run.head_sha"), "the lock does not fall back to a commit id");
  assert(!gateYaml.includes("github.event.workflow_run"), "the lock does not read the review event");
  const beforeJobs = gateYaml.split("\njobs:\n")[0];
  assert(!/^concurrency:/m.test(beforeJobs), "the lock is not on the whole workflow");
  assert(gateYaml.includes("APPROVAL_GATE_APP_SLUG: ${{ steps.app-token.outputs.app-slug }}"), "the gate slug comes from the token step");
  assert(gateYaml.includes("APPROVAL_GATE_BOT_USER_ID: ${{ vars.APPROVAL_GATE_BOT_USER_ID }}"), "the bot user id is a configurable variable");
  const gateJobs = gateYaml.split("\njobs:\n")[1] || "";
  assert(gateJobs.includes("\n    concurrency:\n      group: approval-gate\n      queue: max\n"), "the judge job queues on one group");
  assert(!gateJobs.includes("cancel-in-progress:"), "the judge job does not cancel the running run");
  assert(gateJobs.includes("github.event_name == 'pull_request_target'"), "a push still runs the judge job");
  assert(gateJobs.includes("github.event_name == 'workflow_run'"), "a review event still runs the judge job");
  assert(gateJobs.includes("github.event.action == 'deleted'"), "a deleted comment still runs the judge job");
  assert(BLOCK_PREFIX === "Independent review: BLOCK", "the BLOCK marker is the parser's marker");
  assert(gateJobs.includes("contains(github.event.comment.body, 'Independent review:')"), "the job if uses the review marker");
  assert(!gateJobs.includes("Independent review: BLOCK"), "the job if does not repeat the BLOCK marker");
  assert(
    gateJobs.includes("contains(github.event.changes.body.from, 'Independent review:')"),
    "an edit that removes the review marker still runs the judge job",
  );
  for (const script of runScriptBodies(gateYaml)) {
    assert(!script.includes("github.event.comment.body"), "comment text stays out of the judge shell");
    assert(!script.includes("github.event.changes.body.from"), "the previous comment text stays out of the judge shell");
  }
  assert(gateJobs.includes("\n    name: judge\n"), "the binding job is named judge");
  assert(!gateJobs.includes("name: approval-gate"), "the job name is not the status context");
  assert(STATUS_CONTEXT === "approval-gate", "the status context stays approval-gate");
  const advisoryYaml = fs.readFileSync(`${workflowDir}independent-review.yml`, "utf8");
  const advisoryJobs = advisoryYaml.split("\njobs:\n")[1] || "";
  assert(advisoryJobs.includes("\n    name: judge (advisory)\n"), "the pull request advisory job is named judge (advisory)");
  assert(advisoryJobs.includes("\n    name: judge (advisory, from base)\n"), "the base advisory job is named judge (advisory, from base)");
  assert(!advisoryJobs.includes("name: approval-gate"), "advisory jobs are not named approval-gate");
  for (const entry of workflowNames) {
    const jobs = fs.readFileSync(`${workflowDir}${entry}`, "utf8").split("\njobs:\n")[1] || "";
    assert(!jobs.includes("name: approval-gate"), `${entry} has no job named approval-gate`);
  }
  assert(!relayYaml.includes("uses:"), "the relay checks nothing out");
  assert(!relayYaml.includes("secrets."), "the relay has no secrets");
  assert(relayYaml.includes("permissions: {}"), "the relay token has no permissions");
  assert(!relayYaml.includes("pull_request_target"), "the relay is not a pull_request_target workflow");
  for (const script of runScriptBodies(relayYaml)) {
    assert(!script.includes("${{"), "the relay script has no expressions");
    assert(!script.includes("github.event"), "the relay script does not read the event");
  }

  console.log("approval-gate self-test ok");
}

function writeStepSummary(summary) {
  const path = process.env.GITHUB_STEP_SUMMARY;
  if (!path) return;
  fs.appendFileSync(path, `${summary}\n`);
}

async function githubRequest({ apiBase, token, pathname, method = "GET", body }) {
  const response = await fetch(apiBase + pathname, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "aidanos-approval-gate",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  if (!response.ok) {
    const error = new Error(`${method} ${pathname} -> ${response.status} ${scrubToken(text, token).slice(0, 300)}`);
    error.status = response.status;
    error.headers = response.headers;
    throw error;
  }
  if (!text) return null;
  return JSON.parse(text);
}

async function listEdits(request, nodeId) {
  const edits = [];
  let cursor = null;
  for (let page = 0; page < 10; page += 1) {
    const payload = await request("/graphql", {
      method: "POST",
      body: {
        query: `query($id: ID!, $cursor: String) {
          node(id: $id) {
            ... on IssueComment {
              userContentEdits(first: 100, after: $cursor) {
                pageInfo { hasNextPage endCursor }
                nodes { editedAt diff deletedAt }
              }
            }
          }
        }`,
        variables: { id: nodeId, cursor },
      },
    });
    const connection = payload && payload.data && payload.data.node && payload.data.node.userContentEdits;
    if (!connection) throw new Error("edit history is missing");
    if (payload.errors && payload.errors.length) throw new Error("edit history failed");
    edits.push(...(connection.nodes || []));
    if (!connection.pageInfo || !connection.pageInfo.hasNextPage) return edits;
    cursor = connection.pageInfo.endCursor;
  }
  throw new Error("edit history is too long");
}

async function resolvePullNumber({ eventName, event, request, owner, repo }) {
  const found = pullNumberFromEvent(eventName, event, process.env.APPROVAL_GATE_PR);
  if (found.number) return found.number;
  if (!found.headSha) return null;
  if (!/^[0-9a-f]{40}$/i.test(found.headSha)) return null;
  const pulls = await request(`/repos/${owner}/${repo}/commits/${encodeURIComponent(found.headSha)}/pulls`);
  if (!Array.isArray(pulls)) return null;
  const openMain = pulls.filter((item) => item && item.state === "open" && item.base && item.base.ref === "main");
  return openMain.length === 1 ? openMain[0].number : null;
}

async function main() {
  if (process.argv.includes("--self-test")) {
    await selfTest();
    return;
  }
  const advisory = process.argv.includes("--advisory");
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error("GITHUB_TOKEN is required");
  const [owner, repo] = String(process.env.GITHUB_REPOSITORY || "").split("/");
  if (!owner || !repo) throw new Error("GITHUB_REPOSITORY is required");
  const eventName = process.env.GITHUB_EVENT_NAME || "";
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (!eventPath) throw new Error("GITHUB_EVENT_PATH is required");
  const event = JSON.parse(fs.readFileSync(eventPath, "utf8"));
  const apiBase = process.env.GITHUB_API_URL || "https://api.github.com";
  const request = (pathname, options = {}) => githubRequest({ apiBase, token, pathname, ...options });
  let triggering = null;
  try {
    triggering = await resolvePullNumber({ eventName, event, request, owner, repo });
  } catch (error) {
    console.log(scrubToken(error && error.message ? error.message : error, token));
  }
  const gate = gateFromEnv(process.env);
  const triggeringSha = headShaFromEvent(eventName, event);
  const postStatus = (sha, state, description) =>
    request(`/repos/${owner}/${repo}/statuses/${encodeURIComponent(sha)}`, {
      method: "POST",
      body: { state, description, context: STATUS_CONTEXT },
    });
  const { outcomes, errors, listFailed, listError } = await judgeRelevantPulls({
    advisory,
    gate,
    triggering,
    triggeringSha,
    listPulls: () =>
      listAll((page) => request(`/repos/${owner}/${repo}/pulls?state=open&base=main&per_page=100&page=${page}`)),
    readStatusPage: (sha) => request(`/repos/${owner}/${repo}/commits/${encodeURIComponent(sha)}/statuses?per_page=100`),
    writeGateError: (sha) => postStatus(sha, "pending", "gate error"),
    judgeOne: (pullNumber, options = {}) =>
      judgeAndWrite({
        prNumber: pullNumber,
        advisory,
        gate,
        knownSha: options.knownSha || null,
        writeErrorWithoutHead: Boolean(options.writeErrorWithoutHead),
        readPull: (number) => request(`/repos/${owner}/${repo}/pulls/${number}`),
        readReviews: (number) =>
          listAll((page) => request(`/repos/${owner}/${repo}/pulls/${number}/reviews?per_page=100&page=${page}`)),
        readComments: async (number) => {
          const comments = await listAll((page) =>
            request(`/repos/${owner}/${repo}/issues/${number}/comments?per_page=100&page=${page}`),
          );
          const commentEvent = number === triggering ? event : null;
          return prepareComments(comments, commentEvent, (nodeId) => listEdits(request, nodeId), (message) => console.log(message));
        },
        readStatuses: (sha) =>
          listAll((page) =>
            request(`/repos/${owner}/${repo}/commits/${encodeURIComponent(sha)}/statuses?per_page=100&page=${page}`),
          ),
        writeStatus: ({ sha, state, description }) => postStatus(sha, state, description),
      }),
  });
  if (listFailed) {
    const detail = listError && listError.message ? scrubToken(listError.message, token) : "";
    console.log(
      detail
        ? `Could not read the pull request list (${detail}). Judging the triggering pull request only.`
        : "Could not read the pull request list. Judging the triggering pull request only.",
    );
  }
  if (!outcomes.length && !errors.length) {
    console.log("No open pull request into main.");
    return;
  }
  const lines = [];
  for (const item of outcomes) {
    lines.push(`PR #${item.number}\n${summaryText(item.outcome)}`);
  }
  for (const item of errors) {
    const label = item.number ? `PR #${item.number}` : "pull request list";
    lines.push(`${label}\n${scrubToken(item.error && item.error.message ? item.error.message : item.error, token)}`);
  }
  const summary = lines.join("\n\n");
  console.log(summary);
  writeStepSummary(summary);
  const missingSlug = outcomes.some((item) => item.outcome && item.outcome.reason === "missing-slug");
  const advisoryFailure = advisory && outcomes.some((item) => item.outcome && item.outcome.result && item.outcome.result.state === "failure");
  if (errors.length || missingSlug || advisoryFailure) process.exitCode = 1;
}

const isDirectRun = process.argv[1] && process.argv[1].endsWith("approval-gate.mjs");
if (isDirectRun) {
  main().catch((error) => {
    const token = process.env.GITHUB_TOKEN;
    const message = scrubToken(error && error.message ? error.message : error, token);
    console.error(message);
    process.exit(1);
  });
}
