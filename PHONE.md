# AidanOS phone cut (PWA)

Weekend path: Progressive Web App via Safari **Add to Home Screen**. Not App Store. Vault stays markdown (`AIDANOS_VAULT` / sibling `vault/`).

## Live sit URL (tonight)

https://beach-candy-projects-retained.trycloudflare.com

Shop tunnel in front of 3847. Quick tunnel — fine for a sit; not the forever host.

## Add to Home Screen (iPhone)

1. Open the URL above in **Safari** (not Chrome).
2. Tap **Share** → **Add to Home Screen**.
3. Name stays **AidanOS**; tap **Add**.
4. Launch from the home screen icon — runs standalone.

## LAN bind (his Mac, his vault)

Default bind is localhost only. For phone on the same Wi‑Fi against `~/Grok/motorunit`:

```bash
AIDANOS_HOST=0.0.0.0 AIDANOS_VAULT=~/Grok/motorunit PORT=3847 node server.mjs
```

Open `http://<mac-lan-ip>:3847` in Safari → Add to Home Screen.

## Cloud Run

`Dockerfile` sets `PORT=8080` and `AIDANOS_HOST=0.0.0.0`. Deploy when a GCP project is ready. Point vault at a synced markdown folder (Drive/GCS as a dumb file replica — not a second store).

## Morning sit (Designer)

1. Safari on iPhone → open the HTTPS URL → Share → Add to Home Screen → launch AidanOS.
2. Door: Get to Work and Capture thoughts are the same hairline. Empty Get to Work opens Today with Write.
3. Type a line on Today; leave and return — it stays.
4. Bounce if Door is unusable, Capture is underline-only, or a CRM screen shows.

## Note for Aide-de-camp

Overnight cut is a PWA (not TestFlight): phone opens AidanOS via Safari Add to Home Screen. Code has LAN bind (`AIDANOS_HOST`), responsive Door/Today, manifest, service worker, and a Cloud Run Dockerfile. Live sit URL is the Cloudflare quick tunnel above in front of 3847. His MotorUnit vault on the Mac remains the real disk for day-to-day — run on the Mac with `AIDANOS_HOST=0.0.0.0` or deploy Cloud Run with a synced vault copy. Not blocked on Apple Developer. Blocked on a durable public host only if we want GCP Cloud Run instead of a tunnel/LAN — that needs a GCP project login Aide can unblock.
