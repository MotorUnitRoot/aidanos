# Independent review

**This is not the approval gate.** The binding check is [`approval-gate`](approval-gate.md). Do not add `independent-review/approved` to the ruleset.

The workflow that used to write that old status, `independent-review-post.yml`, is removed. `tools/post-review-verdict.mjs` does not post a PASS and does not write a success status, including when it is run with `--status-only`. A PASS from the `MotorUnitRoot` login is ignored. `approval-gate` is the only success status.

The script can still write a BLOCK failure for `independent-review/approved` if someone runs it by hand. Nothing in this repository starts that run. That old status is not the required check.

The GitHub environments `independent-review` and `independent-review-block`, and the secrets on them, are still there. This change does not delete environments or secrets. Deleting those two environments and their secrets is a separate step for Colby.

Do not paste a new copy of the shared App key to bring the old writer back.
