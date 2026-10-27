# AidanOS

AidanOS is a daily notebook that runs on your computer. The disk is a folder of markdown files, called the vault. It listens on this computer only.

## Run

You need Node 18 or newer. There is no `npm install`.

```
git clone https://github.com/MotorUnitRoot/aidanos.git && cd aidanos && ./start.sh
```

That starts the server in the background and prints the URL. Open http://127.0.0.1:3847/. The first screen asks, “What do you want to do today?” Foreground instead: `npm start`.

The vault is the `vault/` folder next to the app, or the folder named in `AIDANOS_VAULT`.

## Private vault (git)

The durable disk is a private git repo of markdown. The intended remote is `MotorUnitRoot/aidanos-vault`. This app repo does not create that remote.

On a Mac, the launchd agent in `launchd/com.aidanos.plist` starts the app from `~/Grok/motorunit/dashboard` and sets `AIDANOS_VAULT` to `~/Grok/motorunit`. That parent folder is the vault. The private remote is still `MotorUnitRoot/aidanos-vault`. The phone uses the hosted app; the server reads and writes these files. Before loading the agent, clear group and other write from the directory helper: `chmod go-w editor/bin editor/bin/dirfd-tool-*`. `launchd/install.sh` sets those modes.

Cloud Run (and any host) can clone that repo when these are set. Build the hosted image with `docker build --target production`. The test stage is not that image.

- `AIDANOS_VAULT_GIT_URL` — HTTPS git URL of the private vault
- `AIDANOS_VAULT_GIT_TOKEN` or `GITHUB_TOKEN` — token that can clone and push
- `AIDANOS_VAULT` — working tree path (optional; if unset with a git URL, the server clones into a dedicated directory and uses that as the vault)
- `AIDANOS_VAULT_CLONE` — override that dedicated clone path

The server's git ignores the host's global and system git config.

If the git env is unset, today’s local `vault/` behavior is unchanged. A missing remote must not stop the app: writes stay on local disk, and push failures are logged plus a `git` hint on `/api/health` and successful PUT bodies.

Two people (or the Mac and the phone) writing the same file at once is a conflict. The server refuses a silent overwrite (409 with the disk markdown and mtime). The paper then asks Keep mine, Take theirs, or Edit.

## The daily

The first screen is almost empty. Today is the day’s note. Plan is this season’s file: a title, why it matters, what comes next, and what is waiting. Ask finds across the vault. A result opens in the same note, not a preview.

The vault is the only store. There is not a second database, not a CRM, and not a shop of themes. Look and feel can live as a file in the vault. Delete that file and the default returns.

## Process maps

A process map is an ordinary markdown file in the vault. Copying the file is how you take the work. Deleting the file is how you drop it. There is not a catalog of workflows, and there is not a second product behind the map.

This repository ships two maps: reply to a letter, and file a receipt. Ask for that work, or name it at the door, and the next steps land on today’s note as ordinary tasks. You do not have to open the map first.

Ask for the map, or open a wiki link to it, and the file draws as a canvas: stages, one named fork, and Enter and Exit. A stage opens as paper with Why, Enter, Exit, and next steps. Those next steps are ordinary `- [ ]` lines on today. Copy the markdown file to take the map. Delete it to drop it. The first screen stays empty of this.

## Last-mile

When the work needs a place to write the letter or note the receipt, that place is another markdown file next to the map. It opens in the same note as the day. Those files are assembled from the design system already used for AidanOS. They are not a new look and not a CRM screen. Change the file, or delete it.

## What this is not

This is not Salesforce. It is not a second notes app. It is not the Tome. The phone can stay NotePlan, pulling into the same vault.

## Licensing

AidanOS is source-available under the Functional Source License, Version 1.1,
ALv2 Future License (`FSL-1.1-ALv2`). You may read, modify, and self-host it for
your own use. You may not offer AidanOS (or a substitute with substantially
similar functionality) as a competing commercial hosted product or service for
two years from each version’s release date. On the second anniversary of a
version’s release, that version becomes available under Apache License 2.0.

See [`LICENSE`](./LICENSE) for the full terms. Trademark rights in MotorUnit and
AidanOS are not granted by this license.

Prior releases under MIT remain available under MIT for those tagged versions
only. New commits and releases after this change are FSL-1.1-ALv2.

## Pins and the weekly scan

GitHub Actions installs Node from `.nvmrc`. That file says `22.23.4`. Every workflow reads the file, so the jobs stay on the same version.

Third-party actions are pinned to a full commit. The release number sits in a comment at the end of that line. GitHub's checkout and Node setup actions stay on the commits already recorded here, and they take the Node version from `.nvmrc`.

Dependabot checks GitHub Actions and Docker once a week. An ordinary version update waits 7 days before a pull request is opened. Security updates are a separate Dependabot feed. The 7-day wait applies to ordinary version updates.

`.github/workflows/flaw-scan.yml` runs every week, and whenever someone starts it by hand. It checks this repository and the built container image against public vulnerability databases (Trivy), CISA's Known Exploited Vulnerabilities list, and the published end-of-support dates for the Node version and the Linux distribution inside the hosted image. End of support is the day security fixes stop.

A finding is urgent in any of these cases:

- It is on CISA's Known Exploited Vulnerabilities list, the list of vulnerabilities already used in real attacks.
- It is critical severity and reachable from the internet. The hosted app's container image is reachable, and so is the server code that image runs. A critical finding in dev-only or CI-only tooling stays in the weekly summary.
- The hosted image's Node version, or the Linux distribution that image is built on, has reached its end-of-support date. The date itself counts.

The weekly summary names an end-of-support date starting 60 days before it. On that date, and after it, the same fact is urgent. That rule uses the hosted image. The summary also prints the Node version GitHub Actions installs from `.nvmrc`. The run fails when something is urgent. Everything else is listed in the summary, in severity order, with urgent items first. This scan is not a required check on pull requests.

The app still has no runtime npm dependencies.

### Tracked, not done yet

- Keep the Trivy download's sha256 in this repo, or check its cosign signature in an install step we own.
- Dependabot does not bump the Trivy version written in the workflow. A daily version check should cover that pin.
- An urgent finding should later open an issue or send an alert. Today the run only fails.
- GitHub turns off a scheduled workflow after 60 days with no activity. A daily check should confirm this scan ran.
