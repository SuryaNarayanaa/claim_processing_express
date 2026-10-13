# Demonstrating MongoDB, Neo4j and XML

Use three tools: Postman for SOAP requests/responses, MongoDB Compass for documents, and Neo4j Browser for nodes, relationships and Cypher tables. No application redesign or custom visualization is needed.

## 1. Postman: show XML requests and responses

Import `tools/postman/ClaimNexus-SOAP.postman_collection.json` into Postman using **Import**, then select the collection. Its variables already contain `baseUrl = http://127.0.0.1:3100`. Leave `apiKey` empty for the default local setup; set it locally if your server has `SOAP_API_KEY` configured. Use the desktop app, or a desktop agent that can reach localhost.

Start the service if it is not already running:

```powershell
cd C:\Projects\claim_processing_express
docker compose -p claimnexus-express up -d --wait
npm.cmd start
```

Run the folders in their numbered order, either request by request for a demonstration or using the collection runner:

| Folder                        | What to show                                                                     |
| ----------------------------- | -------------------------------------------------------------------------------- |
| Connection and MongoDB models | WSDL, both database connections, demo setup, customers, policies and providers   |
| Partner XML intake            | AUTO batch and HEALTH feed requests; then the normalized claim and audit history |
| MongoDB to Neo4j integration  | Shared garage/agent lookup, graph retry and idempotent replay                    |

Each SOAP request uses `POST /soap`, `Content-Type: text/xml; charset=utf-8`, and an operation-specific `SOAPAction`. In Postman, inspect **Body → raw → XML** and the response body. The service requires `text/xml`; do not let Postman's automatic `application/xml` header override it. The first GET request retrieves the WSDL contract, not business records.

The import requests capture the first returned claim ID in collection variables `autoClaimId` and `healthClaimId`. The later requests use those IDs automatically. The collection adds synthetic master records and imports the repository's sample partner feeds. It does not delete existing data or update claim approval decisions.

