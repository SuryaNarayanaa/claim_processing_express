# ClaimNexus Express SOAP

An independent JavaScript application ported from `C:\Projects\claim_processing`. Express serves the dashboard and one SOAP 1.1 service. MongoDB stores operational records; Neo4j stores their relationships. No Next.js, React, REST business endpoints, Python or Spark runtime is required.

## Host on Render

Use [the Render deployment guide](tools/HOSTING.md) to deploy the Docker application with a free MongoDB Atlas cluster and Neo4j AuraDB Free instance. The repository includes a Render Blueprint, generated SOAP access key, public HTTPS WSDL address and `/healthz` operational check. Business operations remain SOAP.

For a walkthrough of MongoDB documents, Neo4j relationships and both XML layers, use [the Postman demo guide](tools/DEMO_GUIDE.md) and import [the Postman collection](tools/postman/ClaimNexus-SOAP.postman_collection.json).

## Run on Windows

```powershell
cd C:\Projects\claim_processing_express
Copy-Item .env.example .env # Only on first setup; keep an existing .env
npm.cmd ci
docker compose -p claimnexus-express up -d --wait
npm.cmd start
```

Open [the dashboard](http://127.0.0.1:3100) and click **Add demo data**. Or run `npm.cmd run seed` in a second terminal. The application runs at port 3100. SOAP and WSDL are at `http://127.0.0.1:3100/soap` and `http://127.0.0.1:3100/soap?wsdl`. Neo4j Browser is at `http://127.0.0.1:7475`. Local Neo4j credentials are in `.env.example`.

The compose project uses its own volumes, MongoDB port 27018 and Neo4j Bolt port 7688. It does not use the old application's database. To stop the databases while retaining their records, run `docker compose -p claimnexus-express down`.

MongoDB must be a replica set because claims and audit history commit in the same transaction. Compose initializes a single-node set for local use. The local MongoDB port is loopback-only and has no authentication; use authenticated database services and TLS for deployment. Neo4j Aura also works through the `neo4j+s://` URI and credentials in `.env`.

## Simple document model

| Collection  | Business fields                                                                                                                                                                                                            |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `customers` | `id`, `name`, optional `email`, `phone`                                                                                                                                                                                    |
| `policies`  | `id`, `customerId`, `type`, `status`, `startDate`, `endDate`, `coverageLimit`, `deductible`, `currency`, optional `assetId`                                                                                                |
| `providers` | `id`, `name`, `type` including `AGENT`                                                                                                                                                                                     |
| `claims`    | `id`, `policyId`, `customerId`, `type`, `incidentDate`, `reportedDate`, `amount`, `currency`, `description`, optional `assetId`, `providerId`, `agentId`, `location`, `diagnosisCodes`, `procedureCodes`, `idempotencyKey` |
| `events`    | `id`, `claimId`, `type`, `at`, optional `fromStatus`, `toStatus`, `message`                                                                                                                                                |

Claims also contain `status`, `validationErrors`, `riskIndicators`, `graphSync`, `version` and timestamps. The internal fingerprint checks whether an idempotency key has been reused for different input. Policies have an internal submission counter to serialize concurrent duplicate checks. The optional `analytics` collection stores the latest aggregate summary. Audit history stays in separate records instead of growing inside each claim.

The old nested `claim_details.auto/health/property`, address objects, covered-asset arrays and involved-entity arrays are replaced by these fields. One simplified policy covers one optional asset; one claim links one optional service provider and one agent. Vehicle make/year, supporting documents, additional participants and other old fields are retained in the original database and migration backup, not silently claimed as supported by the new model. Review this tradeoff before migrating a policy with multiple assets or a claim with multiple providers.

## MongoDB and Neo4j

Submitting a claim validates customer ownership, policy type/status/dates, amount/currency, asset and provider references. Syntax errors produce SOAP faults. Business validation failures are stored as `INVALID` with audit evidence. Duplicate detection uses policy, incident timestamp and amount against existing non-invalid claims. Accepted claims become `READY_FOR_ANALYSIS`.

MongoDB is the source of truth. Each claim includes a durable `graphSync` marker. After the claim and events commit, the bridge projects the saved claim into Neo4j:

```text
(Customer)-[:HOLDS]->(Policy)
(Customer)-[:FILED]->(Claim)-[:UNDER_POLICY]->(Policy)
(Claim)-[:SERVICED_BY]->(Provider)
(Claim)-[:HANDLED_BY]->(Agent)
(Claim)-[:INVOLVES]->(Asset)
```

Neo4j projection uses a transaction, stable IDs, uniqueness constraints and version checks. A failure leaves the MongoDB claim durable and sets `FAILED`. The worker retries pending/failed/unconfigured projections every 10 seconds; `RetryGraphSync` also triggers retries. Without Neo4j credentials, ingestion still works and graph queries return a configuration fault. `GetRelatedClaims` finds claims sharing a provider, agent or asset and reads their current operational status from MongoDB. Graph results are eventually consistent; pending claims are excluded.

Status changes and analytics update MongoDB and mark the graph pending in the same transaction. The projection fixes the original service's stale `RECEIVED` graph status. Deploy one application process for this local edition: streams and graph scheduling are in-process. A multi-instance deployment needs a shared worker queue and distributed projection coordination. External writes to MongoDB must also update `version` and mark `graphSync: PENDING`.

## SOAP operations

The document/literal WSDL defines typed XML requests and responses. Business data is not hidden inside JSON strings. The endpoint uses the maintained [node-soap server](https://github.com/vpulim/node-soap) on [Express](https://expressjs.com/en/5x/starter/static-files/).

- Claims: `SubmitClaim`, `GetClaim`, `ListClaims`, `GetSummary`, `SetClaimStatus`.
- Master data: `CreateCustomer`, `CreatePolicy`, `CreateProvider`, `ListCustomers`, `ListPolicies`, `ListProviders`.
- Databases and relationships: `GetHealth`, `GetRelatedClaims`, `RetryGraphSync`.
- Ingestion: `ImportClaimsXml`, `ImportClaimsBatch`, `SeedDemo`.
- Node data tools: `StartStream`, `GetStreamStatus`, `RunAnalytics`, `GetAnalyticsSummary`, `ExportLake`, `GetLakeInfo`.

Import the WSDL into SoapUI or use `soap.createClientAsync`. Requests use `Content-Type: text/xml` and SOAPAction such as `urn:claimnexus/SubmitClaim`. All dates are ISO 8601 timestamps with timezones. Lists accept up to 500 records per page; `ListClaims` accepts `offset`. Master lists return at most 500 records.

```xml
<?xml version="1.0"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body>
    <SubmitClaim xmlns="urn:claimnexus">
      <claim>
        <policyId>POL-AUTO-88219</policyId>
        <customerId>CUST-1001</customerId>
        <type>AUTO</type>
        <incidentDate>2026-03-20T12:00:00Z</incidentDate>
        <amount>2500</amount>
        <currency>USD</currency>
        <description>Front bumper repair following collision.</description>
        <assetId>1HGCR2F83HA019284</assetId>
        <providerId>GAR-77401</providerId>
        <agentId>AGT-3029</agentId>
        <idempotencyKey>partner-request-001</idempotencyKey>
      </claim>
    </SubmitClaim>
  </soap:Body>
</soap:Envelope>
```

Copy this request into a file, then call it with `curl.exe -H "Content-Type: text/xml" -H "SOAPAction: urn:claimnexus/SubmitClaim" --data-binary "@request.xml" http://127.0.0.1:3100/soap`. Set `SOAP_API_KEY` before exposing a non-loopback host, and send it in `X-API-Key`. The browser asks for the configured key and holds it only in memory. WSDL retrieval requires the key too. This shared-key local edition does not implement user accounts or role-based access; all authorized SOAP clients have the same permissions.

The server caps XML envelopes at 1 MiB and rejects DTD/entity declarations. XML import supports the original `ClaimsBatch` ACORD and hospital examples in `data/xml_claims`, including `PROPERTY` claims through `<Claim>`. Batch requests accept 1–100 claims and return a per-record result. For partner XML, put the XML document as escaped text inside the SOAP `xml` element, or use the dashboard upload. Imports never create fictional vehicle or diagnosis values to make validation pass. Demo master data supports both included feeds.

## Stream, analytics and Parquet

Stream generation now uses Node timers and the same ingestion service. It is explicitly synthetic and stops when the application stops. Supply external claims as a JSON array through the dashboard or `ImportClaimsBatch`; transform benchmark CSV rows into the documented flat contract first. The new UI does not call a random stream a real benchmark dataset.

Analytics uses MongoDB aggregation from Node.js, not PySpark. It flags at least three eligible claims from at least two customers sharing a provider/agent pair. This is a review indicator, not a fraud conclusion or a trained risk model. Approved, rejected, settled and invalid claims are excluded. Repeated analysis does not append duplicate flag events. The latest summary is persisted in MongoDB.

`ExportLake` writes a real Parquet snapshot of flat claims into `datalake/snapshots`. It is an explicit full snapshot, not the old Python partitioned ingestion lake, and does not claim distributed execution. Each snapshot includes invalid claims and current statuses. Data lake counts refer to local files. Streams are in-memory; analytics and claims survive restart.

## Legacy migration

The original project and data remain untouched. Migration is optional and is not run during startup. Configure `LEGACY_MONGODB_URI` and the two database names in `.env`. Use a fresh target database for migration, before adding demo data:

```powershell
npm.cmd run migrate                 # Read-only validation and count plan
npm.cmd run migrate -- --apply      # Back up originals, then copy atomically
```

The apply command archives full originals under `migration-backups`, preserves claim IDs, final statuses and audit events, and sets graph projections pending. Old transient states become `UNDER_REVIEW` with an import audit record. It rejects policies with multiple covered assets, colliding target IDs and nonempty target claims. Source and destination names must differ. No source documents are deleted or rewritten. Review the backup and field limitations above before choosing the simplified model for existing data. Migration is intended for modest local datasets because it reads and copies the selected records in one transaction.

## Validation

```powershell
npm.cmd test
npm.cmd run test:integration
```

Unit tests cover simplified inputs, date normalization, original XML feeds and unsafe/malformed XML. Integration tests start a temporary Express listener, use a real SOAP client, and verify real MongoDB transactions plus Neo4j writes/queries, concurrent idempotency, lifecycle updates, graph failure/retry, analytics, readable Parquet, authentication and envelope limits. They require the compose databases and use a randomly named test MongoDB database with scoped test graph IDs, then clean up only those records.
