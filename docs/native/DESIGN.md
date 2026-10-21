# AidanOS native sync

This is the plan for the iPhone app, the Mac app, and the small relay that sits between them. It is written for the owner. A term gets a plain definition the first time it shows up.

The notes you read and edit are ordinary markdown files. Markdown is plain text with a few marks, such as `#` for a heading. The folder that holds those files is the vault. The vault is the real notebook. There is not a second database of notes.

## Git is only a backup

Git is the tool that stores snapshots of files and can send those snapshots to a private repository. In AidanOS that private repository is a backup copy of the markdown files and nothing else.

The phone and the Mac do not sync through git. They never download notes from the vault repository in order to catch up with each other. If git is down, sync still works. If the backup repository is deleted, the notes are still on the devices and on the relay. The relay sends a copy of the markdown up to the repository on a schedule. It does not pull, it does not rewind history, and it does not force the remote to match. Git only receives the backup.

## The two copies of a note

Each note has two forms:

1. The markdown file in the vault. This is the note.
2. An edit history kept beside it, in a hidden folder named `.aidanos`. This history is how two devices combine typing without losing either side. It is a cache: a copy that can be thrown away and built again from the markdown. The vault's git backup ignores the whole `.aidanos` folder, so the backup never contains it.

Automerge is the library that keeps that edit history. It merges edits from two devices that were not connected, and it keeps both people's text. A document is one note's history inside Automerge. A document id is the name of that history, a short string every device can say out loud and mean the same history.

The relay is a small program you run, later on your own Google Cloud machine. The phone and the Mac open a live connection to it (a WebSocket, which is a steady connection rather than a series of separate web requests) and send Automerge edits through it. The relay stores the histories and writes the markdown files. Devices talk to the relay. They do not talk to git.

## What a vault looks like

```
vault/
  log/2026-10-21.md          today's day note
  notes/some-thought.md      any other note
  .gitignore                 contains the line .aidanos/
  .aidanos/                  hidden cache, never committed
    actor                    this device's identity for edits
    index                    the shared index history
    docs/                    one history file per note
    meta.json                rebuild and conflict bookkeeping
    relay/                   the relay's own copy of the histories, when the relay uses this vault
```

Paths use forward slashes and stay inside the vault. A path is not allowed to climb out with `..`.

## How a path becomes a document

There is one index document. Its id is fixed in advance, the same on every phone, every Mac, and the relay. The recipe is: take the sentence `aidanos.index.v1`, hash it (a hash is a fingerprint of those exact letters), keep the first 16 bytes, and encode them with base58check (a compact text form of those bytes with a checksum so a typo is obvious). Nobody picks this id at random, and nobody stores it in iCloud.

The index is a list of pairs: note path, document id. A device that has synced can read the list. The id for a note is also a fixed recipe, not a random draw: fingerprint `aidanos.note.v1` plus the path, first 16 bytes, base58check. The same path always names the same history. The index records the pair so the relay knows which file to write.

The first saved moment of a note's history is fixed too. Every device, given that path, writes the same blank opening: a field named `kind` set to `note`, and an empty text field named `text`, signed by an identity that comes from the path and stamped at a fixed time. Because the opening is identical, both devices are adding to one shared note, not to two notes that happen to have the same title.

After that opening, each device uses its own identity (the `actor` file in `.aidanos`) for typing. Two devices must not type as the same identity at the same time. Automerge forbids that, and the actor file is how we avoid it.

## The same note created on two devices while offline

Today's day note is the file `log/YYYY-MM-DD.md`, for example `log/2026-10-21.md`. The web app already uses that path.

If the phone and the Mac both create that file while neither can see the relay, they both compute the same document id and the same blank opening. Each one then inserts its own typing under its own identity. When they can see the relay again, the two streams of typing land in the one document. Nothing asks you to choose. No sentence is dropped. If both typed in the same spot, both chunks of text stay in the note. The order is the one Automerge picks, which is stable: the same two chunks always come out in the same order.

The markdown file on each device is rewritten from that merged note, so the file shows both edits too.

## Edits made outside the app

You might change a markdown file in another program, or the web app might write it, while this app is open or the next time it opens. The app watches the vault (it checks the files several times a second; that is enough for this cut, and it works on the phone, the Mac, and later on Linux).

When a file's text is different from the note, and this app was not the thing that just wrote it, the app compares the two texts. The comparison is a diff: the shared start, the shared end, and the middle that was inserted or deleted. Those insertions and deletions are applied to the Automerge text as ordinary edits. They then sync like typing.

