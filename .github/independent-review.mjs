#!/usr/bin/env node
/**
 * Independent review gate.
 *
 * A PASS counts only when all of these are true:
 * - The comment begins with "Independent review: PASS" and the current head SHA.
 * - The comment has not been edited, so a later edit cannot retarget the SHA.
 * - The author is the motorunit-aidanos-bots GitHub App: login
 *   motorunit-aidanos-bots[bot] and type Bot. When performed_via_github_app
 *   is present, its id is 5413571. A user account does not count.
 *
 * A BLOCK from that App stays in force until a newer qualifying PASS
 * for this head SHA. The original body and every later version count. The
 * most restrictive version wins, so editing a BLOCK into a PASS does not
 * lift it. If the edit history cannot be read, that comment stays a BLOCK.
 * A bare BLOCK names no SHA and applies to the current head.
 *
 * pull_request only prints a result and exits. It must not post a status.
 * issue_comment and pull_request_target run this file from the default
 * branch and post the commit status `independent-review/approved` on the
 * PR head, using the built-in GITHUB_TOKEN. No GitHub App key is read.
 * Those runs read the head SHA from the event, never from a checkout of
 * the pull request.
 */
import fs from "node:fs";

const PASS_PREFIX = "Independent review: PASS";
const BLOCK_PREFIX = "Independent review: BLOCK";

// The independent reviewer posts as this GitHub App. Change these together.
export const REVIEW_APP_LOGIN = "motorunit-aidanos-bots[bot]";
export const REVIEW_APP_ID = 5413571;

export const STATUS_CONTEXT = "independent-review/approved";

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

export function isReviewBot(comment) {
  const user = comment && comment.user;
  if (!user || user.login !== REVIEW_APP_LOGIN || user.type !== "Bot") return false;
  const via = comment.performed_via_github_app;
  if (via == null) return true;
  return Number(via.id) === REVIEW_APP_ID;
}

export function commentWasEdited(comment) {
  if (!comment || !comment.created_at || !comment.updated_at) return false;
  return comment.created_at !== comment.updated_at;
}

export function eventPublishesStatus(eventName) {
  return eventName === "issue_comment" || eventName === "pull_request_target";
}

