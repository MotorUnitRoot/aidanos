#!/usr/bin/env node
/**
 * Comment parser kept from the independent-review work.
 *
 * A PASS from motorunit-aidanos-bots is not an approval. isQualifyingPass
 * returns false so this classifier cannot go green on an App PASS.
 * The binding check is the approval-gate status, judged by
 * .github/approval-gate.mjs.
 *
 * A BLOCK from the App still fails this advisory classifier. Each
 * edit-history entry is the full text after that edit. The most restrictive
 * version wins, so editing a BLOCK into a PASS does not lift it. The text
 * from before the first edit is not in the history, so an edited comment
 * stays a BLOCK. If the history cannot be read, the comment stays a BLOCK.
 * A deleted BLOCK stays a BLOCK. A bare BLOCK names no SHA and applies to
 * the current head.
 *
 * This file only reads. It does not post a status. No GitHub App key is
 * read here.
 */
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const PASS_PREFIX = "Independent review: PASS";
const BLOCK_PREFIX = "Independent review: BLOCK";

// The independent reviewer posts as this GitHub App. Change these together.
export const REVIEW_APP_LOGIN = "motorunit-aidanos-bots[bot]";
export const REVIEW_APP_ID = 5413571;

export const STATUS_CONTEXT = "independent-review/approved";

export function verdictLine(verdict, sha) {
  const normalized = String(sha || "").toLowerCase();
  if (verdict !== "PASS" && verdict !== "BLOCK") throw new Error("verdict must be PASS or BLOCK");
  if (!/^[0-9a-f]{40}$/.test(normalized)) throw new Error("reviewed sha must be 40 hex characters");
  return `Independent review: ${verdict} ${normalized}`;
}

function firstLine(body) {
  return String(body || "")
    .replace(/^\uFEFF/, "")
    .replace(/\r\n/g, "\n")
    .trimStart()
    .split("\n", 1)[0]
    .trim();
}

export function commentKind(body, headSha) {
  const sha = String(headSha || "").toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(sha)) return null;
  const line = firstLine(body);
  const block = line.match(/^Independent review: BLOCK(?:\s+([0-9a-fA-F]{40}))?$/);
  if (block) {
    if (!block[1]) return "block";
    return block[1].toLowerCase() === sha ? "block" : null;
  }
  const pass = line.match(/^Independent review: PASS\s+([0-9a-fA-F]{40})$/);
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

export function eventPublishesStatus() {
  return false;
}

export const COMMENT_PAGE_LIMIT = 1000;

export function commentListComplete(page, batchLength) {
  if (page > COMMENT_PAGE_LIMIT) throw new Error("comment list is too long");
  return batchLength < 100;
}

