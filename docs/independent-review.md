# Independent review

The binding gate is the commit status `independent-review/approved`. A PASS is set only by the `post-pass` job, after Colby approves the `independent-review` environment. A BLOCK is set by the `post-block` job in `independent-review-block`, which has no reviewer, so it applies as soon as the job starts. A BLOCK on a commit stays failure. A later PASS for that same commit is refused. Only a new push, which is a new commit with no status, clears it.

Both jobs mint an installation token for the GitHub App `motorunit-aidanos-bots` (App ID 5413571) and run `tools/post-review-verdict.mjs --status-only`. The PASS token can write statuses and read pull requests and issue comments. The BLOCK token can write statuses, write checks, and read pull requests. `REVIEW_MODE` is `status`, so only BLOCK asks for checks, and only because a BLOCK fails an existing check run of the same name.

Each environment has its own secret named `REVIEW_APP_PRIVATE_KEY`. Colby pastes the App private key into both before this merges. The repo does not store a copy. The App's permissions, including checks read, belong to the App. A new private key does not change them. The PASS environment also has a variable `REVIEW_GATE_PASS_ENV` set to `1`. The script refuses a PASS without that variable. Do not set it on `independent-review-block` or as a repository variable. A repository variable would be visible to the BLOCK job too.

The advisory workflow reads comments. It does not post the status.

## Posting a verdict

On the pull request, comment as one of two login names: `MotorUnitRoot` or `motorunit-aidanos-bots[bot]`. That allowlist is `VERDICT_AUTHORS`. It is the comment author's login, not GitHub's author association. The first line is the whole verdict. Later lines are ignored. The line is exactly one of:

```
Independent review: PASS <40-character head sha>
Independent review: BLOCK <40-character head sha>
```

A comment from any other login is ignored. A line that is not one of those two forms is ignored. A bare `BLOCK` with no SHA is ignored here. The advisory check still treats a bare `BLOCK` from the App as blocking the current head. This job does not, because it has to name the commit it is about to mark.

The workflow runs from `main`, because `issue_comment` uses the default branch's workflow file. The parse job is read-only and has no secrets. It reads the comment and the pull request head. If the head has moved past the verdict's commit, the parse job fails and the status is not set.

If the head still matches, one of two jobs runs. `post-pass` is named with the pull request number, PASS, and the short commit, and it waits in `independent-review`. Approve that deployment to set the success status. Reject it to leave the status unset. `post-block` is named the same way with BLOCK, uses `independent-review-block`, and does not wait for a reviewer. The verdict word in each job is fixed in that job. The BLOCK job does not read the PASS gate variable.

The workflow has no concurrency group of its own. Each post job has its own group, one per pull request and verdict, with cancel-in-progress off. A PASS cannot cancel or replace a queued BLOCK. A waiting PASS holds the PASS slot until it is approved or rejected, so newer PASS runs queue behind it. GitHub cancels an older PASS that is only queued when a newer PASS joins that group, which drops the middle run. Reject the stale PASS first, the one waiting for approval, before you approve a newer one.

Before `post-pass` writes success, it fetches the PASS comment again. If that comment was edited or deleted, it writes nothing. It also writes nothing when the pull request head has moved, when `independent-review/approved` on that commit is already failure, or when any BLOCK for that commit exists from `MotorUnitRoot` or `motorunit-aidanos-bots[bot]`. The BLOCK can have been posted before the PASS, or an older comment can have been edited into a BLOCK. A BLOCK line from any other login does not count. `post-block` still writes the failure if its own comment was edited or deleted after parse. After that write it reads the status again and writes failure once more if a success landed in between.

The jobs do not post a second comment. `--status-only` only writes the status. On a BLOCK it still fails an existing `independent-review/approved` check run before it writes the failure status, and it still writes nothing if those failure writes do not succeed. An earlier PASS stays green until a BLOCK write succeeds. Once that failure is on the commit, it stays. A PASS will not clear it.

`REVIEW_MODE` in `tools/post-review-verdict.mjs` is `status`. Switching to `check-run` is a change to that constant.

## If a BLOCK fails

A failed BLOCK does not post a success and does not clear an earlier PASS. Retry it. Re-run the failed job, or post the BLOCK comment again. BLOCK does not ask for approval. Do not merge on the strength of the older PASS. A BLOCK that did get written is permanent for that commit.

## What can be tested before merge

`issue_comment` runs `.github/workflows/independent-review-post.yml` from `main`, not from the pull request. This pull request cannot start the post jobs. Both environments, both copies of the key, and `REVIEW_GATE_PASS_ENV=1` on `independent-review` only, have to exist before merge.