The write back to disk is atomic. Atomic means a reader never sees a half-written file: the app writes a temporary file in the same folder, flushes it, and renames it over the real file in one step.

## When the cache is deleted or unreadable

If `.aidanos` is missing, or a history file will not load, the app rebuilds from the markdown:

- It reads every `.md` file under the vault, skipping `.aidanos`.
- It rebuilds the index.
- For each note whose history is missing or corrupt, it starts again from the fixed blank opening and then inserts the file's current text.

The words match the file. The old keystroke-by-keystroke history for that note is gone. That is what "the history is a rebuildable copy" means.

The next time this device connects, it does not blindly upload that rebuilt history on top of everyone else's. It asks the relay for the shared history of that path. Then:

- If the relay's text and the file are the same, it keeps the relay's history. The file was already in sync.
- If the relay has no text yet, it inserts the file's text as edits on the shared opening. That is the first upload.
- If the relay has different text, it stops and asks you. Applying the file as a diff would wipe the other device, because this device no longer has the shared history those edits belong to. See the next section.

Until the relay answers, the app shows the file. You can keep typing offline.

## When you are asked to choose

Typing merges. Two devices editing the same note, online or offline, do not get a prompt. An outside edit on top of a healthy cache is also just a diff, so it merges. The case you described, an outside edit to a note while the app was off on both devices, is that case as long as both caches are intact: each side folds a diff against the shared note, and both edits remain. No prompt.

You see Keep mine / Take theirs / Edit only when the app cannot do that safely:

1. The cache on this device was missing or unreadable, the note was rebuilt from the file, and the relay already has different text for that same path. The file is not overwritten while that comparison is still open. Keep mine keeps the file on this device and writes it as the note. Take theirs keeps the synced note and rewrites the file to match. Edit opens the text starting from both versions, one after the other, so you can combine them by hand and save.
2. The markdown file was deleted on this device while the synced note still has text. The app does not guess whether you meant to delete the note or the other device's edits should restore the file. Keep mine confirms the delete. Take theirs puts the synced text back in the file. Edit lets you write what should remain.
3. The path is a folder on one side and a note file on the other. The app does not pick.

A text merge that merely interleaves two sentences is not one of these. It looks like both sentences in the note.

## How the relay knows your devices

The first cut uses one shared secret, called the token. You type the same token into the relay and into each app. The app sends it once, in the connection header (`Authorization: Bearer …`), not in the web address, so it does not show up in an ordinary address log. A wrong token is refused before any note is exchanged. The relay never prints the token and never writes it into an error line.

The relay reads that token from the environment variable `AIDANOS_RELAY_TOKEN` or from a file (mode 0600) named by `AIDANOS_RELAY_TOKEN_FILE`. It is not accepted on the command line. It must be at least 32 characters. Too many wrong guesses from the same address are refused for a while. The Mac and iPhone apps store the token in the Keychain, and the field is masked. This is a single password for every device you own. It is not an account system. It is enough for a private relay. A token per device comes before this relay is ever reachable from outside the house.

## What the relay writes, and when git gets a copy

