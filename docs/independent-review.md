# Independent review

The binding gate is the commit status `independent-review/approved`. PASS is set only after Colby approves the `independent-review` environment. BLOCK is set by the same workflow in `independent-review-block`, which has no reviewer, so it applies as soon as the job starts. Both jobs mint an installation token for the GitHub App `motorunit-aidanos-bots` (App ID 5413571) and run `tools/post-review-verdict.mjs --status-only`.

Each environment has its own secret named `REVIEW_APP_PRIVATE_KEY`. Colby pastes the App private key into both before this merges. The repo does not store a copy. The App's permissions, including checks read, belong to the App. A new private key does not change them.

The advisory workflow reads comments. It does not post the status.

## Posting a verdict

On the pull request, comment as one of two login names: `MotorUnitRoot` or `motorunit-aidanos-bots[bot]`. That allowlist is `VERDICT_AUTHORS`. It is the comment author's login, not GitHub's author association. The first line is the whole verdict. Later lines are ignored. The line is exactly one of:

```
Independent review: PASS <40-character head sha>
Independent review: BLOCK <40-character head sha>
```

A comment from any other login is ignored. A line that is not one of those two forms is ignored. A bare `BLOCK` with no SHA is ignored here. The advisory check still treats a bare `BLOCK` from the App as blocking the current head. This job does not, because it has to name the commit it is about to mark.

The workflow runs from `main`, because `issue_comment` uses the default branch's workflow file. The parse job is read-only and has no secrets. It reads the comment and the pull request head. If the head has moved past the verdict's commit, the parse job fails and the status is not set.

If the head still matches, the post job's name is the pull request number, `PASS` or `BLOCK`, and the short commit. PASS waits in `independent-review`. Approve that deployment to set the success status. Reject it to leave the status unset. BLOCK uses `independent-review-block` and does not wait for a reviewer.

The workflow has no concurrency group. Concurrency is only on the post job, one group per pull request and verdict, with cancel-in-progress off. A PASS job is not in the BLOCK group, and a comment that is not a verdict never starts a post job, so neither can cancel or replace a queued BLOCK. A post job that is already running is not cancelled.

Before the post job writes the status, it fetches the verdict comment again. If that comment was edited or deleted, it writes nothing. For PASS it also writes nothing when the pull request head has moved, when the latest `independent-review/approved` status on that commit is already failure, or when a later BLOCK comment for that commit was posted by one of the two login names above. A BLOCK line from any other login does not do that.

The post job does not post a second comment. `--status-only` only writes the status. On a BLOCK it still fails an existing `independent-review/approved` check run before it writes the failure status, and it still writes nothing if those failure writes do not succeed. An earlier PASS stays green until a BLOCK is retried and succeeds.

`REVIEW_MODE` in `tools/post-review-verdict.mjs` is `status`. Switching to `check-run` is a change to that constant.

## If a BLOCK fails

A failed BLOCK does not post a success and does not clear an earlier PASS. Retry it. Re-run the failed job, or edit the BLOCK comment so the workflow starts again. BLOCK does not ask for approval. Do not merge on the strength of the older PASS.

## What can be tested before merge

`issue_comment` runs `.github/workflows/independent-review-post.yml` from `main`, not from the pull request. This pull request cannot start the post job. Both environments, including both copies of the key, have to exist before merge or the first live run has nowhere to read the key. The live test is after merge: comment a BLOCK and confirm it sets the failure without an approval, then comment a PASS, approve `independent-review`, and confirm the success comes from `motorunit-aidanos-bots`.

The pull request checks do run the script's self-test, including the allowlist, the moved-head refusal, the comment re-check, `--status-only`, the `check_name` lookup, and the rate-limit versus permission errors.

## Walkthrough

Create both environments before merging. The API calls from this session were refused with 403 (`administration=write` for environments, `actions_variables=write` for the variable). Do not put the private key anywhere except the two environment secrets.

1. Create `independent-review` for PASS. Required reviewer: MotorUnitRoot (user id 146015017). Leave "Prevent self-review" off, because the verdict comment may be posted as MotorUnitRoot and that same login approves the deployment. Deployment branches: selected branches, only `main`.

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

The App's permissions stay on the App. That includes checks read. Pasting a new key, or rotating the key, does not grant or remove those permissions.

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

MotorUnitRoot owns the App and could create a new key for it. The gate keeps the bots honest. It does not protect against the owner. Anyone who can approve the `independent-review` environment can have the job set a PASS. Today that reviewer is MotorUnitRoot. BLOCK does not wait for that approval.
