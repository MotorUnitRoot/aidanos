# Relay

The relay is the small sync server the iPhone and Mac apps talk to. How to run it is in `docs/native/TRY-IT.md`. The design notes are in `docs/native/DESIGN.md`.

## Network and reset safety

Loopback (`127.0.0.1`) is the default. `--lan` / `--lan-address` accept only a local
`100.64.0.0/10` address confirmed by the running Tailscale daemon as this node's own
address. Both devices need Tailscale on the same trusted tailnet. A CGNAT address
without daemon confirmation is refused, as are ordinary LAN and public addresses.
Tailscale encrypts transport; the bearer token is still required. Never publish,
proxy, port-forward or enable Funnel on this relay. No QR pairing or public TLS
server is included here.

Reset is off by default. Its simulator opt-in cannot enable it with a network
listener: **all** `/reset` requests are refused in that mode. Otherwise it requires
a loopback socket at both ends, the bearer token, and current matching markers.

## Tracked, not done yet

These are for the later cloud relay ticket. They are not fixed here.

- Move `@automerge/automerge-repo`, `automerge-repo-network-websocket`, and `automerge-repo-storage-nodefs` off `2.6.0-alpha.3` onto a stable release.
- The `bytes` 1.6.0 advisory GHSA-434x-w66g-qw3r comes in through automerge-swift 0.7.2. Re-check it when automerge-swift releases a fix.
- A flood of addresses can push older entries out of the 1024-address failure list early. There is no test for that cap.
- The app sends the token in plain text to whatever address you type, including a public one. `ws://` does not encrypt it.
- An `Origin` check is needed if login by cookie or a token in the URL is ever added. The relay does not look at `Origin` today.
- Storage ids inside `remote-subscription-change` messages are not checked. That message is only handled when remote-heads gossip is turned on, and this relay does not turn it on.
- The Docker image has no data folder owned by `node`, and `CMD` does not pass `--vault`, so the image does not start as written.
- A failed parent write leaves a half-marked vault that has to be cleaned up by hand.
- The final marker check in `rotate()` should move to after `disposeSession`.
- Proxy and certificate variables (`HTTPS_PROXY`, `NO_PROXY`, `GIT_SSL_CAINFO`, `SSL_CERT_FILE` and so on) aren't passed to git, so a push behind a proxy or custom certificate authority will fail.
