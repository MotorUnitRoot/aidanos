# Try the sync

This is enough to see today's note on your Mac and, with a cable, on your iPhone, and to watch an edit made while one of them is offline show up on the other.

You do not need a paid Apple developer account. You do need Xcode and Node 22 on the Mac.

## Install Xcode

1. Open the App Store on the Mac.
2. Search for Xcode and install it. The first time you open Xcode, let it install the extra components it asks for.
3. Open Xcode once and accept the license. You can quit it again.

## Install Node 22

1. In a browser, open [https://nodejs.org](https://nodejs.org).
2. Download the macOS installer for version 22 (the one marked LTS is fine if it is 22).
3. Run the installer. Leave the defaults as they are.
4. Open Terminal (Applications → Utilities → Terminal) and type `node --version`. It should print a number starting with `v22`.

## Get the project onto the Mac

If the `aidanos` folder is already on the Mac, use that folder. If it is not:

1. Open Terminal.
2. Type this and press Return. It copies the project into your home folder:

   ```
   git clone https://github.com/MotorUnitRoot/aidanos.git
   cd aidanos
   git checkout cursor/native-sync-foundation-1ab2
   ```

3. Remember this folder. The steps below call it the project folder.

## Start the relay

The relay is the small program both apps talk to. It keeps its own folder of notes. Do not point it at the Mac app's folder. The two folders stay separate, and the relay will refuse to start if you try to share them.

1. Open Terminal.
2. Go to the relay folder:

   ```
   cd aidanos/relay
   npm ci --omit=optional
   ```

   If you are already inside the project folder, `cd relay` is enough.

3. Make a token and store it in a file. Do not make one up out of words: a space in the token is refused, and the failed connection then blocks this computer for a while. Do not put the token in any command. Terminal saves commands in its history.

   ```
   umask 077
   openssl rand -base64 32 > "$HOME/aidanos-relay-token"
   chmod 600 "$HOME/aidanos-relay-token"
   ```

   `openssl rand -base64 32` writes a token with no spaces. The file is only readable by your user (mode 0600). A single newline at the end of that file is fine.

4. Start the relay with its own empty folder. Do not point it at the Mac app's notes. The relay marks the folder the first time, and it writes an id file next to that folder. Leave the id file where it is. The next start has to use that same folder. A folder an older relay marked is not accepted.

   ```
   export AIDANOS_RELAY_TOKEN_FILE="$HOME/aidanos-relay-token"
   node src/server.mjs --vault "$HOME/aidanos-relay-notes"
   ```

5. Leave that window open. It prints `LISTENING 127.0.0.1 3750`. Nothing else on the network can connect. That is the normal way to run it. It does not print the token.

Git, if you later point it at a backup repository, only receives a copy of the markdown. The phone and the Mac never download notes from git. The git password is not stored in the notes folder.

## Run the Mac app

1. In Finder, open `native/Apps/AidanOS.xcodeproj` inside the project folder. Xcode opens.
2. At the top, choose the scheme **AidanOS-macOS** and the destination **My Mac**.
3. In the left sidebar, select the project, then the **AidanOS-macOS** target, then **Signing & Capabilities**. Choose the team named **Your Name (Personal Team)**. Do this for the Mac target, not only the iPhone target. The project does not pick a team for you.
4. Press Run. The window opens on today's note, with the cursor at the end. The note text scrolls if it is longer than the window.
5. In the address field leave `ws://127.0.0.1:3750`. Put the token into the app from the token file, then press Connect. The token is hidden. The status says Connected only while the connection is really up.

   On the Mac, in a second Terminal window:

   ```
   pbcopy < "$HOME/aidanos-relay-token"
   ```

   Click the token field in the app and paste. Then copy something else, such as the word done, so the token is no longer on the clipboard. Do not paste the token into a note or a message.

The Mac app keeps its notes in its own folder, `~/Library/Application Support/AidanOS/vault`. Today's file is `log/YYYY-MM-DD.md` inside that folder. The relay, started as above, writes its own copy into the folder you passed with `--vault` (`$HOME/aidanos-relay-notes`). The app saves the token in the Keychain, not in a settings file.

## Free Apple ID on your iPhone

A paid developer account is not required for this test. A free Apple ID installs the app from Xcode over a cable. The app expires after 7 days. Plug the phone back in and press Run again to refresh it. There is no App Store and no TestFlight in this cut.

1. In Xcode, open Settings → Accounts and sign in with your Apple ID.
2. Select the scheme **AidanOS-iOS**. Open the AidanOS-iOS target, Signing & Capabilities, and choose the team named **Your Name (Personal Team)**. The Mac target needs that same choice, from the step above.
3. If Xcode says the bundle id is already in use, change the one line `PRODUCT_BUNDLE_IDENTIFIER_PREFIX` in `native/Apps/Config/Shared.xcconfig`. That is the only place the prefix lives. The iPhone id becomes that prefix plus `.ios`.
4. Plug the iPhone into the Mac with a cable. Choose that iPhone as the run destination. Press Run.
5. On the iPhone, turn on Developer Mode if iOS asks (Settings → Privacy & Security → Developer Mode) and restart if it tells you to.
6. Trust the developer: Settings → General → VPN & Device Management, tap the Apple Development entry, and choose Trust.
7. On the Mac, stop the relay if it is still running (click the Terminal window and press Control-C), and start it so the phone can see it. Use the same token file as before, and add `--lan`:

   ```
   export AIDANOS_RELAY_TOKEN_FILE="$HOME/aidanos-relay-token"
   node src/server.mjs --vault "$HOME/aidanos-relay-notes" --lan
   ```

   The first time, the Mac may show a firewall prompt asking whether to allow incoming connections for `node`. Choose Allow. Without that, the phone cannot reach the Mac.

   The relay still listens on this Mac only at `127.0.0.1`, and it also listens on this Mac's home-network address. It prefers the home Wi-Fi address over a VPN address. It prints a warning: traffic on the home network is not encrypted, and the token is the only protection. Then it prints a line like `PHONE ws://192.168.1.20:3750`. It does not print the token. Type that address into the iPhone app. For the token, run `pbcopy < "$HOME/aidanos-relay-token"` on the Mac again if you already cleared the clipboard, then use Universal Clipboard, or type the token in. Paste it only into the token field. Do not paste the token into a note or a message. Press Connect. Copy something else afterward so the token is no longer on the clipboard. The first time, iOS asks permission to find devices on the local network. Allow it.

   `--lan` refuses to start if the Mac has no private address (an address like `192.168.x.x`). It never listens on every interface. If you need a specific address, add `--lan-address 192.168.1.20`.

The phone build asks for no capability a free account cannot have. There is no widget and no share sheet in this cut. A paid account (the enrollment that is in progress) will later allow TestFlight, widgets, and the share sheet.

## The airplane-mode test

1. Connect the iPhone and the Mac to the relay, as above, so today's note is open on both.
2. Put the iPhone in airplane mode. The phone's status changes to Reconnecting. It does not stay on Connected. Type a sentence in today's note on the phone.
3. On the Mac, type a different sentence in the same note.
4. Take the iPhone out of airplane mode. Leave the app open. It connects again by itself, with a short wait that gets longer if the network is still gone. You do not have to press Connect again. When the status says Connected, both sentences are on the phone and on the Mac.

Both sentences are also in the `log/YYYY-MM-DD.md` file. You are not asked to pick one. The order of the two sentences is the one the merge produces, and it is the same on both devices.

If the two sides cannot be merged safely, the app shows Keep mine, Take theirs, and Edit. Edit starts with both versions in the note, so you can combine them and press Save edit.

## What this cut does not do

It does not install over TestFlight. It does not sync through git. It does not run a widget or a share extension. Those wait on the paid account, and git stays a backup even then. A separate token for each device comes before the relay is ever reachable from outside the house.
