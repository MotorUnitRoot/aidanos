# Approval gate

The required check on `main` is a commit status named `approval-gate`. It is green only for the pull request's current commit, and only when Colby has approved that exact commit.

Colby's GitHub user id is `146015017`. The gate matches that number. It does not trust the login text `MotorUnitRoot`, because a different account could use a similar name.

Either of these turns the check green:

- Colby submits an approving review on that commit, and that approving review is his latest review on the pull request, including reviews that were dismissed. A dismissed approval does not count. An approval of an older commit does not count. If he approves and then requests changes, and someone dismisses that changes request, the older approval does not come back. The gate stays red. A new approving review on the current commit is what turns it green again. A PASS comment does not undo that dismissed changes request.
- Colby posts a comment whose first line is exactly `Independent review: PASS` followed by the full 40-character commit id. The comment must be unedited. It must not have been posted through a GitHub App.

Anything else leaves the check waiting: `Waiting for Colby on <short commit>`. Waiting still blocks a required check.

These turn the check red. A red result stays red for that commit even if Colby also approved. The gate reads its own earlier statuses on that commit. If it ever wrote a failure for a BLOCK or for a bot approval, it stays red after the comment or review is gone. Deleting the comment does not clear it.

- An approving review, a PASS comment for this commit, or a PASS line in a review body, from any bot or app. That includes `motorunit-aidanos-bots`, the gate App itself, `motorunit-bot`, `cursor[bot]`, any account whose name ends in `[bot]`, and a PASS or approval posted through a GitHub App even when the account looks like Colby. An ordinary comment posted through an app is not an approval and does not by itself turn the gate red.
- A bot or app comment that was edited, when GitHub will not return the edit history. The gate cannot prove that comment was never a PASS, so it goes red.
- A comment whose first line is `Independent review: BLOCK`, with or without the commit id, from Colby, from the App, or from anyone else. A bot can make the gate stricter. A bot cannot make it green. AidanOS is a public repository, so anyone can post that BLOCK and hold the commit. This gate does not limit who may BLOCK. Limiting it is Colby's decision.

Requesting changes is not a red block. It only means that person's approval no longer counts, so the gate goes back to waiting unless a PASS comment from Colby still qualifies. Dismissing that changes request is different: the older approval stays withdrawn and the gate is red.

The status is written by a new GitHub App that only Colby creates. It is not written by the shared `motorunit-aidanos-bots` App, and it is not written by the normal Actions token. The Actions job that runs the gate is named `judge`. The status context stays `approval-gate`. Do not pick a job named `approval-gate` as the required check. A workflow in a pull request that names a job `approval-gate` and exits successfully does not satisfy this check. The branch protection rule must name this App's id, not "any source".

The old status `independent-review/approved` is not this gate. Do not add it to the required checks. A PASS from `motorunit-aidanos-bots[bot]` is not an approval.

The Dependabot shortcut is not built. It stays off. There is no hardware-key sign-off in this step.

The gate reads the reviews, the comments, and the head again from GitHub just before it writes, and it writes that second result only to the commit it judged. If a new commit landed in between, it writes nothing. Push, comment, review, and manual runs for the same pull request share one concurrency group, so two overlapping runs cannot leave an older green in place. If GitHub returns an error after the head commit has been read, the gate writes `pending` with the description `gate error` on that commit. The error text is not copied into the status. An earlier green does not stay up.

## What Colby does by hand

These three steps stay on Colby's own device. Do not put the private key on the shared computer, in the repository, or in a chat.

### 1. Create the gate App and install it on AidanOS only

In GitHub, create a GitHub App named `motorunit-approval-gate`. Give it only these permissions:

- Commit statuses: Read and write
- Pull requests: Read-only
- Contents: Read-only
- Metadata: Read-only (GitHub turns this on with the others)

Do not grant contents write, issues, administration, workflows, or pull request write. The App must not be able to approve a pull request or push code.

Install the App on the AidanOS repository only (`MotorUnitRoot/aidanos`). Do not install it on Grok or on aidanos-vault.

