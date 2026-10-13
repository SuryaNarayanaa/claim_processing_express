import { MongoClient } from "mongodb";
import { mkdir, writeFile } from "node:fs/promises";
import { randomUUID, createHash } from "node:crypto";
import path from "node:path";
import { connectDatabases, transaction } from "../src/db.js";
import { root } from "../src/app.js";
import {
  claimSchema,
  customerSchema,
  policySchema,
  providerSchema,
  parse,
  statuses,
} from "../src/domain.js";

// Default is a read-only plan. --apply copies records, never changes the source.
const apply = process.argv.includes("--apply");
const sourceName = process.env.LEGACY_MONGODB_DB_NAME || "claims_db";
const targetName = process.env.MONGODB_DB_NAME || "claimnexus_express";
if (sourceName === targetName)
  throw new Error("Source and target database names must differ");
if (!process.env.LEGACY_MONGODB_URI)
  throw new Error("Set LEGACY_MONGODB_URI explicitly");
const source = new MongoClient(process.env.LEGACY_MONGODB_URI, {
  serverSelectionTimeoutMS: 5000,
});
let target;
try {
  await source.connect();
  const db = source.db(sourceName);
  const snapshot = {};
  for (const name of [
    "customers",
    "policies",
    "service_providers",
    "claims",
    "claim_events",
  ])
    snapshot[name] = await db.collection(name).find({}).toArray();
  const date = (v) => new Date(v).toISOString();
  const optional = (obj) =>
    Object.fromEntries(
      Object.entries(obj).filter(
        ([, v]) => v !== undefined && v !== null && v !== "",
      ),
    );
  const converted = {
    customers: snapshot.customers.map((c) => ({
      ...parse(
        customerSchema,
        optional({
          id: c.customer_id,
          name: c.full_name,
          email: c.email,
          phone: c.phone,
        }),
      ),
      createdAt: c.created_at || new Date().toISOString(),
    })),
    policies: snapshot.policies.map((p) => {
      if ((p.covered_assets || []).length > 1)
        throw new Error(
          `Policy ${p.policy_id} has multiple assets. Split it into separate policy records before using the one-asset simplified model.`,
        );
      return {
        ...parse(
          policySchema,
          optional({
            id: p.policy_id,
            customerId: p.customer_id,
            type: p.policy_type,
            status: p.status,
            startDate: date(p.start_date),
            endDate: date(p.end_date),
            coverageLimit: p.coverage_limit,
            deductible: p.deductible,
            currency: p.currency || "USD",
            assetId: p.covered_assets?.[0]?.identifier,
          }),
        ),
        createdAt: p.created_at || new Date().toISOString(),
      };
    }),
    providers: snapshot.service_providers.map((p) => ({
      ...parse(providerSchema, {
        id: p.provider_id,
        name: p.business_name,
        type: p.provider_type,
      }),
      createdAt: p.created_at || new Date().toISOString(),
    })),
    claims: [],
    events: [],
  };
  for (const c of snapshot.claims) {
    const entities = c.involved_entities || [];
    const provider = entities.find((e) =>
      ["GARAGE", "HOSPITAL"].includes(e.entity_type),
    );
    const agent = entities.find((e) => e.entity_type === "AGENT");
    if (agent && !converted.providers.some((p) => p.id === agent.entity_id))
      converted.providers.push({
        id: agent.entity_id,
        name: agent.name || agent.entity_id,
        type: "AGENT",
        createdAt: new Date().toISOString(),
      });
    const input = parse(
      claimSchema,
      optional({
        policyId: c.policy_id,
        customerId: c.customer_id,
        type: c.claim_type,
        incidentDate: date(c.incident_date),
        reportedDate: date(c.reported_date || c.created_at),
        amount: c.claimed_amount,
        currency: c.currency,
        description: c.description,
        assetId:
          c.claim_details?.auto?.vin ||
          c.claim_details?.property?.property_address,
        providerId:
          provider?.entity_id || c.claim_details?.property?.inspector_id,
        agentId: agent?.entity_id,
        location:
          typeof c.location === "object"
            ? [
                c.location.street,
                c.location.city,
                c.location.state,
                c.location.postal_code,
              ]
                .filter(Boolean)
                .join(", ")
            : c.location,
        diagnosisCodes: c.claim_details?.health?.diagnosis_codes?.join(", "),
        procedureCodes: c.claim_details?.health?.procedure_codes?.join(", "),
        idempotencyKey: c.idempotency_key,
      }),
    );
    const status = statuses.includes(c.status) ? c.status : "UNDER_REVIEW";
    converted.claims.push({
      ...input,
      id: c.claim_id,
      status,
      validationErrors: c.validation_errors || [],
      riskIndicators: c.risk_indicators || [],
      graphSync: "PENDING",
      version: 1,
      createdAt: date(c.created_at),
      updatedAt: date(c.updated_at || c.created_at),
      fingerprint: createHash("sha256")
        .update(
          JSON.stringify(
            Object.fromEntries(
              Object.entries(input).sort(([a], [b]) => a.localeCompare(b)),
            ),
          ),
        )
        .digest("hex"),
    });
    converted.events.push({
      id: `migration-${c.claim_id}`,
      claimId: c.claim_id,
      type: "LEGACY_IMPORT",
      toStatus: status,
      at: new Date().toISOString(),
      message: `Imported legacy status ${c.status}. Full original details preserved in migration backup.`,
    });
  }
  converted.events.push(
    ...snapshot.claim_events.map((e) =>
      optional({
        id: e.event_id || randomUUID(),
        claimId: e.claim_id,
        type: e.event_type,
        fromStatus: e.from_status,
        toStatus: e.to_status,
        at: date(e.timestamp),
        message: JSON.stringify(e.details || {}),
      }),
    ),
  );
  console.log(
    JSON.stringify(
      {
        mode: apply ? "APPLY" : "DRY_RUN",
        source: sourceName,
        target: targetName,
        counts: Object.fromEntries(
          Object.entries(converted).map(([n, records]) => [n, records.length]),
        ),
        note: "Original nested fields remain in the source and in the backup. Non-final pipeline states become UNDER_REVIEW.",
      },
      null,
      2,
    ),
  );
  if (apply) {
    target = await connectDatabases();
    if (await target.db.collection("claims").countDocuments())
      throw new Error(
        "Target claims collection must be empty before applying migration. Use a fresh target database.",
      );
    const directory = path.join(root, "migration-backups");
    await mkdir(directory, { recursive: true });
    const backup = path.join(directory, `legacy-${Date.now()}.json`);
    await writeFile(backup, JSON.stringify(snapshot, null, 2), { flag: "wx" });
    await transaction(target, async (session) => {
      for (const [collection, records] of Object.entries(converted))
        for (const record of records) {
          if (
            await target.db
              .collection(collection)
              .findOne({ id: record.id }, { session })
          )
            throw new Error(
              `Target already contains ${collection}/${record.id}; use a fresh target database`,
            );
          await target.db.collection(collection).insertOne(record, { session });
        }
    });
    console.log(
      `Copied records. Backup: ${backup}. Start the server to project pending claims into Neo4j.`,
    );
  }
} finally {
  await target?.close();
  await source.close();
}
