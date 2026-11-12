// Excluded local-CA fixture. NEVER install this CA in process/system trust.
import http from "node:http";
import https from "node:https";
import { checkServerIdentity } from "node:tls";
import { localTLSFixture } from "./tls-fixture.mjs";
const fixture = await localTLSFixture();
export const tlsOptions = { tlsName: fixture.name, tlsCertFile: fixture.certFile, tlsKeyFile: fixture.keyFile };
export const clientTLS = { ca: fixture.ca, servername: fixture.name,
  checkServerIdentity: (_host, cert) => checkServerIdentity(fixture.name, cert) };
// Explicit fixture-only client; default production trust is separately tested.
export function fetch(url, options = {}) {
  const target = new URL(url);
  if (target.hostname !== "127.0.0.1" || !["http:", "https:"].includes(target.protocol)) throw new Error("Fixture client requires loopback");
  return new Promise((resolve, reject) => {
    const request = (target.protocol === "https:" ? https : http).request(target, {
      ...(target.protocol === "https:" ? clientTLS : {}), agent: false,
      method: options.method || "GET", headers: options.headers, signal: options.signal,
    }, (response) => {
      const chunks = []; response.on("data", (chunk) => chunks.push(chunk)); response.on("error", reject);
      response.on("end", () => {
        const headers = new Headers();
        for (let index = 0; index < response.rawHeaders.length; index += 2) headers.append(response.rawHeaders[index], response.rawHeaders[index + 1]);
        resolve(new Response([204, 304].includes(response.statusCode) ? null : Buffer.concat(chunks), { status: response.statusCode, headers }));
      });
    });
    request.on("error", reject); request.end(options.body);
  });
}
