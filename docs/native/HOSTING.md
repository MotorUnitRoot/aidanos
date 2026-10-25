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
7. The shared-key file, mode 0600, from `AIDANOS_RELAY_TOKEN_FILE`. The shared key needs at least 32 random characters. Generate it with `openssl rand -base64 32` and store that output in the token file. A shorter key is refused. A key made of one repeated character, or with very little variety, is refused too. The relay still will not start without it, and it is not passed on the command line. Keep the file after you retire the shared key, or you cannot turn that key back on.
8. One device key for the Mac and one for the iPhone, issued before the proxy is reachable, from an interactive shell you are watching. The key is printed once. A service or a container would copy that line into its logs, so do not issue a key that way. Put each key only in that device. Then `--retire-shared-key`. Retiring does not edit the shared-key file. `--restore-shared-key` turns it back on when `devices.json` is readable. A relay already running with `--behind-proxy` does not honour that restore unless it was started with `--allow-shared-key-behind-proxy`. The default `--data` folder is `<vault>/.aidanos/relay`, inside the notes. Pass `--data` to a folder outside the notes. `devices.json` (fingerprints only) and `device-policy` (device keys are in use, and whether the shared key is retired) stay there, mode 0600, not in the notes and not in git. A notes reset does not delete them. If `devices.json` is missing or unreadable after a key was issued, the relay refuses to start. `--reenable-shared-key` is the deliberate way to turn the shared key back on in that case. `devices.json.bak` is only for `--restore-device-file`, and that restore does not turn a retired shared key on. A backup older than the last device change is refused, so a removed device does not come back.
9. DNS name and a certificate for the proxy. Those are created in that later step, by Colby, after the fresh sign-in. They are not created here.

`--behind-proxy` refuses to start while the shared key can still open a connection. Retire the shared key first. `--allow-shared-key-behind-proxy` is the explicit override, and it is the wrong choice on a machine the phone can reach. While that relay is running, `--restore-shared-key` does not reopen the shared key unless the override was given at start.

The command on that machine, later, looks like the home one, with `--behind-proxy` added and without `--lan`:

```
export AIDANOS_RELAY_TOKEN_FILE=/path/to/token
node src/server.mjs --vault /path/to/notes --data /path/to/relay-data --behind-proxy
```

It prints `LISTENING 127.0.0.1 3750` and a line that says a TLS proxy on this machine may forward here. It does not print a key.

## What is still missing before the phone can use it

The iPhone and Mac apps in this cut refuse a `wss://` address. They only speak plain `ws://`, which is the right shape on the home network and the wrong shape on the internet. A later change has to teach the app `wss://`. Until that lands, do not point the phone at the public name. The key would otherwise be offered to whatever address is typed.

With `--behind-proxy`, the relay turns its per-address lockout off. Every connection arrives from `127.0.0.1`, so that lockout would let one stranger block every device. Rate limiting belongs on the proxy, which can see the real client address. The relay does not trust `X-Forwarded-For`, and it does not read that header to decide who is locked out. Do not turn the lockout back on by forwarding the header.

Put the limit on the upgrade path, not only on ordinary page loads. One nginx shape is a zone of 10 megabytes at 10 requests a minute per client address, a burst of 5 with no delay, a connection cap, and status 429 when either limit trips:

```
limit_req_zone $binary_remote_addr zone=relay:10m rate=10r/m;
limit_conn_zone $binary_remote_addr zone=relay_conn:10m;

server {
    listen 443 ssl;
    # The certificate and key are created later, with the DNS name, after Colby signs in.
    # Keep them with the proxy, outside the notes folder, and out of git.
    ssl_certificate /etc/ssl/certs/aidanos-relay.crt;
    ssl_certificate_key /etc/ssl/private/aidanos-relay.key;
    # /health is not rate limited, so a monitor can call it. The sync path stays limited.
    location = /health {
        proxy_pass http://127.0.0.1:3750;
    }
    location / {
        limit_req zone=relay burst=5 nodelay;
        limit_conn relay_conn 4;
        limit_req_status 429;
        limit_conn_status 429;
        proxy_pass http://127.0.0.1:3750;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}
```

Check it before the phone is pointed at the name. From another machine, send a burst of upgrade attempts with a wrong key and confirm the proxy answers 429:

```
for n in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16; do
  curl -s -o /dev/null -w "%{http_code}\n" \
    -H "Connection: Upgrade" -H "Upgrade: websocket" \
    -H "Sec-WebSocket-Version: 13" -H "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==" \
    -H "Authorization: Bearer wrong" \
    "https://the-name/"
done
```

The first few lines may be 401 from the relay. Once the burst is past the zone, the lines must be 429 from the proxy. If they stay 401, the limit is not on this path. Do not put a real key in that command.

## What this step will not do until Colby says yes

No cloud login, no new project, no virtual machine, no DNS record, no certificate request, and no opening of a port. Do not deploy this image, and do not bind the relay to a public address.
