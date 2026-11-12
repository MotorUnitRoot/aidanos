# Relay

The relay is the small sync server the iPhone and Mac apps talk to. The release path is in [PHONE.md](../PHONE.md) and [TLS notes](../docs/native/TLS.md). The old TRY-IT walkthrough is archival, not current production startup instructions.

## Network and reset safety

Loopback limits the bind surface; it does **not** prove locality or identify a
header-stripping same-machine proxy carrying a valid sync token: it is
indistinguishable from a direct authorized client. This is the accepted limit, not
a universal proxy detector. The boundary is the sync token plus TLS. Use that authority
and narrow tailnet grants. Forwarding hints are rejected on all production routes,
never treated as evidence of trust. Production fails closed on absent/erroring
Tailscale CLI or any configured Serve/Funnel/Services state.

Loopback (`127.0.0.1`) is the default. `--lan` / `--lan-address` accept only a local
`100.64.0.0/10` address confirmed by the running Tailscale daemon as this node's own
address. Both devices need Tailscale on the same trusted tailnet. A CGNAT address
without daemon confirmation is refused, as are ordinary LAN and public addresses.
Production refuses to start without TLS, including on loopback. Direct Node TLS
and public QR pairing metadata are implemented; tailnet HTTPS/CT enablement is
still pending. The sync token is also required. Never publish, proxy, port-forward
or enable Serve/Funnel on this relay.

Reset implementation, routing, deletion and admin-token handling exist only in the
excluded disposable test server; production startRelay has no enabling option.
That isolated fixture requires the explicit harness
flag (`--test-mode`), `NODE_ENV=test`, reset opt-in, and a separate admin credential
are supplied together. The admin credential must differ from the sync token.
The simulator's fixed dummy values are test fixtures, not production secrets.
Normal launchd/Docker/app paths never supply these flags. Never enable them with
real notes. Loopback proxies with only the sync token cannot reset.

The test harness refuses startup with any detected `tailscale serve status --json`
configuration; a present CLI that errors or returns malformed output fails closed.
Missing CLI is allowed only inside the excluded disposable reset fixture. Production requires readable, empty Serve/Funnel status at startup and before every HTTP/sync route. Proxy
hint headers (`Forwarded`, `X-Forwarded-*`, `Tailscale-*`) are refused, not trusted.
**Reset and Serve/Funnel, SSH forwarding or any proxy must never be combined.**
A header-stripping proxy with the admin credential would still possess test-only
admin authority; these guards are not permission to proxy a test relay.

HTTP and WebSocket requests require exact listener/TLS-name Host authority and no
browser Origin. The native release path uses direct Node TLS plus explicit QR
pairing of exact address, IPv4 and DER-SPKI. No Serve/Funnel or TLS frontend.
A .ts.net suffix or CGNAT syntax is not peer/encryption proof. Plaintext exists only in the excluded loopback disposable dev entry, explicitly
flagged --dev-plaintext; neither production options nor env can enable it. DEBUG
clients retain their fixture ws code only; release contains none. See PHONE.md.

TLS files are supplied through --tls-name/--tls-cert-file/--tls-key-file; the private
key must be a separate relay-owned regular single-link 0600 file (no symlink or
hardlink) outside repo/vault/data. Never
put PEM/key material in env, child processes, logs, QR or Docker image. Only public
pairing metadata is written by --pairing-file. Actual Tailscale renewal generates
a fresh key in inspected source: restart and explicitly re-pair from the Mac QR;
CA validity alone never replaces a pin. HTTPS/CT consent remains pending and a
neutral machine name is required before the later certificate decision.

Swift/app/ATS/trust/QR/routing checks remain unbuilt and device verification is
required before real notes. The separate test reset fixture intentionally owns
its disposable protocol/lifecycle implementation; production never imports it.

## Tracked, not done yet

These are for the later cloud relay ticket. They are not fixed here.

- Move `@automerge/automerge-repo`, `automerge-repo-network-websocket`, and `automerge-repo-storage-nodefs` off `2.6.0-alpha.3` onto a stable release.
- The `bytes` 1.6.0 advisory GHSA-434x-w66g-qw3r comes in through automerge-swift 0.7.2. Re-check it when automerge-swift releases a fix.
- A flood of addresses can push older entries out of the 1024-address failure list early. There is no test for that cap.
- Storage ids inside `remote-subscription-change` messages are not checked. That message is only handled when remote-heads gossip is turned on, and this relay does not turn it on.
- The Docker image has no data folder owned by `node`, and `CMD` does not pass `--vault`, so the image does not start as written.
- A failed parent write leaves a half-marked vault that has to be cleaned up by hand.
- The final marker check in `rotate()` should move to after `disposeSession`.
- Proxy and certificate variables (`HTTPS_PROXY`, `NO_PROXY`, `GIT_SSL_CAINFO`, `SSL_CERT_FILE` and so on) aren't passed to git, so a push behind a proxy or custom certificate authority will fail.

The reset entry point is `relay/test/harness/server.mjs --test-mode`, used only
by the simulator workflow. The ordinary `relay/src/server.mjs` CLI rejects
`--test-mode` and never enables reset, even if test/reset environment variables
are inherited. The test harness is not copied into the relay Docker image.
