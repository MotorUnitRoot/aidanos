# Relay

The relay is the small sync server the iPhone and Mac apps talk to. How to run it is in `docs/native/TRY-IT.md`. The design notes are in `docs/native/DESIGN.md`.

## Network and reset safety

Loopback limits the bind surface; it does **not** prove locality or identify a
header-stripping same-machine proxy. Use bearer authority plus encrypted transport
and narrow tailnet grants. Forwarding hints are rejected on all production routes,
never treated as evidence of trust. Production fails closed on absent/erroring
Tailscale CLI or any configured Serve/Funnel/Services state.

Loopback (`127.0.0.1`) is the default. `--lan` / `--lan-address` accept only a local
`100.64.0.0/10` address confirmed by the running Tailscale daemon as this node's own
address. Both devices need Tailscale on the same trusted tailnet. A CGNAT address
without daemon confirmation is refused, as are ordinary LAN and public addresses.
Tailscale encrypts transport; the bearer token is still required. Never publish,
proxy, port-forward or enable Funnel on this relay. No QR pairing or public TLS
server is included here.

Reset is test-only. Its HTTP handler is unavailable unless the explicit harness
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

HTTP and WebSocket requests require an exact listener Host with port and no
browser Origin (native clients omit it). A private TLS front end may use an exact
`.ts.net:port` authority listed in `AIDANOS_RELAY_TRUSTED_HOSTS`; no wildcards.
No public endpoint or Funnel is supported. The native client now refuses ordinary
LAN/public destinations and plain ws DNS names before credentials are sent. WSS
uses system TLS verification on Apple; no plaintext fallback. See PHONE.md for
the real-device gate. Swift/ATS/Tailscale routing remain unverified on the box.

## Tracked, not done yet

These are for the later cloud relay ticket. They are not fixed here.

- Move `@automerge/automerge-repo`, `automerge-repo-network-websocket`, and `automerge-repo-storage-nodefs` off `2.6.0-alpha.3` onto a stable release.
- The `bytes` 1.6.0 advisory GHSA-434x-w66g-qw3r comes in through automerge-swift 0.7.2. Re-check it when automerge-swift releases a fix.
- A flood of addresses can push older entries out of the 1024-address failure list early. There is no test for that cap.
- An `Origin` check is needed if login by cookie or a token in the URL is ever added. The relay does not look at `Origin` today.
- Storage ids inside `remote-subscription-change` messages are not checked. That message is only handled when remote-heads gossip is turned on, and this relay does not turn it on.
- The Docker image has no data folder owned by `node`, and `CMD` does not pass `--vault`, so the image does not start as written.
- A failed parent write leaves a half-marked vault that has to be cleaned up by hand.
- The final marker check in `rotate()` should move to after `disposeSession`.
- Proxy and certificate variables (`HTTPS_PROXY`, `NO_PROXY`, `GIT_SSL_CAINFO`, `SSL_CERT_FILE` and so on) aren't passed to git, so a push behind a proxy or custom certificate authority will fail.

The reset entry point is `relay/test/harness/server.mjs --test-mode`, used only
by the simulator workflow. The ordinary `relay/src/server.mjs` CLI rejects
`--test-mode` and never enables reset, even if test/reset environment variables
are inherited. The test harness is not copied into the relay Docker image.
