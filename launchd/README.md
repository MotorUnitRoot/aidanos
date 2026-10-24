# AidanOS launchd

Mac keep-alive for the local server. Binds 127.0.0.1:3847 (HOST is set in server.mjs; do not change it).

WorkingDirectory is the repo root, the folder that contains `server.mjs`. It is not a `dashboard` subdirectory.
The vault is `AIDANOS_VAULT`, set only in the plist. If that variable is unset, the server uses the `vault/` folder next to `server.mjs`.
Do not bake a machine vault path into the start script.

`keep-tunnel.sh` is separate from launchd. It needs `cloudflared` installed (or `CLOUDFLARED_BIN` pointing at it). The quick-tunnel link changes every time that script starts.

## Paths to edit before load

The plist uses placeholders. Replace each one with a real absolute path:

- Node binary: `/usr/local/bin/node` (Homebrew may be `/opt/homebrew/bin/node`)
- Repo root: `/ABS/PATH/TO/aidanos` (the folder that contains `server.mjs`)
- Vault: `/ABS/PATH/TO/vault`
- Log directory: `/Users/YOURNAME/Library/Logs/aidanos`

launchd does not inherit a login PATH, so ProgramArguments must be absolute.

## Load

```sh
mkdir -p ~/Library/Logs/aidanos
cp /ABS/PATH/TO/aidanos/launchd/com.aidanos.plist ~/Library/LaunchAgents/com.aidanos.plist
launchctl load ~/Library/LaunchAgents/com.aidanos.plist
```

Then open http://127.0.0.1:3847

Unload:

```sh
launchctl unload ~/Library/LaunchAgents/com.aidanos.plist
```

## Without launchd

On the Linux sit machine, ./start.sh is the keep-alive (setsid or nohup npm start).

Same process, foreground, from the repo root:

```sh
cd /ABS/PATH/TO/aidanos
node server.mjs
```

package.json start script runs that same node process without launchd.
Honors an existing AIDANOS_VAULT env and otherwise uses the sibling vault folder next to the server.
On the Mac, the plist sets that env to `/ABS/PATH/TO/vault`.
Plist EnvironmentVariables key: AIDANOS_VAULT
