import { readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const xmlEscape = (value) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
const envelope = (
  operation,
  body = "",
) => `<?xml version="1.0" encoding="UTF-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body>
    <${operation} xmlns="urn:claimnexus">
${body}
    </${operation}>
  </soap:Body>
</soap:Envelope>`;

const parseScript = (operation) => `
pm.test('HTTP 200', () => pm.response.to.have.status(200));
const xml2js = require('xml2js');
xml2js.parseString(pm.response.text(), {
  explicitArray: false,
  tagNameProcessors: [xml2js.processors.stripPrefix]
}, (error, parsed) => {
  pm.test('Valid SOAP response', () => pm.expect(error).to.equal(null));
  if (error) return;
  const body = parsed.Envelope.Body;
  pm.test('No SOAP fault', () => pm.expect(body.Fault).to.equal(undefined));
  const data = body.${operation}Response;
  pm.test('${operation} response exists', () => pm.expect(data).to.exist);
  if (!data) return;
  /*ASSERTIONS*/
});`;
function request(
  name,
  operation,
  body = "",
  assertions = "",
  description = "",
) {
  return {
    name,
    request: {
      method: "POST",
      header: [
        { key: "Content-Type", value: "text/xml; charset=utf-8" },
        { key: "SOAPAction", value: `"urn:claimnexus/${operation}"` },
        { key: "X-API-Key", value: "{{apiKey}}" },
      ],
      body: {
        mode: "raw",
        raw: envelope(operation, body),
        options: { raw: { language: "xml" } },
      },
      url: "{{baseUrl}}/soap",
      description,
    },
    event: [
      {
        listen: "test",
        script: {
          type: "text/javascript",
          exec: parseScript(operation)
            .replace("/*ASSERTIONS*/", assertions)
            .trim()
            .split("\n"),
        },
      },
    ],
  };
}
const autoXml = await readFile(
  path.join(root, "data/xml_claims/partner_auto_batch.xml"),
  "utf8",
);
const healthXml = await readFile(
  path.join(root, "data/xml_claims/hospital_billing_feed.xml"),
  "utf8",
);
const capture = (
  variable,
  accepted,
) => `const rows = Array.isArray(data.result) ? data.result : [data.result];
  pm.test('All XML claims accepted', () => pm.expect(Number(data.accepted)).to.equal(${accepted}));
  pm.test('Claim ID returned', () => pm.expect(rows[0].id).to.match(/^CLM-/));
  if (rows[0].id) pm.collectionVariables.set('${variable}', rows[0].id);`;
const graphReady = `pm.test('Graph synchronized', () => pm.expect(data.claim.graphSync).to.equal('SYNCED'));`;
const collection = {
  info: {
    name: "ClaimNexus SOAP | MongoDB, Neo4j and XML demo",
    schema:
      "https://schema.getpostman.com/json/collection/v2.1.0/collection.json",
    description:
      "Run folders in order. SOAP requests use XML throughout. Imports use the original repository XML feeds and capture claim IDs automatically. Demo master records are synthetic. This collection adds demo records; it never deletes data. Repeated imports use stable transaction IDs and replay existing claims. API key is blank by default; set it locally if configured.",
  },
  variable: [
    { key: "baseUrl", value: "http://127.0.0.1:3100", type: "string" },
    { key: "apiKey", value: "", type: "string" },
    { key: "autoClaimId", value: "", type: "string" },
    { key: "healthClaimId", value: "", type: "string" },
  ],
  item: [
    {
      name: "1. Connection and MongoDB models",
      item: [
        {
          name: "Read WSDL XML contract",
          request: {
            method: "GET",
            header: [{ key: "X-API-Key", value: "{{apiKey}}" }],
            url: "{{baseUrl}}/soap?wsdl",
          },
          event: [
            {
              listen: "test",
              script: {
                type: "text/javascript",
                exec: [
                  "pm.test('WSDL retrieved', () => pm.response.to.have.status(200));",
                  "pm.test('Typed service contract', () => pm.expect(pm.response.text()).to.include('ClaimInput'));",
                ],
              },
            },
          ],
        },
        request(
          "Check both databases",
          "GetHealth",
          "",
          "pm.test('MongoDB connected', () => pm.expect(data.mongodb).to.equal('CONNECTED'));\npm.test('Neo4j connected', () => pm.expect(data.neo4j).to.equal('CONNECTED'));",
        ),
        request("Add demo master records", "SeedDemo"),
        request("Show customers model", "ListCustomers"),
        request("Show policies model", "ListPolicies"),
        request("Show providers and agents model", "ListProviders"),
      ],
    },
    {
      name: "2. Partner XML intake",
      item: [
        request(
          "Import original AUTO XML batch",
          "ImportClaimsXml",
          `      <xml>${xmlEscape(autoXml)}</xml>`,
          capture("autoClaimId", 2),
          "Two AUTO claims from the original partner_auto_batch.xml. Escaped XML is a string inside the SOAP xml parameter. PolicyRef, InsuredRef, TotalLossAmount and AutoDetails/Vin map to flat claim fields.",
        ),
        request(
          "Import original HEALTH XML feed",
          "ImportClaimsXml",
          `      <xml>${xmlEscape(healthXml)}</xml>`,
          capture("healthClaimId", 1),
          "One HEALTH claim from the original hospital_billing_feed.xml. DiagnosisCodes and ProcedureCodes are retained as strings.",
        ),
        request(
          "Inspect imported AUTO claim and audit events",
          "GetClaim",
          "      <id>{{autoClaimId}}</id>",
          graphReady,
        ),
        request(
          "Inspect imported HEALTH claim and audit events",
          "GetClaim",
          "      <id>{{healthClaimId}}</id>",
          graphReady,
        ),
        request(
          "Show stored claims",
          "ListClaims",
          "      <limit>50</limit>\n      <offset>0</offset>",
        ),
      ],
    },
    {
      name: "3. MongoDB to Neo4j integration",
      item: [
        request(
          "Find claims sharing the AUTO garage or agent",
          "GetRelatedClaims",
          "      <id>{{autoClaimId}}</id>",
          `pm.test('Shared relationships found', () => pm.expect(data.related).to.exist);`,
          "Neo4j finds connected claim IDs. The server then loads current statuses and amounts from MongoDB. The two partner AUTO claims share GARAGE-CENTRAL-01 and AGENT-LONE-STAR.",
        ),
        request(
          "Retry pending graph projections",
          "RetryGraphSync",
          "      <limit>100</limit>",
        ),
        request(
          "Replay the AUTO XML batch without creating new claims",
          "ImportClaimsXml",
          `      <xml>${xmlEscape(autoXml)}</xml>`,
          `const rows = Array.isArray(data.result) ? data.result : [data.result];
  pm.test('Same first claim ID', () => pm.expect(rows[0].id).to.equal(pm.collectionVariables.get('autoClaimId')));
  pm.test('Idempotent replay recorded', () => pm.expect(rows[0].message).to.equal('Idempotent replay'));`,
          "TransactionId becomes idempotencyKey. Replaying unchanged partner XML returns the same claim IDs.",
        ),
      ],
    },
  ],
};
const directory = path.join(root, "tools/postman");
await mkdir(directory, { recursive: true });
const destination = path.join(
  directory,
  "ClaimNexus-SOAP.postman_collection.json",
);
await writeFile(destination, `${JSON.stringify(collection, null, 2)}\n`);
console.log(destination);
