# AidanOS on iPhone — paired direct TLS design, not deployment approval

**Tailnet HTTPS enablement is still Colby's pending decision.** Nothing here
turns it on, requests a real certificate, provisions a key, deploys a service or
authorizes real notes. Swift/apps and real-device behavior remain unbuilt/unverified.

## Release path: direct Node TLS, no Serve/Funnel

Choose a neutral Mac machine name **before** enabling HTTPS or obtaining any cert.
Certificate Transparency publishes the machine and tailnet DNS names permanently.
See [Tailscale's CT warning](https://tailscale.com/kb/1153/enabling-https).
Wait for the explicit HTTPS decision, CISO/Reviewer review, and device checks below.

After those later approvals, the intended operator-controlled setup is:
1. Both devices join the intended trusted tailnet; restrict grants and Mac firewall
   to those devices/port. Confirm the Mac's exact MagicDNS name and `tailscale ip -4`.
   The relay accepts only a local IPv4 in **100.64.0.0/10**, confirmed by the daemon.
2. The operator obtains that exact name's certificate using `tailscale cert`, never
   Serve/Funnel. Keep its private key in a separate **relay-user-owned 0600 file**,
   outside repo, notes vault and relay data, with exactly one hardlink. Never paste a key into an env var,
   token field, QR, log, image or chat. `tailscale cert` issuance/HTTPS enablement
   has **not** been performed by this task. File-based renewal remains manual.
3. Node terminates TLS itself. Future command shape (paths/names are placeholders,
   not instructions to enable HTTPS now):
   ```sh
   node src/server.mjs --vault "$HOME/aidanos-relay-notes" --lan \
     --tls-name relay.example-tail.ts.net \
     --tls-cert-file "$HOME/.config/aidanos-relay/relay.crt" \
     --tls-key-file "$HOME/.config/aidanos-relay/relay.key" \
     --pairing-file "$HOME/.config/aidanos-relay/pairing.json"
   ```
   Retain the separate masked sync-token/token-file setup. No bearer is in the QR.
   Production refuses startup without TLS, including on loopback. The key is checked
   for regular-file/single-link status, owner/mode, symlinks, location and matching
   cert/name. Production has no dev/plaintext env or option switch.
4. In the Mac app, open the **public pairing JSON** generated locally by the relay.
   Its QR binds the exact `wss://name:port/`, exact Tailscale IPv4, and SHA256 SPKI.
   On the real iPhone, use **Pair / re-pair from Mac QR**, grant camera permission,
   and scan the QR physically shown on the approved Mac. Enter the sync token only
   in its masked field. Pairing is explicit, never learned from a network peer.
5. Both apps compare the exact approved address. Before connecting, IPv4 DNS answers
   must equal the stored 100.x address; the socket targets that literal IP to avoid
   a second DNS lookup. TLS verifies the approved DNS hostname through system trust
   **and** the stored DER-SPKI pin. A public CA signature alone is never sufficient.
   Other names/ports, changed/public DNS answers, bad certificates or keys fail closed.
   No redirects or plaintext fallback. Release raw ws code is compiled out.

Production refuses missing/erroring/malformed/nonempty `tailscale serve status
--json` at startup and rechecks on every HTTP/sync request. Forwarded,
X-Forwarded-* and Tailscale-* hints are rejected, never trusted. Loopback is only
bind scope: a local proxy that strips hints and holds a valid sync token cannot
be distinguished from a direct authorized client. This is the accepted limit,
not universal proxy detection. The boundary is the sync token plus TLS and the
approved paired peer, never a claim of locality.
Production artifacts contain no reset routing, admin authority or deletion code.
Only the excluded disposable test server has reset; never combine it with a proxy.

## Renewal and re-pair

The inspected Tailscale issuance source generates a fresh key on actual renewal.
An unchanged cached `tailscale cert` result is **not** a key-reuse guarantee. Plan
for **QR re-pair after each actual renewal/key change**. Restart Node with the new
separate certificate/key files, reload its local public pairing JSON on the Mac,
and explicitly rescan on the phone. Old pins refuse; nothing silently accepts a
new key merely because the CA signed it. Sources, scope and refresh rules are in
the in-repo [TLS design notes](docs/native/TLS.md#renewal-and-sources).

## Plaintext fixtures only — excluded from production

The production relay never starts sync without TLS. The excluded source-only
`relay/test/harness/dev-plaintext.mjs` requires explicit `--dev-plaintext`, binds
only loopback, and forcibly disables reset. It is absent from npm packages and
Docker input; production never imports it and has no env/option bypass. It is
for disposable synthetic fixtures only, never real notes or credentials.

The native raw ws/loopback code is `#if DEBUG` only; no release binary path may
contain or enable it. The former production `ws://100.x:port` setup is no longer
supported, even on a tailnet. Ordinary home Wi-Fi, wildcard/public binds,
Serve/Funnel, proxies and tunnels are not supported. IPv6 is not used here.

## Verify on a real Mac/iPhone before real notes

**None of the Apple/device checks below have run on the Linux box.**
- [ ] Build AidanCore tests and both apps in Debug AND Release; inspect release
      absence of raw ws/loopback paths. Run the new pairing, DER-SPKI and trust tests.
- [ ] Confirm neutral naming, then obtain Colby's separate HTTPS/CT consent before
      certificate issuance. Confirm grants, own Tailscale IP and firewall scope.
- [ ] Direct Node WSS works without Serve/Funnel, with a valid exact-name cert.
      Verify IP-directed URLSession plus explicit DNS hostname validation on-device.
- [ ] Mac public-JSON QR display and real-iPhone camera pairing/re-pair work. QR and
      app preferences contain no bearer/private key. Address edits cannot reuse trust.
- [ ] VPN-off, wrong/public/changed IPv4 DNS answers and wrong authority/port refuse
      before any credential is sent; no reconnection silently updates pairing.
- [ ] CA-valid wrong SPKI, expired/untrusted cert, wrong name and redirects refuse.
      Renew/rotate the key: old phone pin refuses until a new physically approved QR.
- [ ] Edit only dummy notes; test airplane mode, sleep/wake and reconnect on both
      devices; verify identical markdown, no lost edits and no unexpected exposure.
- [ ] Production `/reset` is absent even with arbitrary old flags/env/options;
      inspect production npm/Docker file sets. No test CA/harness in app/image.
- [ ] Independent CISO/Reviewer/Designer approval and Colby's separate push/workflow,
      merge and deployment decisions remain open. Do not use real notes beforehand.

## Safari home-screen app

The PWA is a different, separately approved HTTPS web-app URL; it is not this WSS
relay. Historical quick-tunnel URLs are not verified services. No hosting or public
exposure is authorized by this runbook.