Leave the App id visible. You will paste that number in the next step. It is the same number you will later pin in the branch rule.

### 2. Make the key on your own device and paste it into GitHub

On your own device, generate a private key for this App and download it. Do not generate it on the shared computer.

In the AidanOS repository settings, create an environment named `approval-gate`.

- Deployment branches: selected branches, only the branch named `main`. Do not add any other branch.
- Deployment tags: none. Do not add a tag rule. A tag must not be able to read the key.
- Required reviewers: none. The environment is only a lockbox for the key. Your review on the pull request is the human approval.

On that environment, create two secrets (not repository secrets, and not the shared App's key):

- `APPROVAL_GATE_APP_ID`: the App's numeric id
- `APPROVAL_GATE_APP_PRIVATE_KEY`: the private key you just downloaded

Paste the key from your own device straight into the secret field. Then delete the downloaded key file. Do not leave a copy on a computer that bots can read.

The workflow reads those two secrets only when it runs from `main`. A pull request branch cannot read them.

### 3. After the live tests, require the check

After this has merged to `main` and the live tests below look right, edit the main branch rule. Add a required check:

- Context: `approval-gate`
- Source: the new gate App's id (the same number as `APPROVAL_GATE_APP_ID`)

Do not choose "any source". Do not add `independent-review/approved`. Leave the checks that are already required (`tests`, `syntax`, `typecheck`, `eslint`, `no-runtime-deps`, `gitleaks`) as they are.

Until this is required, a green or missing `approval-gate` status does not by itself stop a merge. Add it only after the live tests.

## Live tests

Run these on a throwaway pull request after the App and the environment exist. Read the check. Do not merge the throwaway pull request.

1. Open a new pull request as `motorunit-bot`. The gate should say it is waiting for Colby. It should not be green.
2. On your phone, approve that pull request as yourself. The gate should turn green. Push another commit. The new commit should go back to waiting. The approval of the old commit must not count.
3. On the new commit, comment `Independent review: PASS` plus the full commit id. The gate should turn green. Edit that comment. The gate should go back to waiting.
4. On an ordinary pull request (not a Dependabot security update), have the shared App approve it. The gate should turn red, including when you have also approved it.
5. Open a pull request that adds its own job named `approval-gate` and make that job pass. The pull request should still be blocked. That job comes from Actions, not from the gate App.
6. Read the branch rule. Confirm `approval-gate` is pinned to the new App's id and not to "any source". You do not need to forge a status with the shared App's key. The pin is the proof.
7. Dependabot path: not active. Do not run this yet. When phase 2 is built, the test is a real Dependabot security update that the App approved (gate green), then a push to that branch by `cursor[bot]` (gate waiting or red). Launch does not include that path.
8. From the Actions tab, open the workflow named `approval-gate`, choose Run workflow, and select a branch that is not `main`. The `approval-gate` environment must refuse the job before it starts. The run must not mint a token and must not write a status. That refusal is the proof the deployment branch rule is `main` only and that there is no tag rule. Then run the same workflow from `main`, with the throwaway pull request number, and confirm the environment allows that run.

## Manual re-check

From the Actions tab, on `main`, run the workflow named `approval-gate`. The input is the pull request number. The run uses the workflow on `main` and the `approval-gate` environment. Live test 8 is the check that a run from any other branch is refused.

A review (approve, request changes, or dismiss) is picked up by a small relay workflow that has no secrets and does not check out code. The judgment still runs from `main`. If a pull request breaks that relay, the gate is simply not re-checked until the next push, comment, or manual run. Breaking the relay cannot turn the gate green.

## What the workflows refuse to do

- A `pull_request_target` job never checks out or runs the pull request's code. It checks out the default branch commit.
- A pull request title, body, or comment is never placed inside a shell command. The scripts read the pull request number and then load the pull request from the API.
- Reviews and comments are read page by page, so an approval past the first page still counts.
- The gate reads the reviews, the comments, and the head commit again immediately before writing, and writes only to the commit it judged.