function timeMs(value) {
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

function normalizeNewlines(text) {
  return String(text ?? "").replace(/\r\n/g, "\n");
}

export function looksLikeUnifiedDiff(text) {
  const line = String(text || "").replace(/^\uFEFF/, "").split(/\r?\n/, 1)[0];
  return line.startsWith("@@ ") || line.startsWith("diff --git ") || line.startsWith("--- ");
}

export function versionsFromEdits(currentBody, createdAt, edits) {
  const ordered = [...(edits || [])].sort((a, b) => String(a && a.editedAt).localeCompare(String(b && b.editedAt)));
  if (ordered.length === 0) throw new Error("edited comment has no edit history");
  const versions = [];
  for (const edit of ordered) {
    if (!edit || edit.deletedAt || typeof edit.diff !== "string" || looksLikeUnifiedDiff(edit.diff)) {
      throw new Error("edit history is incomplete");
    }
    versions.push({ body: edit.diff, at: edit.editedAt || createdAt });
  }
  const newest = versions[versions.length - 1].body;
  if (normalizeNewlines(newest) !== normalizeNewlines(currentBody)) {
    throw new Error("newest edit does not match the current comment");
  }
  return versions;
}

function versionsFor(comment) {
  if (comment && Array.isArray(comment.versions) && comment.versions.length) return comment.versions;
  return [{ body: comment && comment.body, at: comment && comment.created_at }];
}

export function attachEditHistory(comment, edits) {
  const list = edits || [];
  if (list.length === 0) throw new Error("edited comment has no edit history");
  comment.versions = versionsFromEdits(comment.body, comment.created_at, list);
  // userContentEdits stores the text after each edit, not the original.
  comment.originalUnseen = true;
  return comment;
}

function latestTime(times) {
  let best = null;
  let bestMs = null;
  for (const at of times) {
    const ms = timeMs(at);
    if (ms === null) continue;
    if (bestMs === null || ms > bestMs) {
      bestMs = ms;
      best = at;
    }
  }
  return best || times[0] || null;
}

export function blockEffectiveAt(comment, headSha) {
  if (!comment) return null;
  // Missing history cannot prove the comment was never a BLOCK.
  if (comment.historyUnavailable) {
    return comment.deletedBlockAt || comment.updated_at || comment.created_at || "9999-12-31T23:59:59Z";
  }
  const times = [];
  for (const version of versionsFor(comment)) {
    if (commentKind(version.body, headSha) !== "block") continue;
    times.push(version.at || "9999-12-31T23:59:59Z");
  }
  if (comment.originalUnseen) times.push(comment.created_at || "9999-12-31T23:59:59Z");
  if (comment.deletedBlockAt && times.length) times.push(comment.deletedBlockAt);
  if (!times.length) return null;
  return latestTime(times);
}

export function deletedCommentForcesBlock(comment, headSha) {
  if (!isReviewBot(comment)) return false;
  if (comment.historyUnavailable || comment.originalUnseen || commentWasEdited(comment)) return true;
  return commentKind(comment.body, headSha) === "block";
}

export function isQualifyingPass(comment, headSha) {
  // Neutralized. An App PASS is not an approval, so this cannot return true.
  void comment;
  void headSha;
  return false;
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
    `A PASS from ${REVIEW_APP_LOGIN} is not an approval.`,
    "A BLOCK stays in force for this SHA. Editing or deleting a BLOCK does not lift it.",
    "The binding result is the commit status `approval-gate`.",
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
    ["sha on next line", `Independent review: PASS\n${sha}`, sha, null],
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
  assert(!eventPublishesStatus(), "actions does not publish the status");
  assert(commentListComplete(1, 100) === false, "full page continues");
  assert(commentListComplete(2, 3) === true, "short page ends");
  let tooLong = false;
  try {
    commentListComplete(COMMENT_PAGE_LIMIT + 1, 100);
  } catch {
    tooLong = true;
  }
  assert(tooLong, "comment paging fails closed past the last page");
  assert(STATUS_CONTEXT === "independent-review/approved", "status context");

  const t0 = "2026-10-18T00:00:00Z";
  const t1 = "2026-10-18T00:00:01Z";
  const t2 = "2026-10-18T00:00:02Z";
  const t3 = "2026-10-18T00:00:03Z";

  const pass = classifyReview([reviewComment(1, `${PASS_PREFIX} ${sha}`, t0)], sha);
  assert(pass.conclusion === "failure" && pass.reason === "missing", "an App PASS is not an approval");

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
  assert(
    staleBlock.conclusion === "failure" && staleBlock.reason === "missing",
    "a block for another sha is not a block here, and an App PASS is not an approval",
  );

  const bare = classifyReview(
    [reviewComment(7, BLOCK_PREFIX, t0), reviewComment(8, `${PASS_PREFIX} ${sha}`, t0)],
    sha,
  );
  assert(bare.conclusion === "failure" && bare.reason === "block", "bare block still fails a pass that is not newer");

  const lifted = classifyReview(
    [reviewComment(9, `${BLOCK_PREFIX} ${sha}`, t0), reviewComment(10, `${PASS_PREFIX} ${sha}`, t1)],
    sha,
  );
  assert(lifted.conclusion === "failure" && lifted.reason === "block", "an App PASS does not lift a BLOCK");

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
  assert(editThenNewer.conclusion === "failure" && editThenNewer.reason === "block", "an App PASS does not lift a block that was edited away");

  const retarget = reviewComment(13, `${PASS_PREFIX} ${sha}`, t0, {
    updated_at: t1,
    versions: [
      { body: `${PASS_PREFIX} ${other}`, at: t0 },
      { body: `${PASS_PREFIX} ${sha}`, at: t1 },
    ],
  });
  const retargeted = classifyReview([retarget], sha);
  assert(retargeted.conclusion === "failure" && retargeted.reason === "missing", "an edited pass cannot name this sha");
  const unseen = classifyReview(
    [reviewComment(13, `${PASS_PREFIX} ${sha}`, t0, { updated_at: t1, originalUnseen: true })],
    sha,
  );
  assert(unseen.conclusion === "failure" && unseen.reason === "block", "an unseen original stays a block");

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
  assert(afterEdit.conclusion === "failure" && afterEdit.reason === "block", "an App PASS after a blocking edit does not lift it");

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

  const below = `Independent review: BLOCK ${sha}\nalso see ${other}`;
  assert(commentKind(below, sha) === "block", "another sha below does not hide a block");
  const wrongFirst = `Independent review: BLOCK ${other}\n${sha}`;
  assert(commentKind(wrongFirst, sha) === null, "the sha is read only from the first line");
  const bareBelow = `Independent review: BLOCK\nsee ${other}`;
  assert(commentKind(bareBelow, sha) === "block", "a bare block ignores a later sha");
  assert(verdictLine("PASS", sha) === `${PASS_PREFIX} ${sha}`, "pass line");
  assert(commentKind(verdictLine("BLOCK", sha), sha) === "block", "block line");

  const deletedBlock = classifyReview(
    [
      reviewComment(23, `${PASS_PREFIX} ${sha}`, t1),
      reviewComment(24, `${BLOCK_PREFIX} ${sha}`, t0, { deletedBlockAt: t2 }),
    ],
    sha,
  );
  assert(deletedBlock.reason === "block", "deleting a block keeps the commit blocked");
  const deletedPass = reviewComment(25, `${PASS_PREFIX} ${sha}`, t0);
  assert(!deletedCommentForcesBlock(deletedPass, sha), "a deleted pass is not a block");
  assert(
    deletedCommentForcesBlock(reviewComment(26, `${BLOCK_PREFIX} ${sha}`, t0), sha),
    "a deleted block forces a block",
  );

  const fixtureUrl = new URL("./fixtures/user-content-edit.json", import.meta.url);
  const fixture = JSON.parse(fs.readFileSync(fileURLToPath(fixtureUrl), "utf8"));
  assert(fixture.edits[0].diff === fixture.body, "newest recorded edit is the full comment");
  assert(fixture.edits[1].diff !== fixture.body, "older recorded edit is an earlier full comment");
  assert(!looksLikeUnifiedDiff(fixture.edits[0].diff), "recorded edit is not a unified diff");
  const recorded = versionsFromEdits(fixture.body, fixture.createdAt, fixture.edits);
  assert(recorded[recorded.length - 1].body === fixture.body, "versions keep the full text");
  assert(recorded[0].body === fixture.edits[1].diff, "older version is the earlier full text");
  const recordedComment = reviewComment(27, fixture.body, fixture.createdAt, {
    updated_at: fixture.updatedAt,
  });
  attachEditHistory(recordedComment, fixture.edits);
  assert(recordedComment.originalUnseen === true, "the pre-edit text is unseen");
  assert(classifyReview([recordedComment], sha).reason === "block", "unseen original fails closed");
  let patchRejected = false;
  try {
    versionsFromEdits("b", t0, [{ editedAt: t1, diff: "@@ -1 +1 @@\n-a\n+b\n" }]);
  } catch {
    patchRejected = true;
  }
  assert(patchRejected, "a unified diff fails closed");
  let threw = false;
  try {
    versionsFromEdits("b", t0, [{ editedAt: t1, diff: null, deletedAt: t2 }]);
  } catch {
    threw = true;
  }
  assert(threw, "deleted edit history fails closed");

  const text = summaryFor(pass, sha);
  assert(text.includes(sha) && text.includes(REVIEW_APP_LOGIN), "summary");
  assert(text.includes("is not an approval"), "summary refuses an App PASS");
  assert(text.includes("approval-gate"), "summary names the approval gate");
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
  for (let page = 1; ; page += 1) {
    const batch = await gh(`/repos/${owner}/${repo}/issues/${number}/comments?per_page=100&page=${page}`);
    if (!Array.isArray(batch)) throw new Error("comment page is not a list");
    comments.push(...batch);
    if (commentListComplete(page, batch.length)) return comments;
  }
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
    if (
      nodes.some(
        (node) => !node || node.deletedAt || typeof node.diff !== "string" || looksLikeUnifiedDiff(node.diff),
      )
    ) {
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
  if (eventName === "issue_comment" && event.action === "deleted" && event.comment) {
    const deleted = event.comment;
    if (isReviewBot(deleted)) {
      if (commentWasEdited(deleted)) {
        try {
          attachEditHistory(deleted, await listEdits(deleted.node_id));
        } catch (error) {
          console.log(`Could not reconstruct deleted comment ${deleted.id}: ${error.message}`);
          deleted.historyUnavailable = true;
        }
      } else {
        deleted.versions = [{ body: deleted.body, at: deleted.created_at }];
      }
      if (deletedCommentForcesBlock(deleted, headSha)) {
        deleted.deletedBlockAt = new Date().toISOString();
        comments.push(deleted);
        console.log(`Deleted review comment ${deleted.id || "?"} stays in force.`);
      }
    }
  }
  const result = classifyReview(comments, headSha);
  const summary = summaryFor(result, headSha);
  console.log(summary);
  writeStepSummary(summary);

  // No verdict yet is not a failure. Actions does not post the binding status.
  if (result.reason === "missing") return;
  if (result.conclusion !== "success") process.exitCode = 1;
}

const isDirectRun = process.argv[1] && process.argv[1].endsWith("independent-review.mjs");
if (isDirectRun) {
  main().catch((error) => {
    console.error(error && error.stack ? error.stack : error);
    process.exit(1);
  });
}
