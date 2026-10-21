# Independent review

The binding gate is the commit status `independent-review/approved`. The GitHub App `motorunit-aidanos-bots` (App ID 5413571) posts it. GitHub Actions does not. No App key is stored in Actions.

## After this merges

The protect-main ruleset (id 25566271) requires the status `independent-review/approved` with the App `motorunit-aidanos-bots` as its expected source. A status from any other source does not count. That includes a personal token acting as MotorUnitRoot and a workflow added on a branch in this repo.

A new push leaves the new head with no status, so the pull request stays blocked until the App reviews that exact commit.

A human merge is still Colby's own click. The status does not merge the pull request.

## Posting a verdict

Mint an installation token where the App key lives, then run:

```
GITHUB_TOKEN="<installation token>" GITHUB_REPOSITORY=MotorUnitRoot/aidanos \
  node tools/post-review-verdict.mjs <pr> PASS <head sha>
```

Use `BLOCK` instead of `PASS` to reject. The script refuses when the pull request's current head is not that SHA. The comment's first line is exactly `Independent review: PASS <sha>` or `Independent review: BLOCK <sha>`. The status on that SHA is success for PASS and failure for BLOCK. The script never prints the token and never reads the App key.

If a BLOCK comment is deleted, that commit stays blocked. Run the script again with `BLOCK` and the same SHA. The App posts a new BLOCK comment and sets the failure status.

The advisory workflow reads comments and edit history. It does not post the status. No verdict yet leaves that check successful and the log says the advisory result is neutral. It is not the required check.

## What the gate does not do

MotorUnitRoot owns the App and could create a new key for it. The gate keeps the bots honest. It does not protect against the owner.