The pull request checks do run the script's self-test, including the allowlist, the moved-head refusal, the comment re-check, a BLOCK that outranks any PASS on that commit, the gate variable, `--status-only`, the `check_name` lookup, and the rate-limit versus permission errors.

## After merge, live

On a throwaway pull request, after the environments exist:

1. Comment a BLOCK for the current head. It sets `independent-review/approved` to failure with no approval prompt.
2. Comment a PASS for that same head and approve it as fast as the prompt appears. The PASS job must refuse. The failure stays. That is the "BLOCK, then a fast PASS approval" check.
3. Push a new commit. The new head has no `independent-review/approved` status. The old BLOCK does not apply to it.
4. Comment two PASS lines for the new head, then a third, without approving yet. The first waits and holds the PASS slot. Reject that stale PASS first. The middle run, the one that was only queued, is cancelled when the newer PASS is queued. Approve the remaining PASS and confirm the success comes from `motorunit-aidanos-bots`.

## Walkthrough

Create both environments before merging. The API calls from this session were refused with 403 (`administration=write` for environments, `actions_variables=write` for the variable). Do not put the private key anywhere except the two environment secrets.

1. Create `independent-review` for PASS. Required reviewer: MotorUnitRoot (user id 146015017), until Colby chooses a different approval account. Leave "Prevent self-review" off, because the verdict comment may be posted as MotorUnitRoot and that same login approves the deployment. Until a separate approval-only account is the only required reviewer, an agent that has MotorUnitRoot's credentials can both post a PASS and approve it. Which account is the required reviewer is Colby's decision. Deployment branches: selected branches, only `main`.

```
PUT /repos/MotorUnitRoot/aidanos/environments/independent-review
```

```json
{
  "prevent_self_review": false,
  "reviewers": [{ "type": "User", "id": 146015017 }],
  "deployment_branch_policy": {
    "protected_branches": false,
    "custom_branch_policies": true
  }
}
```

```
POST /repos/MotorUnitRoot/aidanos/environments/independent-review/deployment-branch-policies
```

```json
{ "name": "main", "type": "branch" }
```

2. Create `independent-review-block` for BLOCK. No required reviewers, so the job starts immediately. Deployment branches: only `main`.

```
PUT /repos/MotorUnitRoot/aidanos/environments/independent-review-block
```

```json
{
  "prevent_self_review": false,
  "reviewers": [],
  "deployment_branch_policy": {
    "protected_branches": false,
    "custom_branch_policies": true
  }
}
```

```
POST /repos/MotorUnitRoot/aidanos/environments/independent-review-block/deployment-branch-policies
```

```json
{ "name": "main", "type": "branch" }
```

3. In each environment, create a secret named `REVIEW_APP_PRIVATE_KEY` and paste the App private key. Same name, same key, two secrets. Delete any copy on a computer after both are saved. Do not also create a repository secret of that name.

On `independent-review` only, add an environment variable `REVIEW_GATE_PASS_ENV` with the value `1`. Not a secret. Not on `independent-review-block`. Not a repository or organization variable.

The App's permissions stay on the App. That includes checks read, and checks write for the BLOCK token's check-run update. Pasting a new key, or rotating the key, does not grant or remove those permissions.

4. Repository variable, not a secret:

```
POST /repos/MotorUnitRoot/aidanos/actions/variables
```

```json
{ "name": "REVIEW_APP_ID", "value": "5413571" }
```

5. After this merges, add `independent-review/approved` to ruleset 25566271 with `integration_id` 5413571. Keep the rules that are already there, including the required checks `tests`, `syntax`, `typecheck`, `eslint`, `no-runtime-deps`, and `gitleaks` (each pinned to integration id 15368). Add this object to that required-check list:

```json
{ "context": "independent-review/approved", "integration_id": 5413571 }
```

A new push then has no status on the new head, so the pull request stays blocked until this job records a PASS for that commit. The status does not merge the pull request. Merging is still Colby's own click.

The ruleset UI lists apps that have recently submitted a check. The REST field is the integer `integration_id`, and the REST docs do not add a recency requirement. If the picker does not list `motorunit-aidanos-bots`, set `integration_id` 5413571 through the API rather than saving the check as "any source".

## What the gate does not do

MotorUnitRoot owns the App and could create a new key for it. The gate keeps the bots honest. It does not protect against the owner.

Until a separate approval-only account is the only required reviewer on `independent-review`, an agent with MotorUnitRoot's credentials can both post a PASS and approve that deployment. The approval account is Colby's decision. BLOCK does not wait for that approval. A BLOCK that has been written is permanent for that commit, and only a new push clears it.
