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

// interfaces matches the shape of os.networkInterfaces().
export function privateIPv4(interfaces = os.networkInterfaces()) {
  const found = [];
  for (const addrs of Object.values(interfaces || {})) {
    for (const addr of addrs || []) {
      const family = addr.family;
      if (family !== "IPv4" && family !== 4) continue;
      if (addr.internal) continue;
      if (isPrivateIPv4(addr.address)) found.push(addr.address);
    }
  }
  return found;
}

// Default is this computer only. --lan adds one private home-network address.
// Never 0.0.0.0.
export function listenHosts({ lan = false, interfaces } = {}) {
  const hosts = ["127.0.0.1"];
  if (!lan) return { hosts, phone: null };
  const list = privateIPv4(interfaces);
  if (list.length === 0) {
    const error = new Error(
      "No private network address found. --lan needs a home-network address (10.x, 192.168.x, or 172.16-31.x).",
    );
    error.code = "NO_LAN";
    throw error;
  }
  hosts.push(list[0]);
  return { hosts, phone: list[0] };
}
