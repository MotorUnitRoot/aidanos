# Direct TLS release boundary (not deployment approval)

Production `relay/src/server.mjs` requires an exact lowercase Mac MagicDNS name,
a certificate for that name, and a separate relay-owned regular **single-link
0600** key file, outside code, notes and relay data. Symlinks, hardlinks, wrong
permissions/owner, wrong name, invalid validity and mismatched keys are refused.
Node terminates TLS itself. There is no Serve/Funnel/TLS frontend and no plaintext
switch in the production entry, npm artifact or Docker COPY. Missing/broken
Tailscale status or configured Serve/Funnel is refused on startup and each route;
forwarding hints and browser Origin are refused; Host must match exactly.

A header-stripping same-machine proxy carrying a valid sync token cannot be
distinguished from an authorized direct client. The accepted boundary is the
sync token plus TLS, not loopback locality or a universal proxy detector.

Public Mac QR metadata approves one exact WSS address/name/port, one Tailscale
IPv4 and a SHA-256 DER-SPKI pin. Before credentials the native release adapter
requires that exact address, DNS A answers equal to the stored IP, system
chain/approved-hostname validation AND the pin. It connects to the stored literal
IP to avoid a second DNS lookup. No redirect, CA-only rollover or ws fallback.
The raw ws and loopback exception exist only under `#if DEBUG`. Apple
URLSession/SNI/Host, release compilation, the nine Swift methods, camera/QR and
real-device routing are **unbuilt/unverified on the Linux box**.

Only excluded test/dev files use a disposable local CA or plaintext. Never add a
test CA to global/production trust, pass key material in env/logs/QR/children,
or copy keys into repo/vault/images. Single-link checks cannot prevent independent
copies: operators must keep keys/backups out of those locations too.

## Renewal and sources

Source inspection recorded **Nov 10, 2026, 11:14 PM MST** found actual issuance /
renewal generates a **fresh P-256 private key**; the CLI has no supported reuse-key
input. Cached unchanged output is not renewal reuse. Restart the relay and
explicitly **re-pair from the Mac QR after every actual renewal/key change**.
Old pins refuse; a CA-valid new key is not automatically accepted.

- [Official cert CLI](https://tailscale.com/kb/1080/cli#cert): file output and
  validity controls, no existing-key input.
- [CLI flags/output, fixed source](https://github.com/tailscale/tailscale/blob/5eaaf978/cmd/tailscale/cli/cert.go).
- [Daemon issuance source](https://github.com/tailscale/tailscale/blob/main/feature/acme/cert.go):
  `issueACMECert` calls `ecdsa.GenerateKey(elliptic.P256(), rand.Reader)`; cached
  material can be returned without actual renewal. This source is mutable.
- [Official HTTPS/Certificate Transparency warning](https://tailscale.com/kb/1153/enabling-https).

**Refresh rule:** recheck the exact chosen/deployed Tailscale version before
provisioning or upgrading; do not assume future renewal behavior. File-based
renewal/relay restart remains the operator's responsibility.

**HTTPS/CT consent is still pending.** Choose a neutral Mac name first: CT logs
publish machine and tailnet names. This note does not enable HTTPS, issue a real
certificate, authorize real notes or approve deployment. Complete [PHONE.md's
Mac/iPhone checks](../../PHONE.md#verify-on-a-real-maciphone-before-real-notes)
and independent review before any release decision.