The relay listens for edits, stores the Automerge histories on disk (by default under the vault's `.aidanos/relay` folder, which git ignores), and writes the markdown.

When a note changes, the relay writes the `.md` file with the same atomic rename. It waits a short moment so a burst of keystrokes becomes one write. It remembers a hash of what it last wrote, in `.aidanos/written.json`, so a restart can tell that file from a real outside edit. If someone edits a markdown file on the machine where the relay is running, the relay treats that as an outside edit: it diffs the file into the history so the next mirror write does not stamp the old text back over the file.

The relay only writes a relative `.md` path. Hidden names, `..`, absolute paths, and a symlink that leaves the folder are refused. The same rule is enforced in the apps. The relay also refuses to start when its folder is an app vault (it has `.aidanos/actor`, `storage-id`, or `index`). The two folders stay separate.

Git runs on a timer, every five minutes unless `AIDANOS_VAULT_GIT_INTERVAL_MS` says otherwise. Each tick:

- If `AIDANOS_VAULT_GIT_URL` is unset, git is skipped. Sync is unchanged. Health reports git as off.
- If it is set, the relay commits the markdown files (not `.aidanos`) and pushes to that URL. The remote URL stored in the vault's git config does not contain the token.
- It authenticates the push with `AIDANOS_VAULT_GIT_TOKEN`, passed only in the environment of that push (a short-lived ask-pass helper). Logs, errors, and health output are scrubbed, including a bearer token of any length. The token string, the raw URL, and any `x-access-token:…` user-info are replaced before anything is printed.
- The relay does not pull, fetch, rebase, or force-push. If the backup has commits the relay does not have, the push fails, health reports git as failed, the failure is logged without the token, and sync continues. Someone can repair the backup by hand. The devices are not waiting on it.

## Where the relay listens

By default the relay binds to `127.0.0.1` only. That is this computer, and no other computer can connect. That is the standing rule.

To reach the relay from the iPhone on your home network, start it with `--lan`. It then listens on `127.0.0.1` and on one private address. It prefers a home-network address (`192.168.x.x`) over other private addresses, and it skips VPN tunnel interfaces. `--lan-address` chooses a specific private address. It does not listen on every interface. The token is still required. At startup it prints a warning that home-network traffic is unencrypted and the token is the only protection, then the `ws://` address to type into the phone. It does not print the token. If the Mac has no private address, `--lan` stops and says so.

A dropped socket, sleep, or airplane mode reconnects on its own, waiting a second and then longer, up to 30 seconds. The app shows Connecting, Connected, or Reconnecting. It does not say Connected while the socket is down. A note created after the connection, including the next day's note, syncs on that same connection. The app moves to the new day.

## The phone and the Mac apps in this cut

They are a shell. On open they show today's day note as an editable text view, with the cursor at the end, and a small place to type the relay address and the token. The look belongs to the Designer later.

The iPhone build in this cut is installed from Xcode on the Mac with a free Apple ID (a personal team, a cable, and a build that expires after seven days). It asks for no capability a free account cannot have: no App Groups, no iCloud, no push notifications, no associated domains, no background modes, no widget, no share extension. The bundle id prefix lives in one xcconfig file so you can change it in one place. Signing is automatic and the team is left for you to pick.

The phone has to be allowed to open a plain `ws://` connection to the Mac. The app allows local networking (App Transport Security's local-networking exception) and includes the local-network usage sentence iOS shows the first time.

## What Linux needs later

A Linux client must speak this same sync. That is why there is no iCloud and no Apple-only store.

The shared pieces are already fixed, independent of Apple:

- The vault layout and the `.aidanos` cache.
- The index id recipe and the note id recipe.
- The blank opening of a note.
- The automerge-repo sync protocol over a WebSocket: a join message, a peer reply, then request and sync messages whose payload is an Automerge sync blob. The Node relay speaks that protocol. So does the Swift core. One sync message may be up to 32 MB on both sides. A note larger than that stops syncing by itself and the app shows an error; other notes keep syncing.
- The token in the connection header.
- Markdown as the note, git as backup only.

The Swift package `AidanCore` is that core. It builds and its tests run on Linux as well as on the Mac. The published automerge-swift package refuses to compile on Linux, because the binary it ships is Apple-only and the package contains an explicit error on Linux. The Linux build uses the same automerge-swift 0.7.2 sources, with that refusal removed, linked to the Automerge engine compiled from the Rust code in that same release. The bytes on the wire do not change.

automerge-repo-swift, the Swift twin of the relay's library, is not linked in this cut. Its latest code still requires Automerge 0.5, and 0.5 cannot sit in the same app as automerge-swift 0.7.2. It also imports Apple-only networking, so it cannot be the Linux core. The core uses automerge-swift 0.7.2 for the histories and speaks the same protocol that automerge-repo-swift and the Node server speak. When automerge-repo-swift accepts Automerge 0.7, the Apple apps can switch their socket to that library without changing the vault, the ids, or the relay.

## Decisions

1. Notes stay in the app's own folder for now. On the Mac that is Application Support (`~/Library/Application Support/AidanOS/vault`). On the iPhone it is the app's documents folder. Pointing it at the existing MotorUnit folder can wait.
2. The relay folder stays separate from the app's folder. The relay refuses to start if you point it at an app vault, and the app refuses to open the relay's folder.
3. Still open: the git backup runs every five minutes. A different rhythm, or a backup only when you ask, is not decided.
4. Edit starts with both versions, one after the other.
5. Still open: day notes stay at `log/YYYY-MM-DD.md`, matching the web app.
6. Per-device tokens come before the relay ever leaves the house. This cut still uses one shared token, which is enough while it only listens on this Mac or the home network.
7. Still open: when automerge-repo-swift moves to Automerge 0.7, the Apple apps may switch onto its WebSocket code. The protocol would stay the same.
8. Still open: a free Apple ID build expires every seven days and has to be reinstalled from Xcode until the paid developer account finishes.
