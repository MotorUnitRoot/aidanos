# Independent review

The binding gate is the commit status `independent-review/approved`. It is set only by the `independent-review-post` job, after Colby approves the `independent-review` environment. That job mints an installation token for the GitHub App `motorunit-aidanos-bots` (App ID 5413571) and runs `tools/post-review-verdict.mjs --status-only`. The App private key exists only as the environment secret `REVIEW_APP_PRIVATE_KEY`. Nothing else in this repo holds a copy.

The advisory workflow reads comments. It does not post the status.

## Posting a verdict

On the pull request, comment as MotorUnitRoot or as `motorunit-aidanos-bots[bot]`. The first line is the whole verdict. Later lines are ignored. The line is exactly one of:

```
Independent review: PASS <40-character head sha>
Independent review: BLOCK <40-character head sha>
```

`VERDICT_AUTHORS` in `tools/post-review-verdict.mjs` is that allowlist. A comment from anyone else is ignored. A line that is not one of those two forms is ignored. A bare `BLOCK` with no SHA is ignored here. The advisory check still treats a bare `BLOCK` from the App as blocking the current head. This job does not, because it has to name the commit it is about to mark.

The workflow runs from `main`, because `issue_comment` uses the default branch's workflow file. The parse job is read-only and has no secrets. It reads the comment and the pull request head. If the head has moved past the verdict's commit, the parse job fails and the status is not set.

If the head still matches, the post job waits in the `independent-review` environment. Its name is the pull request number, `PASS` or `BLOCK`, and the short commit, which is the same text in the step summary. Approve that deployment to set the status. Reject it to leave the status unset.

PASS and BLOCK both wait on that approval. The key lives in one place, so a BLOCK cannot skip the gate. A waiting BLOCK shows up as a deployment waiting for approval. Do not merge while one is waiting. Reject it if that BLOCK should not be recorded. One run is in progress per pull request, and a new comment does not cancel it. A run that is waiting for approval holds the queue, so a later comment is not parsed until that run finishes.

The post job does not post a second comment. `--status-only` only writes the status. On a BLOCK it still fails an existing `independent-review/approved` check run before it writes the failure status, and it still writes nothing if those failure writes do not succeed. An earlier PASS stays green until a BLOCK is retried and succeeds.

`REVIEW_MODE` in `tools/post-review-verdict.mjs` is `status`. Switching to `check-run` is a change to that constant.

## If a BLOCK fails

A failed BLOCK does not post a success and does not clear an earlier PASS. Retry it. Re-run the failed job, or edit the BLOCK comment so the workflow starts again, and approve the environment when GitHub asks. Do not merge on the strength of the older PASS.

## What can be tested before merge

`issue_comment` runs `.github/workflows/independent-review-post.yml` from `main`, not from the pull request. This pull request cannot start the gated job. The live test is after merge: comment a verdict on a pull request, confirm the job name shows the pull request, the verdict, and the short commit, approve it, and confirm `independent-review/approved` on that commit comes from `motorunit-aidanos-bots`.

The pull request checks do run the script's self-test, including the allowlist, the moved-head refusal, `--status-only`, the `check_name` lookup, and the rate-limit versus permission errors.

## Walkthrough

These calls were attempted and did not stick. Create them before relying on the workflow. Do not put the private key anywhere except the environment secret.

1. Create the environment `independent-review` with MotorUnitRoot (user id 146015017) as the required reviewer, self-review allowed, and a custom deployment branch policy:

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

`prevent_self_review` stays false because a verdict comment may be posted as MotorUnitRoot, and that same login has to approve the deployment.

2. Allow only `main` to deploy:

```
POST /repos/MotorUnitRoot/aidanos/environments/independent-review/deployment-branch-policies
```

```json
{ "name": "main", "type": "branch" }
```

In the environment settings this is "Selected branches" with `main` added and no other branch.

3. Repository variable, not a secret:

```
POST /repos/MotorUnitRoot/aidanos/actions/variables
```

```json
{ "name": "REVIEW_APP_ID", "value": "5413571" }
```

4. Environment secret `REVIEW_APP_PRIVATE_KEY`: paste the App private key. This is the only copy. Delete any copy on a computer after it is saved. Do not also create a repository secret of the same name.

5. After this merges, add `independent-review/approved` to ruleset 25566271 with `integration_id` 5413571. Keep the rules that are already there, including the required checks `tests`, `syntax`, `typecheck`, `eslint`, `no-runtime-deps`, and `gitleaks` (each pinned to integration id 15368). Add this object to that required-check list:

```json
{ "context": "independent-review/approved", "integration_id": 5413571 }
```

A new push then has no status on the new head, so the pull request stays blocked until this job records a PASS for that commit. The status does not merge the pull request. Merging is still Colby's own click.

The ruleset UI lists apps that have recently submitted a check. The REST field is the integer `integration_id`, and the REST docs do not add a recency requirement. If the picker does not list `motorunit-aidanos-bots`, set `integration_id` 5413571 through the API rather than saving the check as "any source".

## What the gate does not do

MotorUnitRoot owns the App and could create a new key for it. The gate keeps the bots honest. It does not protect against the owner. Anyone who can approve the `independent-review` environment can have the job set the status. Today that reviewer is MotorUnitRoot.
