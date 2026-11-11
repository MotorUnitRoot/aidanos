// The relay has no browser client. Native clients omit Origin. Require an exact
// listener authority; optional TLS front-end authorities are operator-listed.
export function relayRequestAllowed(req, hosts, trustedHosts = []) {
  if (req.headers.origin !== undefined) return false;
  const port = req.socket.localPort;
  const expected = hosts.map((host) => host + ":" + port).concat(trustedHosts);
  const authority = req.headers.host;
  return typeof authority === "string" && expected.includes(authority.toLowerCase());
}

export function trustedRelayHosts(value = "") {
  const list = String(value).split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (list.some((host) => !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+ts\.net:[1-9][0-9]{0,4}$/.test(host) ||
    Number(host.slice(host.lastIndexOf(":") + 1)) > 65535)) {
    throw new Error("Trusted relay Hosts must be exact Tailscale .ts.net names with a valid port.");
  }
  return list;
}
