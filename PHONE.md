# AidanOS phone cut (PWA)

Weekend path: Progressive Web App via Safari **Add to Home Screen**. Not App Store. Vault stays markdown (`AIDANOS_VAULT` / sibling `vault/`). One web app on desktop and phone — same Door, same Capture.

## Live sit URL (tonight)

https://beach-candy-projects-retained.trycloudflare.com

Shop tunnel in front of 3847. Quick tunnel — fine for a sit and overnight while it stays up; not the forever host.

## Door locks (both surfaces)

1. **Get to Work** and **Capture thoughts** sit side by side, same hairline.
2. **Capture thoughts** opens a blank Capture note (empty paper) — no week strip, no day agenda rail.
3. **Get to Work** opens Today (week chrome). Empty Get to Work opens empty Today paper.

## Add to Home Screen (iPhone)

1. Open the URL above in **Safari** (not Chrome).
2. Tap **Share** → **Add to Home Screen**.
3. Name stays **AidanOS**; tap **Add**.
4. Launch from the home screen icon — runs standalone.

## LAN bind (his Mac, his vault) — usable tonight without GCP

Default bind is localhost only. For phone on the same Wi‑Fi against `~/Grok/motorunit`:

```bash
AIDANOS_HOST=0.0.0.0 AIDANOS_VAULT=~/Grok/motorunit PORT=3847 node server.mjs
```

Open `http://<mac-lan-ip>:3847` in Safari → Add to Home Screen.

## Cloud Run (ready when Colby says go)

`Dockerfile` already sets `PORT=8080` and `AIDANOS_HOST=0.0.0.0`, and installs `git` so Cloud Run can clone a private vault. The vault is a private git repo of markdown (target `MotorUnitRoot/aidanos-vault`). Not Drive, not a second database. The Mac keeps a working tree of that same repo; Cloud Run clones, serves, and commits on write.

When a GCP project is authorized:

```bash
# from the aidanos repo root (after live Door files are on main)
# Also set AIDANOS_VAULT_GIT_URL and a token secret (AIDANOS_VAULT_GIT_TOKEN or GITHUB_TOKEN).
gcloud run deploy aidanos \
  --source . \
  --region us-west1 \
  --allow-unauthenticated \
  --set-env-vars "AIDANOS_HOST=0.0.0.0,AIDANOS_VAULT_GIT_URL=https://github.com/MotorUnitRoot/aidanos-vault.git" \
  --port 8080
```

If the vault remote is not created yet, the service still boots. Local writes succeed; push failures show on `/api/health` as `git.error`. Do not put the token in the command line if you can bind it as a secret.

Then point Safari / Add to Home Screen at the Cloud Run HTTPS URL. Until then: keep the tunnel or use LAN.

## Overnight without waiting on GCP

1. Keep 3847 up and the Cloudflare tunnel pointed at it (shop process).
2. Or run LAN bind on his Mac with his real vault (best day-to-day disk).
3. Cloud Run when Aide/Colby unlocks a GCP project — recipe above, no Apple Developer.

## Morning sit (Designer)

1. Safari on iPhone → open the HTTPS URL → Share → Add to Home Screen → launch AidanOS.
2. Door: buttons side by side, same hairline; Capture → blank note; Get to Work → Today.
3. Type a line on Today; leave and return — it stays.
4. Bounce if buttons are stacked, Capture lands on Today week chrome, or a CRM screen shows.

## Note for Aide-de-camp

Overnight cut is a PWA (not TestFlight). Code has LAN bind (`AIDANOS_HOST`), responsive Door/Today, Capture blank note, manifest, service worker, and a Cloud Run Dockerfile. Live sit URL is the Cloudflare quick tunnel above. His MotorUnit vault on the Mac remains the real disk for day-to-day. Not blocked on Apple Developer. Durable public host = Cloud Run when a GCP project is ready; until then tunnel + LAN keep the phone usable.
