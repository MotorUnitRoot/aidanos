# AidanOS launchd

Mac keep-alive for the local dashboard. Binds 127.0.0.1:3847 (HOST is set in server.mjs; do not change it).

WorkingDirectory is the dashboard slice (~/Grok/motorunit/dashboard).
The vault is the parent (~/Grok/motorunit), set only in the plist.
Do not bake the Mac vault path into the start script.

## Paths to edit before load

The plist uses placeholders:

- Node binary: /usr/local/bin/node (Homebrew may be /opt/homebrew/bin/node)
- Slice: /Users/colby/Grok/motorunit/dashboard
- Vault: /Users/colby/Grok/motorunit

launchd does not inherit a login PATH, so ProgramArguments must be absolute.

## Load

```sh
mkdir -p ~/Library/Logs/aidanos
cp /Users/colby/Grok/motorunit/dashboard/launchd/com.aidanos.plist ~/Library/LaunchAgents/com.aidanos.plist
launchctl load ~/Library/LaunchAgents/com.aidanos.plist
```

Then open http://127.0.0.1:3847

Unload:

```sh
launchctl unload ~/Library/LaunchAgents/com.aidanos.plist
```

## Without launchd

On the Linux sit machine, ./start.sh is the keep-alive (setsid npm start).

Same process, foreground:

```sh
cd /Users/colby/Grok/motorunit/dashboard
node server.mjs
```

package.json start script runs that same node process without launchd.
Honors an existing AIDANOS_VAULT env and otherwise uses the sibling vault folder next to the server.
On the Mac, the plist sets that env to /Users/colby/Grok/motorunit.
Plist EnvironmentVariables key: AIDANOS_VAULT
