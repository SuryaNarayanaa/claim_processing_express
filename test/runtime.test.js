import test from "node:test";
import assert from "node:assert/strict";
import { runtimeConfig, soapEndpoint } from "../src/runtime.js";

const production = {
  NODE_ENV: "production",
  RENDER: "true",
  RENDER_EXTERNAL_URL: "https://claims.onrender.com",
  PORT: "10000",
  MONGODB_URI: "mongodb+srv://example.mongodb.net",
  NEO4J_URI: "neo4j+s://example.databases.neo4j.io",
  NEO4J_PASSWORD: "fixture-password",
  SOAP_API_KEY: "fixture-key-with-at-least-32-characters",
};

test("Hosted WSDL advertises the Render HTTPS endpoint and supports a custom domain", () => {
  assert.deepEqual(runtimeConfig(production), {
    host: "0.0.0.0", port: 10000, retryMs: 10000,
    endpoint: "https://claims.onrender.com/soap",
  });
  assert.equal(soapEndpoint({ ...production, SOAP_PUBLIC_URL: "https://claims.example.com/soap" }),
    "https://claims.example.com/soap");
  assert.equal(soapEndpoint({ PORT: "3100" }), "http://127.0.0.1:3100/soap");
});

test("Public startup requires authentication and both database configurations", () => {
  assert.throws(() => runtimeConfig({ HOST: "0.0.0.0" }), /SOAP_API_KEY/);
  for (const name of ["MONGODB_URI", "NEO4J_URI", "NEO4J_PASSWORD"])
    assert.throws(() => runtimeConfig({ ...production, [name]: "" }), new RegExp(name));
  assert.throws(() => runtimeConfig({ ...production, SOAP_API_KEY: "short" }), /at least 32/);
  assert.throws(() => runtimeConfig({ PORT: "garbage" }), /Invalid PORT/);
});

test("Reject insecure, credential-bearing and invalid WSDL addresses", () => {
  for (const address of [
    "http://claims.example.com/soap", "https://user:pass@claims.example.com/soap",
    "https://claims.example.com/soap?key=secret", "https://claims.example.com/soap#fragment",
    "https://claims.example.com/other", "javascript:alert(1)", "not-a-url",
  ]) assert.throws(() => soapEndpoint({ SOAP_PUBLIC_URL: address }), /SOAP_PUBLIC_URL/);
});
