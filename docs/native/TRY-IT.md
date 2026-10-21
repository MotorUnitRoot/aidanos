# Try the sync

This is the first cut. It is enough to see today's note on your Mac and, with a cable, on your iPhone, and to watch an edit made while one of them is offline show up on the other.

You need Node 22 on the Mac. The relay is the small program both apps talk to. Git, if you point it at a backup repository, only receives a copy of the markdown. The phone and the Mac never download notes from git.

## On your Mac

1. In Terminal, from this repository:

   ```
   cd relay
   npm ci
   node src/server.mjs --token a-long-secret-you-choose
   ```

   Leave that window open. It prints `LISTENING 127.0.0.1 3750`. Nothing else on the network can connect. That is the normal way to run it.

2. Open `native/Apps/AidanOS.xcodeproj` in Xcode.
3. At the top, choose the scheme **AidanOS-macOS** and the destination **My Mac**.
4. Press Run. The window opens on today's note, with the cursor at the end.
5. In the address field leave `ws://127.0.0.1:3750`. Type the same token you gave the relay. Press Connect.

The Mac app keeps its notes in `~/Library/Application Support/AidanOS/vault`. Today's file is `log/YYYY-MM-DD.md` inside that folder. The relay, started as above, writes its own copy into `relay/vault` (the folder you were in when you started it). To make the Mac app and the relay share one folder, start the relay with `--vault` pointed at the Application Support vault. Do that only when the Mac app is the one you want the relay to mirror.

## Free Apple ID on your iPhone

A paid developer account is not required for this test. A free Apple ID installs the app from Xcode over a cable. The app expires after 7 days. Plug the phone back in and press Run again to refresh it. There is no App Store and no TestFlight in this cut.

1. In Xcode, open Settings → Accounts and sign in with your Apple ID.
2. Select the scheme **AidanOS-iOS**. Open the AidanOS-iOS target, Signing & Capabilities, and choose the team named **Your Name (Personal Team)**. The project does not pick a team for you.
3. If Xcode says the bundle id is already in use, change the one line `PRODUCT_BUNDLE_IDENTIFIER_PREFIX` in `native/Apps/Config/Shared.xcconfig`. That is the only place the prefix lives. The iPhone id becomes that prefix plus `.ios`.
4. Plug the iPhone into the Mac with a cable. Choose that iPhone as the run destination. Press Run.
5. On the iPhone, turn on Developer Mode if iOS asks (Settings → Privacy & Security → Developer Mode) and restart if it tells you to.
6. Trust the developer: Settings → General → VPN & Device Management, tap the Apple Development entry, and choose Trust.
7. On the Mac, stop the relay if it is still running, and start it so the phone can see it:

   ```
   node src/server.mjs --token a-long-secret-you-choose --lan
   ```

   It still listens on this Mac only at `127.0.0.1`, and it also listens on this Mac's home-network address. The token is still required. It prints a line like `PHONE ws://192.168.1.20:3750`. It does not print the token. Type that address and the token into the iPhone app and press Connect. The first time, iOS asks permission to find devices on the local network. Allow it.

   `--lan` refuses to start if the Mac has no private address (an address like `192.168.x.x`, `10.x.x.x`, or `172.16–31.x.x`). It never listens on every interface.

The phone build asks for no capability a free account cannot have. There is no widget and no share sheet in this cut. A paid account (the enrollment that is in progress) will later allow TestFlight, widgets, and the share sheet.

## The airplane-mode test

1. Connect the iPhone and the Mac to the relay, as above, so today's note is open on both.
2. Put the iPhone in airplane mode. Type a sentence in today's note on the phone.
3. On the Mac, type a different sentence in the same note.
4. Take the iPhone out of airplane mode and let it reach the relay again.

Both sentences are on the phone, on the Mac, and in the `log/YYYY-MM-DD.md` file. You are not asked to pick one. The order of the two sentences is the one the merge produces, and it is the same on both devices.

## What this cut does not do

It does not install over TestFlight. It does not sync through git. It does not run a widget or a share extension. Those wait on the paid account, and git stays a backup even then.