Postman supports [SOAP HTTP requests](https://learning.postman.com/docs/use/send-requests/protocols/soap/making-soap-requests/) and [collection import](https://learning.postman.com/docs/getting-started/importing-and-exporting/importing-data/).

## 2. MongoDB Compass: show document models

Connect with:

```text
mongodb://127.0.0.1:27018/?replicaSet=rs0&directConnection=true
```

Select database `claimnexus_express`. In each collection's **Documents** view, expand one record or use JSON view to show its fields. The runtime uses native MongoDB collections with Zod validation in the application. It does not create Mongoose models or MongoDB collection-level JSON Schema validators.

| Collection  | Main business fields                                                                                                                                                              |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `customers` | `id`, `name`, optional `email`, `phone`                                                                                                                                           |
| `policies`  | `id`, `customerId`, `type`, `status`, `startDate`, `endDate`, `coverageLimit`, `deductible`, `currency`, optional `assetId`                                                       |
| `providers` | `id`, `name`, `type`; includes records whose type is `AGENT`                                                                                                                      |
| `claims`    | `id`, `policyId`, `customerId`, `type`, `incidentDate`, `reportedDate`, `amount`, `currency`, `description`; optional asset/provider/agent IDs, location and medical-code strings |
| `events`    | `id`, `claimId`, `type`, `at`, `message`, optional `fromStatus`, `toStatus`                                                                                                       |
| `analytics` | Latest Node.js analytics summary, created after `RunAnalytics`                                                                                                                    |

MongoDB also adds `_id`. Claims carry `status`, `validationErrors`, `riskIndicators`, `graphSync`, `version`, `createdAt`, `updatedAt`, optional `idempotencyKey`, and an internal request `fingerprint`. Policies carry an internal `submissionVersion` counter. Do not mistake these processing fields for XML source tags.

In the `claims` Filter box, paste:

```javascript
{ "idempotencyKey": "XML-TX-AUTO-1001" }
```

This shows the first imported AUTO claim. Point out `amount: 8500`, `providerId: "GARAGE-CENTRAL-01"`, `agentId: "AGENT-LONE-STAR"`, `assetId: "1FTFW1ED4MFA19283"`, and `graphSync: "SYNCED"`. Copy its generated `id`.

In `events`, filter using that exact ID:

```javascript
{ "claimId": "PASTE_THE_RETURNED_CLAIM_ID" }
```

Show the `CLAIM_RECEIVED` and `VALIDATION_SUCCEEDED` records. For the health claim, use `{ "idempotencyKey": "XML-TX-HEALTH-2001" }` and show `diagnosisCodes` and `procedureCodes`.

For a shell-based inspection, the read-only commands in `tools/mongodb-demo.mongosh.js` show models, XML claims and audit events. These filters use the [Compass query bar](https://www.mongodb.com/docs/compass/query/filter/).

## 3. Neo4j Browser: show the graph data model

Open `http://127.0.0.1:7475`. Connect to `bolt://127.0.0.1:7688` with the username/password from your `.env`. The compose defaults are `neo4j` and `claimnexus-local-only`.

Run statements from `tools/neo4j-demo.cypher` one at a time. Select the **Table** result view if you want to show data without graph visuals. Neo4j Browser supports [Cypher queries and table results](https://neo4j.com/docs/browser/visual-tour/).

| Neo4j label | Stored properties                                                       | MongoDB source                                                                                          |
| ----------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `Claim`     | `id`, `type`, `amount`, `currency`, `status`, `incidentDate`, `version` | `claims`                                                                                                |
| `Customer`  | `id`                                                                    | Claim's `customerId`; customer name/contact details are not projected                                   |
| `Policy`    | `id`                                                                    | Claim's `policyId`; coverage limits/dates are not projected                                             |
| `Provider`  | `id`, `name`, `type`                                                    | Claim's `providerId`, with name/type read from `providers`                                              |
| `Agent`     | `id`, `name`, `type`                                                    | Claim's `agentId`, with name/type read from `providers`; there is no separate MongoDB agents collection |
| `Asset`     | `id`, `name`, `type`                                                    | Claim's `assetId`; current bridge uses the ID as name and `ASSET` as type                               |

Relationships created by the bridge:

```text
Customer → HOLDS → Policy
Customer → FILED → Claim
Claim → UNDER_POLICY → Policy
Claim → SERVICED_BY → Provider
Claim → HANDLED_BY → Agent
Claim → INVOLVES → Asset
```

Provider/agent/asset links exist only when those fields are present on the claim. Node IDs have uniqueness constraints for each label. Creating a master customer or policy alone does not project it; projection is claim-driven.

To compare one exact record between the databases, paste the MongoDB business ID into this query:

```cypher
MATCH (c:Claim {id: 'PASTE_THE_RETURNED_CLAIM_ID'})
RETURN properties(c) AS neo4jClaim;
```

The two imported AUTO claims share `GARAGE-CENTRAL-01` and `AGENT-LONE-STAR`. Show this with query 6 in the Cypher file, then run the corresponding **Find claims sharing the AUTO garage or agent** request in Postman. A shared relationship is an investigation lead, not proof of wrongdoing.

## 4. Explain how the databases exchange data

There is no automatic database-to-database link. The Express application connects to both through their drivers. MongoDB is the authoritative operational store, while Neo4j receives a selected relationship projection:

1. Express validates and normalizes the claim.
2. A MongoDB transaction saves the claim and its audit events, with `graphSync: PENDING`.
3. `GraphBridge.project` reads that saved claim and relevant provider records from MongoDB.
4. A separate Neo4j transaction creates/updates nodes and relationships using `MERGE`.
5. Express marks the matching MongoDB claim version `SYNCED`. A graph write failure sets `FAILED`; retries run every 10 seconds and through `RetryGraphSync`.

The two database commits are separate, so synchronization is eventually consistent. Neo4j failure does not discard the committed MongoDB claim. Descriptions, medical codes, audit events and policy coverage details remain in MongoDB. Raw XML is not stored in either database by this intake path.

For reads, `GetRelatedClaims` first queries Neo4j for shared entities and claim IDs. Express then retrieves current statuses/amounts for those IDs from MongoDB. Neo4j does not directly write business data back to MongoDB. `SetClaimStatus` changes MongoDB plus its audit trail, then projects the new status into Neo4j.

## 5. Explain the two uses of XML

**SOAP XML is the API message format.** Every business request and response uses a SOAP envelope. `SubmitClaim` receives typed XML claim fields directly. WSDL is also XML and declares operation names, request/response types and the service address.

**Partner XML is the imported source document.** `ImportClaimsXml` accepts the full partner XML document as a string inside the SOAP `<xml>` parameter. The collection embeds it as escaped XML text. The SOAP parser recovers that string, then `parseClaimsXml` parses the inner document. These are two different parsing steps.

| Partner tag                       | Flat claim field                  |
| --------------------------------- | --------------------------------- |
| `TransactionId`                   | `idempotencyKey`                  |
| `PolicyRef`                       | `policyId`                        |
| `InsuredRef`                      | `customerId`                      |
| `LossType`                        | `type`                            |
| `LossDate`                        | `incidentDate`                    |
| `NoticeAt`                        | `reportedDate`                    |
| `TotalLossAmount`                 | `amount`, converted into a number |
| `Currency`                        | `currency`                        |
| `LossNarrative`                   | `description`                     |
| `RepairFacilityId` / `FacilityId` | `providerId`                      |
| `ProducerId`                      | `agentId`                         |
| `AutoDetails/Vin`                 | `assetId`                         |
| `IncidentLocation`                | `location`                        |
| `HealthDetails/DiagnosisCodes`    | `diagnosisCodes`, a string        |
| `HealthDetails/ProcedureCodes`    | `procedureCodes`, a string        |

Date-only XML values get `T12:00:00Z` during import, then normalize to ISO timestamps. Missing currency defaults to USD. XML attributes, vehicle make/year, repair estimate and other unmapped source tags are not stored by the simplified parser. Provider names come from existing MongoDB master records, not the partner's `RepairFacilityName` or `ProducerName` tags.

The parser accepts `ClaimsBatch` containing `ACORDClaim`, `InsuranceClaim` or `Claim`, and also single claims with those root tags. It limits batches to 100 records, rejects malformed XML and DTD/entity declarations, and validates each mapped claim through the same ingestion service. A structurally valid business-invalid claim is saved as `INVALID`; invalid claim syntax returns a per-record error without a saved claim. Invalid claims are still projected by the current bridge, carrying `status: INVALID`.

Repeat the AUTO import and show the same returned IDs. This demonstrates how `TransactionId` prevents duplicate request ingestion. Then show the same claim in Compass and Neo4j to demonstrate XML-to-document and document-to-graph conversion.

## Source code to show during questions

- `src/domain.js`: simple input schemas.
- `src/xml.js`: partner tag mapping and XML checks.
- `src/contract.js`: SOAP/WSDL definitions.
- `src/app.js`: SOAP operation handlers.
- `src/claims.js`: validation, MongoDB claim/event transaction and graph handoff.
- `src/graph.js`: projected properties, relationships, retries and shared-claim reads.
- `src/server.js`: periodic graph retry.

Regenerate the collection after changing the sample XML with `node scripts/build-postman-demo.js`.
