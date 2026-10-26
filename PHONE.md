# AidanOS phone cut (PWA)

Weekend path: Progressive Web App via Safari **Add to Home Screen**. Not App Store. Vault stays markdown (`AIDANOS_VAULT` / sibling `vault/`). One web app on desktop and phone — same Door, same Capture.

## Quick tunnel

There is no fixed public URL. A Cloudflare quick tunnel in front of port 3847 is for a sit while it stays up. It is not the forever host. The link changes every time the tunnel starts. `keep-tunnel.sh` needs `cloudflared` installed.

## Door locks (both surfaces)

1. **Get to Work** and **Capture thoughts** sit side by side, same hairline.
2. **Capture thoughts** opens a blank Capture note (empty paper) — no week strip, no day agenda rail.
3. **Get to Work** opens Today (week chrome). Empty Get to Work opens empty Today paper.

## Add to Home Screen (iPhone)

1. Open the current tunnel URL, the LAN address, or the Cloud Run URL in **Safari** (not Chrome).
2. Tap **Share** → **Add to Home Screen**.
3. Name stays **AidanOS**; tap **Add**.
4. Launch from the home screen icon — runs standalone.

The home-screen icons `icon-180.png`, `icon-192.png`, and `apple-touch-icon.png` are written into the container image by the `Dockerfile` when it is built. They are not in the repository yet, so a local `npm start` returns 'not found' for them.

## LAN bind — usable without GCP

Default bind is localhost only. From the repo root, for a phone on the same Wi‑Fi:

```bash
AIDANOS_HOST=0.0.0.0 AIDANOS_VAULT=/path/to/vault PORT=3847 node server.mjs
```

`/path/to/vault` is the markdown vault. Leave `AIDANOS_VAULT` unset to use the `vault/` folder next to `server.mjs`.

Open `http://<lan-ip>:3847` in Safari → Add to Home Screen.

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

1. Safari on iPhone → open the current HTTPS URL → Share → Add to Home Screen → launch AidanOS.
2. Door: buttons side by side, same hairline; Capture → blank note; Get to Work → Today.
3. Type a line on Today; leave and return — it stays.
4. Bounce if buttons are stacked, Capture lands on Today week chrome, or a CRM screen shows.

## Note for Aide-de-camp

Overnight cut is a PWA (not TestFlight). Code has LAN bind (`AIDANOS_HOST`), responsive Door/Today, Capture blank note, manifest, service worker, and a Cloud Run Dockerfile. The quick-tunnel link changes every time the tunnel starts. The day-to-day disk is the folder in `AIDANOS_VAULT`, or the sibling `vault/` when that variable is unset. Not blocked on Apple Developer. Durable public host = Cloud Run when a GCP project is ready; until then tunnel + LAN keep the phone usable.
