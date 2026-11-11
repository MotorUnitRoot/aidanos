# AidanOS on iPhone — private Tailscale path

Native sync and the Safari home-screen web app are different paths. These steps
are for the native Mac/iPhone sync cut. Do not use the old home-Wi-Fi `--lan`,
wildcard `AIDANOS_HOST=0.0.0.0`, or historical quick-tunnel instructions for notes.
Nothing here authorizes a deploy or a public relay. Loopback is not proof of locality;
a same-machine headerless proxy cannot be identified by a socket address. Production
refuses forwarding hints and configured/unreadable Serve/Funnel state on every route.

## Connect the native iPhone and Mac

1. Install Tailscale on the Mac and iPhone; connect both to the same trusted tailnet.
   Limit tailnet grants/firewall access to the intended devices and relay port.
   The Mac needs the `tailscale` CLI on PATH and its daemon running.
2. Follow [the native setup](docs/native/TRY-IT.md) for Xcode, the two app builds,
   the separate relay folder, and the sync token file. Start with dummy notes.
3. On the Mac, `tailscale ip -4` shows its `100.x.y.z` IPv4. The supported range is
   **100.64.0.0/10** (second octet 64–127), not every `100.x` address. Start the relay:
   ```sh
   cd aidanos/relay
   node src/server.mjs --vault "$HOME/aidanos-relay-notes" --lan
   ```
   Keep the token-file environment setting from the setup guide. Do not print it.
4. The relay prints `PHONE ws://100.x.y.z:3750`. Enter that exact literal address
   on **both** apps, including the Mac app. Set the port to the printed port if
   different. A normal native app no longer sends credentials to loopback.
5. Put the existing sync token only in the masked token field and press Connect.
   `ws://` to a direct Tailscale IPv4 uses Tailscale encryption, not Wi-Fi plaintext.
   Do not share, proxy, port-forward or publicly expose this direct relay.

`--lan` and `--lan-address` refuse home/private/public/wildcard addresses and a
CGNAT IP not owned by both a local interface and the running Tailscale daemon.
There is no fallback to home Wi-Fi. Raw IPv6 and plain `ws://` MagicDNS names are
not supported. With no Tailscale, leave the apps offline; do not weaken the gate.

### Optional authenticated TLS path — not yet device-verified

The Apple client accepts `wss://relay.tail.ts.net` (default port 443) only with
system certificate-chain and hostname validation. It refuses redirects and never
falls back to plaintext. Plain `ws://` MagicDNS is refused to avoid DNS rebinding.
The server itself has no TLS listener: this path needs a separately reviewed,
private TLS front end, an exact `AIDANOS_RELAY_TRUSTED_HOSTS=relay.tail.ts.net:443`
allow-list entry, and a trusted tailnet grant. It is not an instruction to set one
up. Do not use Funnel or any public endpoint. **Reset must never be combined with
Serve/Funnel or any proxy**, even in tests. Direct `ws://100.x:port` remains the
smallest iPhone path and needs no TLS front end.

## Verify on a real Mac/iPhone before real notes

**Not verified from the Linux box. Use only disposable dummy notes until done.**

- [ ] Build AidanCore tests and both apps; run the new RelayAddress tests and all
      simulator tests, including separate-admin reset. Do not change deadlines.
- [ ] Confirm both devices' Tailscale addresses, narrow grants and Mac firewall;
      confirm the listener is the Mac's Tailscale IP, not Wi-Fi or every interface.
- [ ] Connect with `ws://100.x:3750` from the real iPhone and Mac. Check iOS local
      network prompts/routing; do not assume ATS exceptions make this work.
- [ ] Edit dummy notes on both, test airplane mode, sleep/wake and reconnect;
      confirm identical markdown and no lost edits. Check reachability off Wi-Fi.
- [ ] Reject ordinary LAN/public addresses, bad schemes and `ws://` DNS names
      before credentials leave the app. For optional WSS, test a good certificate,
      an invalid/untrusted certificate, mismatched hostname and redirect refusal.
- [ ] Production `/reset` stays 404 even with its old opt-in variable and sync
      token. No test flags/admin authority in app, Docker, launchd or real-note use.
- [ ] Reviewer, CISO and Designer clear this new head; Colby separately authorizes
      any push/workflow scope, merge or deployment before using real notes.

## Safari home-screen app (PWA)

A PWA still opens an approved, freshly verified web-app URL in Safari → Share →
Add to Home Screen. It is not the native `ws://` relay and cannot use that URL as
a web page. The old quick-tunnel URL is not a current verified service. The same
Door/Get to Work/Capture UI checks still apply. Hosting or public exposure needs
its own approval; no Cloud Run or tunnel command is authorized by this runbook.
