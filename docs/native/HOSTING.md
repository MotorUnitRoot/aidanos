# Hosting the relay later

This is not done. Nothing in this change creates a cloud account, signs in, starts a machine, or opens a port on the internet. The phone does not sync away from home yet.

The relay can sit on a server the phone can reach only after Colby says yes, and only after he signs in to that cloud himself with a fresh login. Do not reuse an old session, a saved token, or someone else's account. The person doing the work does not type his password.

## What that step will need

1. Colby's yes, before any account, project, or bill exists.
2. A fresh sign-in that Colby does himself, on the computer that will create the server.
3. A small Linux machine he controls. The relay on it is this same Node 22 program. No new packages.
4. The relay listens on `127.0.0.1` only, including on that machine. Start it with `--behind-proxy`. Do not use `--lan` there. `--behind-proxy` refuses `--lan`, and it does not listen on every interface.
5. A TLS proxy on that same machine. The phone would connect to `wss://` on port 443. The proxy forwards to `ws://127.0.0.1:3750` (write `127.0.0.1`, not `localhost`, in case `localhost` is the IPv6 address). The relay does not terminate TLS and does not take a public address. The certificate belongs to the proxy.
6. A firewall that allows 443 and does not allow 3750 from the internet. Port 3750 is plain `ws://`, and `/health` does not ask for a key. Leave the reset switch off. Do not set `AIDANOS_RELAY_ALLOW_RESET` on that machine.
7. The shared-key file, mode 0600, from `AIDANOS_RELAY_TOKEN_FILE`. The relay still will not start without it, and it is not passed on the command line. Keep the file after you retire the shared key, or you cannot turn that key back on.
8. One device key for the Mac and one for the iPhone, issued before the proxy is reachable, from an interactive shell you are watching. The key is printed once. A service or a container would copy that line into its logs, so do not issue a key that way. Put each key only in that device. Then `--retire-shared-key`. Retiring does not edit the shared-key file. `--restore-shared-key` turns it back on when `devices.json` is readable. The default `--data` folder is `<vault>/.aidanos/relay`, inside the notes. Pass `--data` to a folder outside the notes. `devices.json` (fingerprints only) and `device-policy` (device keys are in use, and whether the shared key is retired) stay there, mode 0600, not in the notes and not in git. A notes reset does not delete them. If `devices.json` is missing or unreadable after a key was issued, the relay refuses to start. `--reenable-shared-key` is the deliberate way to turn the shared key back on in that case. `devices.json.bak` is only for `--restore-device-file`, and that restore does not turn a retired shared key on.
9. DNS name and a certificate for the proxy. Those are created in that later step, by Colby, after the fresh sign-in. They are not created here.

The command on that machine, later, looks like the home one, with `--behind-proxy` added and without `--lan`:

```
export AIDANOS_RELAY_TOKEN_FILE=/path/to/token
node src/server.mjs --vault /path/to/notes --data /path/to/relay-data --behind-proxy
```

It prints `LISTENING 127.0.0.1 3750` and a line that says a TLS proxy on this machine may forward here. It does not print a key.

## What is still missing before the phone can use it

The iPhone and Mac apps in this cut refuse a `wss://` address. They only speak plain `ws://`, which is the right shape on the home network and the wrong shape on the internet. A later change has to teach the app `wss://`. Until that lands, do not point the phone at the public name. The key would otherwise be offered to whatever address is typed.

With `--behind-proxy`, the relay turns its per-address lockout off. Every connection arrives from `127.0.0.1`, so that lockout would let one stranger block every device. Rate limiting belongs on the proxy, which can see the real client address. The relay does not trust `X-Forwarded-For`, and it does not read that header to decide who is locked out. Do not turn the lockout back on by forwarding the header.

## What this step will not do until Colby says yes

No cloud login, no new project, no virtual machine, no DNS record, no certificate request, and no opening of a port. Do not deploy this image, and do not bind the relay to a public address.
