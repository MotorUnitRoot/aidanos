# Relay

The relay is the small sync server the iPhone and Mac apps talk to. How to run it is in `docs/native/TRY-IT.md`. The design notes are in `docs/native/DESIGN.md`.

## Tracked, not done yet

These are for the later cloud relay ticket. They are not fixed here.

- Move `@automerge/automerge-repo`, `automerge-repo-network-websocket`, and `automerge-repo-storage-nodefs` off `2.6.0-alpha.3` onto a stable release.
- The `bytes` 1.6.0 advisory GHSA-434x-w66g-qw3r comes in through automerge-swift 0.7.2. Re-check it when automerge-swift releases a fix.
- A flood of addresses can push older entries out of the 1024-address failure list early. There is no test for that cap.
- `--lan-address` checks that the address is on this machine only when a network list is passed in. A real start does not pass that list, so the check does not run.
- The app sends the token in plain text to whatever address you type, including a public one. `ws://` does not encrypt it.
- An `Origin` check is needed if login by cookie or a token in the URL is ever added. The relay does not look at `Origin` today.
