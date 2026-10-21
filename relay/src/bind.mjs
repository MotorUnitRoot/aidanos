import os from "node:os";

export function isPrivateIPv4(ip) {
  const parts = String(ip).split(".").map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return false;
  }
  const a = parts[0];
  const b = parts[1];
  if (a === 10) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  return false;
}

const VPN_INTERFACE = /^(utun|tun\d|tap|ppp|ipsec|tailscale|wg|vpn|zt)/i;

// Home Wi-Fi (192.168.x.x) comes before other private addresses. VPN tunnels are skipped.
export function privateIPv4(interfaces = os.networkInterfaces()) {
  const home = [];
  const other = [];
  for (const [name, addrs] of Object.entries(interfaces || {})) {
    if (VPN_INTERFACE.test(name)) continue;
    for (const addr of addrs || []) {
      const family = addr.family;
      if (family !== "IPv4" && family !== 4) continue;
      if (addr.internal) continue;
      if (!isPrivateIPv4(addr.address)) continue;
      if (String(addr.address).startsWith("192.168.")) home.push(addr.address);
      else other.push(addr.address);
    }
  }
  return home.concat(other);
}

function addressOn(interfaces, chosen) {
  for (const addrs of Object.values(interfaces || {})) {
    for (const addr of addrs || []) {
      if (addr.address === chosen) return true;
    }
  }
  return false;
}

// Default is this computer only. --lan adds one private home-network address.
// Never 0.0.0.0. choose is an explicit address, still private, still not every interface.
export function listenHosts({ lan = false, interfaces, choose } = {}) {
  const hosts = ["127.0.0.1"];
  if (!lan && !choose) return { hosts, phone: null };
  if (choose) {
    if (!isPrivateIPv4(choose) || (interfaces && !addressOn(interfaces, choose))) {
      const error = new Error("The chosen address has to be a private address on this Mac.");
      error.code = "NO_LAN";
      throw error;
    }
    hosts.push(choose);
    return { hosts, phone: choose };
  }
  const list = privateIPv4(interfaces);
  if (list.length === 0) {
    const error = new Error(
      "No private network address found. --lan needs a home-network address (192.168.x, 10.x, or 172.16-31.x).",
    );
    error.code = "NO_LAN";
    throw error;
  }
  hosts.push(list[0]);
  return { hosts, phone: list[0] };
}
