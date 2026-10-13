import assert from "node:assert/strict";
import soap from "soap";
import { XMLParser } from "fast-xml-parser";

// Read-only verification. Keep the key in an ignored .env.hosting file or the environment.
async function verify() {
  const base = new URL(process.env.HOSTED_BASE_URL);
  assert.ok(!base.username && !base.password && !base.search && !base.hash && base.pathname === "/",
    "HOSTED_BASE_URL must be the service origin without credentials or query parameters");
  assert.ok(base.protocol === "https:" ||
    (base.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(base.hostname)),
    "Use an HTTPS hosted URL");
  const key = process.env.SOAP_API_KEY;
  assert.ok(key, "Set SOAP_API_KEY in the environment");
  const endpoint = new URL("/soap", base).href;
  const deadline = () => AbortSignal.timeout(120000); // Includes free-tier cold starts.
  const page = await fetch(base, { signal: deadline() });
  assert.equal(page.status, 200, "Dashboard must respond");
  assert.match(await page.text(), /ClaimNexus/);
  const health = await fetch(new URL("/healthz", base), { signal: deadline() });
  assert.equal(health.status, 200, "Operational readiness must pass");
  assert.equal(await health.text(), "ok");
  const denied = await fetch(`${endpoint}?wsdl`, { signal: deadline() });
  assert.equal(denied.status, 401, "WSDL must require a key");
  const wsdl = await fetch(`${endpoint}?wsdl`, {
    headers: { "X-API-Key": key }, signal: deadline(),
  });
  assert.equal(wsdl.status, 200, "Authenticated WSDL must respond");
  const parsed = new XMLParser({ ignoreAttributes: false, removeNSPrefix: true }).parse(await wsdl.text());
  assert.equal(parsed.definitions.service.port.address["@_location"], endpoint,
    "WSDL must advertise the real public SOAP address");
  const client = await soap.createClientAsync(`${endpoint}?wsdl`, {
    wsdl_headers: { "X-API-Key": key }, wsdl_options: { timeout: 120000 },
  });
  client.addHttpHeader("X-API-Key", key);
  const [databaseHealth] = await client.GetHealthAsync({}, { timeout: 120000 });
  assert.equal(databaseHealth.mongodb, "CONNECTED", "MongoDB must connect");
  assert.equal(databaseHealth.neo4j, "CONNECTED", "Neo4j must connect");
  assert.equal(databaseHealth.status, "HEALTHY");
  await client.GetSummaryAsync({}, { timeout: 120000 });
  console.log(`Verified ${base.origin}: dashboard, readiness, SOAP authentication, public WSDL, MongoDB and Neo4j.`);
}

verify().catch(() => {
  // Driver errors can contain connection details. Keep the CLI output safe for shared logs.
  console.error("Hosting verification failed. Check the service URL, API key, deployment logs and database access settings.");
  process.exitCode = 1;
});