function timeMs(value) {
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

function splitFile(text) {
  const source = String(text).replace(/\r\n/g, "\n");
  if (source === "") return { lines: [], trailing: false };
  const trailing = source.endsWith("\n");
  const lines = source.split("\n");
  if (trailing) lines.pop();
  return { lines, trailing };
}

function joinFile(lines, trailing) {
  if (lines.length === 0) return trailing ? "\n" : "";
  const body = lines.join("\n");
  return trailing ? `${body}\n` : body;
}

export function parseUnifiedDiff(diff) {
  const text = String(diff || "").replace(/\r\n/g, "\n");
  const raw = text.split("\n");
  if (raw.length && raw[raw.length - 1] === "") raw.pop();
  let index = 0;
  while (index < raw.length && !raw[index].startsWith("@@")) index += 1;
  if (index >= raw.length) throw new Error("diff has no hunks");

  const hunks = [];
  while (index < raw.length) {
    const header = raw[index].match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    if (!header) throw new Error("bad hunk header");
    const oldStart = Number(header[1]);
    const oldCount = header[2] === undefined ? 1 : Number(header[2]);
    const newStart = Number(header[3]);
    const newCount = header[4] === undefined ? 1 : Number(header[4]);
    index += 1;
    const hunkLines = [];
    let oldSeen = 0;
    let newSeen = 0;
    while (index < raw.length && !raw[index].startsWith("@@")) {
      const line = raw[index];
      index += 1;
      if (line.startsWith("\\")) continue;
      if (line.startsWith("+")) {
        hunkLines.push({ type: "add", text: line.slice(1) });
        newSeen += 1;
      } else if (line.startsWith("-")) {
        hunkLines.push({ type: "del", text: line.slice(1) });
        oldSeen += 1;
      } else if (line.startsWith(" ")) {
        hunkLines.push({ type: "context", text: line.slice(1) });
        oldSeen += 1;
        newSeen += 1;
      } else {
        throw new Error("unexpected diff line");
      }
    }
    if (oldSeen !== oldCount || newSeen !== newCount) throw new Error("hunk counts do not match");
    hunks.push({ oldStart, oldCount, newStart, newCount, lines: hunkLines });
  }
  return hunks;
}

function applyReverse(newLines, hunks) {
  const oldLines = [];
  let cursor = 0;
  for (const hunk of hunks) {
    const newStart = hunk.newStart === 0 ? 0 : hunk.newStart - 1;
    if (newStart < cursor) throw new Error("overlapping hunk");
    while (cursor < newStart) {
      if (cursor >= newLines.length) throw new Error("hunk starts past the end of the text");
      oldLines.push(newLines[cursor]);
      cursor += 1;
    }
    for (const line of hunk.lines) {
      if (line.type === "del") {
        oldLines.push(line.text);
        continue;
      }
      if (newLines[cursor] !== line.text) throw new Error("diff does not match the current text");
      if (line.type === "context") oldLines.push(line.text);
      cursor += 1;
    }
  }
  while (cursor < newLines.length) {
    oldLines.push(newLines[cursor]);
    cursor += 1;
  }
  return oldLines;
}

function applyForward(oldLines, hunks) {
  const nextLines = [];
  let cursor = 0;
  for (const hunk of hunks) {
    const oldStart = hunk.oldStart === 0 ? 0 : hunk.oldStart - 1;
    if (oldStart < cursor) throw new Error("overlapping hunk");
    while (cursor < oldStart) {
      if (cursor >= oldLines.length) throw new Error("hunk starts past the end of the text");
      nextLines.push(oldLines[cursor]);
      cursor += 1;
    }
    for (const line of hunk.lines) {
      if (line.type === "add") {
        nextLines.push(line.text);
        continue;
      }
      if (oldLines[cursor] !== line.text) throw new Error("forward diff mismatch");
      if (line.type === "context") nextLines.push(line.text);
      cursor += 1;
    }
  }
  while (cursor < oldLines.length) {
    nextLines.push(oldLines[cursor]);
    cursor += 1;
  }
  return nextLines;
}

export function reverseUnifiedDiff(newText, diff) {
  const hunks = parseUnifiedDiff(diff);
  const current = splitFile(newText);
  const oldLines = applyReverse(current.lines, hunks);
  const roundTrip = applyForward(oldLines, hunks);
  if (
    roundTrip.length !== current.lines.length ||
    roundTrip.some((line, index) => line !== current.lines[index])
  ) {
    throw new Error("diff did not round-trip");
  }
  return joinFile(oldLines, current.trailing);
}

export function versionsFromEdits(currentBody, createdAt, edits) {
  const ordered = [...(edits || [])].sort((a, b) => String(a.editedAt).localeCompare(String(b.editedAt)));
  for (const edit of ordered) {
    if (!edit || edit.deletedAt || !edit.diff) throw new Error("edit history is incomplete");
  }
  const afterEdit = new Array(ordered.length);
  let body = String(currentBody ?? "");
  for (let index = ordered.length - 1; index >= 0; index -= 1) {
    afterEdit[index] = body;
    body = reverseUnifiedDiff(body, ordered[index].diff);
  }
  const versions = [{ body, at: createdAt }];
  for (let index = 0; index < ordered.length; index += 1) {
    versions.push({ body: afterEdit[index], at: ordered[index].editedAt });
  }
  return versions;
}

function versionsFor(comment) {
  if (comment && Array.isArray(comment.versions) && comment.versions.length) return comment.versions;
  return [{ body: comment && comment.body, at: comment && comment.created_at }];
}

export function attachEditHistory(comment, edits) {
  const list = edits || [];
  comment.editDiffs = list.map((edit) => (edit && edit.diff) || "");
  if (list.length === 0) throw new Error("edited comment has no edit history");
  comment.versions = versionsFromEdits(comment.body, comment.created_at, list);
  return comment;
}

export function blockEffectiveAt(comment, headSha) {
  // Missing history cannot prove the original body was clean, so an edited
  // comment from a reviewer stays a BLOCK until a newer PASS.
  if (comment && comment.historyUnavailable) {
    return comment.updated_at || comment.created_at || "9999-12-31T23:59:59Z";
  }
  let earliest = null;
  let earliestMs = null;
  for (const version of versionsFor(comment)) {
    if (commentKind(version.body, headSha) !== "block") continue;
    const at = version.at || "9999-12-31T23:59:59Z";
    const ms = timeMs(at);
    const comparable = ms === null ? Number.POSITIVE_INFINITY : ms;
    if (earliestMs === null || comparable < earliestMs) {
      earliestMs = comparable;
      earliest = at;
    }
  }
  return earliest;
}

export function isQualifyingPass(comment, headSha) {
  if (!comment || comment.historyUnavailable || commentWasEdited(comment)) return false;
  if (!comment.created_at || timeMs(comment.created_at) === null) return false;
  const versions = versionsFor(comment);
  if (versions.length !== 1) return false;
  return commentKind(comment.body, headSha) === "pass" && commentKind(versions[0].body, headSha) === "pass";
}

export function classifyReview(comments, headSha) {
  const pass = [];
  const block = [];
  for (const comment of comments || []) {
    if (!isReviewBot(comment)) continue;
    const blockAt = blockEffectiveAt(comment, headSha);
    if (blockAt) {
      block.push({ ...comment, blockAt });
      continue;
    }
    if (isQualifyingPass(comment, headSha)) pass.push(comment);
  }
  const inForce = block.filter((item) => {
    const blockedMs = timeMs(item.blockAt);
    if (blockedMs === null) return true;
    return !pass.some((itemPass) => {
      const passMs = timeMs(itemPass.created_at);
      return passMs !== null && passMs > blockedMs;
    });
  });
  if (inForce.length) {
    return { conclusion: "failure", reason: "block", pass, block: inForce };
  }
  if (pass.length) {
    return { conclusion: "success", reason: "pass", pass, block: inForce };
  }
  return { conclusion: "failure", reason: "missing", pass, block: inForce };
}

export function summaryFor(result, headSha) {
  const lines = [
    `Head SHA: \`${headSha}\`.`,
    "",
    `Only an unedited PASS from ${REVIEW_APP_LOGIN} counts.`,
    "A BLOCK stays in force until a newer PASS for this SHA. Editing a BLOCK does not lift it.",
    `The binding result is the commit status \`${STATUS_CONTEXT}\`, posted only from main.`,
  ];
  if (result.reason === "pass") {
    const ids = result.pass.map((comment) => comment.id).filter(Boolean).join(", ");
    lines.splice(1, 0, `PASS comment${result.pass.length === 1 ? "" : "s"}: ${ids || "(no id)"}.`);
    return lines.join("\n");
  }
  if (result.reason === "block") {
    const ids = result.block.map((comment) => comment.id).filter(Boolean).join(", ");
    lines.splice(
      1,
      0,
      `BLOCK comment${result.block.length === 1 ? "" : "s"}: ${ids || "(no id)"}. A newer unedited PASS for this SHA is required.`,
    );
    return lines.join("\n");
  }
  lines.splice(1, 0, `No qualifying \`${PASS_PREFIX} ${headSha}\` from ${REVIEW_APP_LOGIN}.`);
  return lines.join("\n");
}

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

function reviewComment(id, body, at, extra) {
  return {
    id,
    body,
    created_at: at,
    updated_at: at,
    versions: [{ body, at }],
    user: { login: REVIEW_APP_LOGIN, type: "Bot" },
    performed_via_github_app: { id: REVIEW_APP_ID },
    ...extra,
  };
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

  assert(REVIEW_APP_LOGIN === "motorunit-aidanos-bots[bot]", "app login");
  assert(REVIEW_APP_ID === 5413571, "app id");
  assert(isReviewBot(reviewComment(1, "x", "2026-10-18T00:00:00Z")), "app bot");
  assert(
    isReviewBot({ user: { login: REVIEW_APP_LOGIN, type: "Bot" }, performed_via_github_app: null }),
    "app id is optional when the field is absent",
  );
  assert(
    !isReviewBot({
      user: { login: "MotorUnitRoot", type: "User" },
      performed_via_github_app: null,
    }),
    "user account is not the app",
  );
  assert(
    !isReviewBot({
      user: { login: REVIEW_APP_LOGIN, type: "User" },
      performed_via_github_app: { id: REVIEW_APP_ID },
    }),
    "look-alike login without type Bot",
  );
  assert(
    !isReviewBot({
      user: { login: REVIEW_APP_LOGIN, type: "Bot" },
      performed_via_github_app: { id: 1 },
    }),
    "different app id",
  );

  const stamp = "2026-10-18T00:00:00Z";
  assert(!commentWasEdited({ created_at: stamp, updated_at: stamp }), "unedited");
  assert(!commentWasEdited({ body: "no timestamps" }), "timestamps absent");
  assert(commentWasEdited({ created_at: stamp, updated_at: "2026-10-18T00:00:01Z" }), "edited");
  assert(eventPublishesStatus("issue_comment"), "comment job publishes");
  assert(eventPublishesStatus("pull_request_target"), "target job publishes");
  assert(!eventPublishesStatus("pull_request"), "advisory job does not publish");
  assert(STATUS_CONTEXT === "independent-review/approved", "status context");

  const t0 = "2026-10-18T00:00:00Z";
  const t1 = "2026-10-18T00:00:01Z";
  const t2 = "2026-10-18T00:00:02Z";
  const t3 = "2026-10-18T00:00:03Z";

  const pass = classifyReview([reviewComment(1, `${PASS_PREFIX} ${sha}`, t0)], sha);
  assert(pass.conclusion === "success" && pass.reason === "pass", "app bot pass for this sha");

  const missing = classifyReview([reviewComment(2, `see ${sha}`, t0)], sha);
  assert(missing.conclusion === "failure" && missing.reason === "missing", "sha mention is not a review");

  const blocked = classifyReview(
    [reviewComment(3, `${PASS_PREFIX} ${sha}`, t0), reviewComment(4, `${BLOCK_PREFIX} ${sha}`, t0)],
    sha,
  );
  assert(blocked.conclusion === "failure" && blocked.reason === "block", "block wins at the same time");

  const staleBlock = classifyReview(
    [reviewComment(5, `${BLOCK_PREFIX} ${other}`, t0), reviewComment(6, `${PASS_PREFIX} ${sha}`, t1)],
    sha,
  );
  assert(staleBlock.conclusion === "success", "block for another sha does not fail this head");

  const bare = classifyReview(
    [reviewComment(7, BLOCK_PREFIX, t0), reviewComment(8, `${PASS_PREFIX} ${sha}`, t0)],
    sha,
  );
  assert(bare.conclusion === "failure" && bare.reason === "block", "bare block still fails a pass that is not newer");

  const lifted = classifyReview(
    [reviewComment(9, `${BLOCK_PREFIX} ${sha}`, t0), reviewComment(10, `${PASS_PREFIX} ${sha}`, t1)],
    sha,
  );
  assert(lifted.conclusion === "success" && lifted.reason === "pass", "newer pass lifts an older block");

  const editedBlock = reviewComment(11, `${PASS_PREFIX} ${sha}`, t0, {
    updated_at: t1,
    versions: [
      { body: `${BLOCK_PREFIX} ${sha}`, at: t0 },
      { body: `${PASS_PREFIX} ${sha}`, at: t1 },
    ],
  });
  const editKeepsBlock = classifyReview([editedBlock], sha);
  assert(editKeepsBlock.conclusion === "failure" && editKeepsBlock.reason === "block", "editing a block into a pass does not lift it");

  const editThenNewer = classifyReview([editedBlock, reviewComment(12, `${PASS_PREFIX} ${sha}`, t2)], sha);
  assert(editThenNewer.conclusion === "success", "a newer pass lifts a block that was edited away");

  const retarget = reviewComment(13, `${PASS_PREFIX} ${sha}`, t0, {
    updated_at: t1,
    versions: [
      { body: `${PASS_PREFIX} ${other}`, at: t0 },
      { body: `${PASS_PREFIX} ${sha}`, at: t1 },
    ],
  });
  const retargeted = classifyReview([retarget], sha);
  assert(retargeted.conclusion === "failure" && retargeted.reason === "missing", "an edited pass cannot name this sha");

  const becameBlock = reviewComment(14, BLOCK_PREFIX, t0, {
    updated_at: t2,
    versions: [
      { body: "thanks", at: t0 },
      { body: BLOCK_PREFIX, at: t2 },
    ],
  });
  const olderPass = classifyReview([reviewComment(15, `${PASS_PREFIX} ${sha}`, t1), becameBlock], sha);
  assert(olderPass.conclusion === "failure" && olderPass.reason === "block", "a pass older than the blocking edit does not lift it");
  const afterEdit = classifyReview([becameBlock, reviewComment(16, `${PASS_PREFIX} ${sha}`, t3)], sha);
  assert(afterEdit.conclusion === "success", "a pass after the blocking edit lifts it");

  const unknown = classifyReview(
    [
      reviewComment(17, "thanks", t0, {
        updated_at: t1,
        historyUnavailable: true,
      }),
    ],
    sha,
  );
  assert(unknown.conclusion === "failure" && unknown.reason === "block", "unreconstructed edit stays a block");
  const humanPass = classifyReview(
    [
      reviewComment(19, `${PASS_PREFIX} ${sha}`, t0, {
        user: { login: "MotorUnitRoot", type: "User" },
        performed_via_github_app: null,
      }),
    ],
    sha,
  );
  assert(humanPass.conclusion === "failure" && humanPass.reason === "missing", "a user PASS is ignored");
  const lookalike = classifyReview(
    [
      reviewComment(20, `${PASS_PREFIX} ${sha}`, t0, {
        user: { login: REVIEW_APP_LOGIN, type: "User" },
        performed_via_github_app: { id: REVIEW_APP_ID },
      }),
    ],
    sha,
  );
  assert(lookalike.conclusion === "failure" && lookalike.reason === "missing", "a look-alike login is ignored");
  const appBlock = classifyReview(
    [
      reviewComment(21, `${BLOCK_PREFIX} ${sha}`, t0),
      reviewComment(22, `${PASS_PREFIX} ${sha}`, t1, {
        user: { login: "MotorUnitRoot", type: "User" },
        performed_via_github_app: null,
      }),
    ],
    sha,
  );
  assert(appBlock.conclusion === "failure" && appBlock.reason === "block", "an app BLOCK stays in force");
  const plain = { id: 18, body: `${PASS_PREFIX} ${sha}`, created_at: t0, updated_at: t1 };
  let missingHistory = false;
  try {
    attachEditHistory(plain, []);
  } catch {
    missingHistory = true;
  }
  assert(missingHistory, "edited comment with no history fails closed");

  const current = `${PASS_PREFIX} ${sha}`;
  const diffToPass = `@@ -1 +1 @@\n-${BLOCK_PREFIX}\n+${current}\n`;
  assert(reverseUnifiedDiff(current, diffToPass) === BLOCK_PREFIX, "reverse a one-line edit");
  const withHeader = `diff --git a/body b/body\n--- a/body\n+++ b/body\n${diffToPass}`;
  assert(reverseUnifiedDiff(current, withHeader) === BLOCK_PREFIX, "reverse ignores git headers");
  const oldLines = `${BLOCK_PREFIX}\nstill wrong`;
  const newLines = `${current}\nstill wrong`;
  const contextDiff = `@@ -1,2 +1,2 @@\n-${BLOCK_PREFIX}\n+${current}\n still wrong\n`;
  assert(reverseUnifiedDiff(newLines, contextDiff) === oldLines, "reverse keeps surrounding lines");

  const versions = versionsFromEdits(current, t0, [
    { editedAt: t1, diff: `@@ -1 +1 @@\n-thanks\n+${BLOCK_PREFIX}\n` },
    { editedAt: t2, diff: diffToPass },
  ]);
  assert(versions[0].body === "thanks" && versions[0].at === t0, "original body");
  assert(versions[1].body === BLOCK_PREFIX && versions[1].at === t1, "middle body");
  assert(versions[2].body === current && versions[2].at === t2, "current body");
  let threw = false;
  try {
    versionsFromEdits(current, t0, [{ editedAt: t1, diff: null, deletedAt: t2 }]);
  } catch {
    threw = true;
  }
  assert(threw, "deleted edit history fails closed");

  const text = summaryFor(pass, sha);
  assert(text.includes(sha) && text.includes(REVIEW_APP_LOGIN), "summary");
  assert(text.includes(STATUS_CONTEXT), "summary names the status");
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

async function ghGraphql(query, variables) {
  const payload = await gh("/graphql", { method: "POST", body: { query, variables } });
  if (payload.errors && payload.errors.length) {
    throw new Error(payload.errors.map((error) => error.message).join("; "));
  }
  return payload.data;
}

async function listComments(owner, repo, number) {
  const comments = [];
  for (let page = 1; page <= 20; page += 1) {
    const batch = await gh(`/repos/${owner}/${repo}/issues/${number}/comments?per_page=100&page=${page}`);
    comments.push(...batch);
    if (batch.length < 100) break;
  }
  return comments;
}

async function listEdits(nodeId) {
  const edits = [];
  let cursor = null;
  for (let page = 0; page < 10; page += 1) {
    const data = await ghGraphql(
      `query($id: ID!, $cursor: String) {
        node(id: $id) {
          ... on IssueComment {
            userContentEdits(first: 100, after: $cursor) {
              pageInfo { hasNextPage endCursor }
              nodes { editedAt diff deletedAt }
            }
          }
        }
      }`,
      { id: nodeId, cursor },
    );
    const connection = data && data.node && data.node.userContentEdits;
    if (!connection) throw new Error("edit history is missing");
    const nodes = connection.nodes || [];
    if (nodes.some((node) => !node || node.deletedAt || !node.diff)) {
      throw new Error("edit history is incomplete");
    }
    edits.push(...nodes);
    if (!connection.pageInfo || !connection.pageInfo.hasNextPage) return edits;
    cursor = connection.pageInfo.endCursor;
  }
  throw new Error("edit history is too long");
}

async function commentsFromReviewers(comments) {
  const accepted = [];
  for (const comment of comments) {
    const login = comment && comment.user && comment.user.login;
    if (!isReviewBot(comment)) {
      const via = comment && comment.performed_via_github_app;
      const viaId = via && via.id;
      console.log(
        `Ignoring comment ${comment && comment.id} from ${login || "unknown"} (${(comment && comment.user && comment.user.type) || "no type"}${viaId ? `, app ${viaId}` : ""}).`,
      );
      continue;
    }
    if (commentWasEdited(comment)) {
      try {
        attachEditHistory(comment, await listEdits(comment.node_id));
      } catch (error) {
        console.log(`Could not reconstruct comment ${comment.id}: ${error.message}`);
        comment.historyUnavailable = true;
      }
    } else {
      comment.versions = [{ body: comment.body, at: comment.created_at }];
    }
    accepted.push(comment);
  }
  return accepted;
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
      context: STATUS_CONTEXT,
      description: description.slice(0, 140),
      target_url: runId && repository ? `${server}/${repository}/actions/runs/${runId}` : undefined,
    },
  });
}

function writeStepSummary(summary) {
  const path = process.env.GITHUB_STEP_SUMMARY;
  if (!path) return;
  fs.appendFileSync(path, `${summary}\n`);
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
  if (eventName === "pull_request" || eventName === "pull_request_target") {
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

  const comments = await commentsFromReviewers(await listComments(owner, repo, number));
  const result = classifyReview(comments, headSha);
  const summary = summaryFor(result, headSha);
  console.log(summary);
  writeStepSummary(summary);

  if (eventPublishesStatus(eventName)) {
    // Workflow source for these events is the default branch. Publish onto
    // the PR head and leave this job green when the review is missing.
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
