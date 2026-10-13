import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import soap from "soap";
import parquet from "parquetjs-lite";
import { connectDatabases } from "../../src/db.js";
import { createApp, root } from "../../src/app.js";
import { seedDemo } from "../../src/seed.js";
import { GraphBridge } from "../../src/graph.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

test(
  "Real SOAP, MongoDB transactions and Neo4j projection integration",
  { timeout: 120000 },
  async (t) => {
    const suffix = randomUUID().slice(0, 8),
      dbName = `claimnexus_test_${suffix}`;
    const ctx = await connectDatabases({
      ...process.env,
      MONGODB_DB_NAME: dbName,
    });
    assert.ok(
      ctx.graph,
      "NEO4J_URI and NEO4J_PASSWORD are required for the integration suite",
    );
    await ctx.graph.verifyConnectivity();
    const instance = await createApp(ctx, {
      PORT: 0,
      SOAP_API_KEY: "test-key",
    });
    const server = instance.app.listen(0, "127.0.0.1");
    await new Promise((resolve) => server.once("listening", resolve));
    const endpoint = `http://127.0.0.1:${server.address().port}/soap`;
    let exported;
    const graphIds = [];
    t.after(async () => {
      await instance.jobs.stop();
      await new Promise((resolve) => server.close(resolve));
      const session = ctx.graph.session({ database: ctx.graphDatabase });
      try {
        await session.run("MATCH (n) WHERE n.id IN $ids DETACH DELETE n", {
          ids: graphIds,
        });
      } finally {
        await session.close();
      }
      await ctx.db.dropDatabase();
      await ctx.close();
      if (exported) await rm(path.join(root, exported), { force: true });
    });
    const client = await soap.createClientAsync(`${endpoint}?wsdl`, {
      wsdl_headers: { "X-API-Key": "test-key" },
    });
    client.setEndpoint(endpoint);
    client.addHttpHeader("X-API-Key", "test-key");
    const invoke = async (op, args = {}) =>
      (await client[`${op}Async`](args))[0];
    const C = `C-${suffix}`,
      P = `P-${suffix}`,
      G = `G-${suffix}`,
      A = `A-${suffix}`,
      V = `V-${suffix}`;
    graphIds.push(C, P, G, A, V);
    await t.test(
      "SOAP master records, valid submission and final graph status",
      async () => {
        await invoke("CreateCustomer", {
          customer: { id: C, name: "Integration customer" },
        });
        await invoke("CreateProvider", {
          provider: { id: G, name: "Test garage", type: "GARAGE" },
        });
        await invoke("CreateProvider", {
          provider: { id: A, name: "Test agent", type: "AGENT" },
        });
        await invoke("CreatePolicy", {
          policy: {
            id: P,
            customerId: C,
            type: "AUTO",
            startDate: "2020-01-01T00:00:00Z",
            endDate: "2030-01-01T00:00:00Z",
            coverageLimit: 10000,
            assetId: V,
          },
        });
        const result = await invoke("SubmitClaim", {
          claim: {
            policyId: P,
            customerId: C,
            type: "AUTO",
            incidentDate: "2026-01-01T12:00:00Z",
            amount: 2000,
            description: "Test bumper repair",
            assetId: V,
            providerId: G,
            agentId: A,
            idempotencyKey: `key-${suffix}`,
          },
        });
        graphIds.push(result.claim.id);
        assert.equal(result.accepted, true);
        assert.equal(result.claim.graphSync, "SYNCED");
        const session = ctx.graph.session({ database: ctx.graphDatabase });
        try {
          const rows = await session.run(
            "MATCH (c:Claim {id:$id})-[:SERVICED_BY]->(p:Provider {id:$providerId}) RETURN c.status AS status",
            { id: result.claim.id, providerId: G },
          );
          assert.equal(rows.records[0].get("status"), "READY_FOR_ANALYSIS");
        } finally {
          await session.close();
        }
        const details = await invoke("GetClaim", { id: result.claim.id });
        assert.equal(details.event.length, 2);
      },
    );
    const input = {
      policyId: P,
      customerId: C,
      type: "AUTO",
      incidentDate: "2026-01-02T12:00:00Z",
      amount: 2100,
      description: "Second repair claim",
      assetId: V,
      providerId: G,
      agentId: A,
      idempotencyKey: `concurrent-${suffix}`,
    };
    await t.test(
      "Concurrent idempotent requests create one claim and reject key reuse",
      async () => {
        const results = await Promise.all(
          Array.from({ length: 4 }, () =>
            invoke("SubmitClaim", { claim: input }),
          ),
        );
        graphIds.push(results[0].claim.id);
        assert.equal(new Set(results.map((r) => r.claim.id)).size, 1);
        assert.equal(
          await ctx.db
            .collection("claims")
            .countDocuments({ idempotencyKey: input.idempotencyKey }),
          1,
        );
        await assert.rejects(
          invoke("SubmitClaim", { claim: { ...input, amount: 999 } }),
          /Idempotency key/,
        );
      },
    );
    await t.test(
      "Invalid policy/type/asset checks persist audit evidence",
      async () => {
        const result = await invoke("SubmitClaim", {
          claim: {
            ...input,
            idempotencyKey: `invalid-${suffix}`,
            type: "HEALTH",
            assetId: "wrong",
            amount: 50000,
          },
        });
        graphIds.push(result.claim.id, "wrong");
        assert.equal(result.accepted, false);
        assert.equal(result.claim.status, "INVALID");
        assert.ok(result.claim.validationErrors.length >= 3);
        await assert.rejects(
          invoke("SubmitClaim", { claim: { ...input, amount: -1 } }),
          /amount/,
        );
      },
    );
    await t.test(
      "Graph queries, transitions and serialization stay consistent",
      async () => {
        const id = graphIds.find((v) => v.startsWith("CLM-"));
        const related = await invoke("GetRelatedClaims", { id });
        assert.ok(related.related.length >= 1);
        await invoke("SetClaimStatus", { id, status: "APPROVED" });
        await invoke("SetClaimStatus", { id, status: "SETTLED" });
        await assert.rejects(
          invoke("SetClaimStatus", { id, status: "UNDER_REVIEW" }),
          /Cannot move/,
        );
        const details = await invoke("GetClaim", { id });
        assert.equal(details.claim.status, "SETTLED");
        assert.equal(details.event.length, 4);
        const session = ctx.graph.session({ database: ctx.graphDatabase });
        try {
          const row = await session.run(
            "MATCH (c:Claim {id:$id}) RETURN c.status AS status",
            { id },
          );
          assert.equal(row.records[0].get("status"), "SETTLED");
        } finally {
          await session.close();
        }
        const list = await invoke("ListClaims", { limit: 2, offset: 0 });
        assert.equal(list.claim.length, 2);
        await assert.rejects(
          invoke("ListClaims", { limit: -1 }),
          /greater|at least|>=/,
        );
      },
    );
    await t.test(
      "Neo4j failure leaves Mongo durable and retry repairs it",
      async () => {
        const driver = ctx.graph;
        ctx.graph = {
          session: () => ({
            executeWrite: async () => {
              throw new Error("Test outage");
            },
            close: async () => {},
          }),
        };
        let result;
        try {
          result = await invoke("SubmitClaim", {
            claim: {
              ...input,
              idempotencyKey: `outage-${suffix}`,
              incidentDate: "2026-01-03T12:00:00Z",
            },
          });
        } finally {
          ctx.graph = driver;
        }
        graphIds.push(result.claim.id);
        assert.equal(result.claim.graphSync, "FAILED");
        assert.equal(result.accepted, true);
        const retry = await invoke("RetryGraphSync", {});
        assert.equal(retry.synced, 1);
        assert.equal(
          (await invoke("GetClaim", { id: result.claim.id })).claim.graphSync,
          "SYNCED",
        );
      },
    );
    await t.test(
      "Analytics flags shared clusters once and exports readable Parquet",
      async () => {
        const C2 = `C2-${suffix}`,
          P2 = `P2-${suffix}`;
        graphIds.push(C2, P2);
        await invoke("CreateCustomer", {
          customer: { id: C2, name: "Second customer" },
        });
        await invoke("CreatePolicy", {
          policy: {
            id: P2,
            customerId: C2,
            type: "AUTO",
            startDate: "2020-01-01T00:00:00Z",
            endDate: "2030-01-01T00:00:00Z",
            coverageLimit: 10000,
          },
        });
        const r = await invoke("SubmitClaim", {
          claim: {
            ...input,
            policyId: P2,
            customerId: C2,
            idempotencyKey: `cluster-${suffix}`,
            incidentDate: "2026-01-04T12:00:00Z",
          },
        });
        graphIds.push(r.claim.id);
        const summary = await invoke("RunAnalytics", {});
        assert.equal(summary.engine, "Node.js + MongoDB aggregation");
        assert.equal(summary.candidates, 3);
        assert.equal((await invoke("RunAnalytics", {})).candidates, 0);
        const lake = await invoke("ExportLake", {});
        exported = lake.file;
        const reader = await parquet.ParquetReader.openFile(
          path.join(root, exported),
        );
        let count = 0;
        try {
          const cursor = reader.getCursor();
          while (await cursor.next()) count++;
        } finally {
          await reader.close();
        }
        assert.equal(count, lake.count);
      },
    );
    await t.test(
      "SOAP faults for auth, oversized XML, DTD and removed REST paths",
      async () => {
        assert.equal(
          (
            await fetch(endpoint, {
              method: "POST",
              headers: { "Content-Type": "text/xml" },
              body: "<x/>",
            })
          ).status,
          401,
        );
        assert.equal(
          (
            await fetch(endpoint, {
              method: "POST",
              headers: { "Content-Type": "text/xml", "X-API-Key": "test-key" },
              body: "<!DOCTYPE x><x/>",
            })
          ).status,
          400,
        );
        assert.equal(
          (
            await fetch(endpoint, {
              method: "POST",
              headers: { "Content-Type": "text/xml", "X-API-Key": "test-key" },
              body: "x".repeat(1024 * 1024 + 1),
            })
          ).status,
          413,
        );
        assert.equal(
          (await fetch(endpoint.replace("/soap", "/api/claims"))).status,
          404,
        );
        const health = await invoke("GetHealth", {});
        assert.equal(health.status, "HEALTHY");
      },
    );
    await t.test(
      "An audit write failure rolls back the claim transaction",
      async () => {
        const before = await ctx.db.collection("claims").countDocuments();
        await ctx.db.command({
          collMod: "events",
          validator: { message: "must-never-match" },
          validationLevel: "strict",
        });
        try {
          await assert.rejects(
            invoke("SubmitClaim", {
              claim: {
                ...input,
                idempotencyKey: `rollback-${suffix}`,
                incidentDate: "2026-01-10T12:00:00Z",
              },
            }),
            /Operation failed/,
          );
          assert.equal(
            await ctx.db.collection("claims").countDocuments(),
            before,
          );
        } finally {
          await ctx.db.command({ collMod: "events", validator: {} });
        }
      },
    );
    await t.test(
      "SOAP partner XML and partial typed batches return per-record results",
      async () => {
        const xml = `<ClaimsBatch><ACORDClaim><TransactionId>xml-${suffix}</TransactionId><PolicyRef>${P}</PolicyRef><InsuredRef>${C}</InsuredRef><LossType>AUTO</LossType><LossDate>2026-02-01</LossDate><TotalLossAmount>1250</TotalLossAmount><LossNarrative>XML partner collision</LossNarrative><AutoDetails><Vin>${V}</Vin></AutoDetails></ACORDClaim></ClaimsBatch>`;
        const imported = await invoke("ImportClaimsXml", { xml });
        assert.equal(imported.accepted, 1);
        graphIds.push(imported.result[0].id);
        const batch = await invoke("ImportClaimsBatch", {
          claim: [
            {
              ...input,
              idempotencyKey: `batch-${suffix}`,
              incidentDate: "2026-02-02T12:00:00Z",
            },
            { ...input, idempotencyKey: `batch-invalid-${suffix}`, amount: -1 },
          ],
        });
        graphIds.push(batch.result[0].id);
        assert.equal(batch.submitted, 2);
        assert.equal(batch.accepted, 1);
        assert.equal(batch.result[1].accepted, false);
      },
    );
    await t.test(
      "Concurrent identical claims with different keys detect the duplicate",
      async () => {
        const results = await Promise.all(
          [1, 2].map((i) =>
            invoke("SubmitClaim", {
              claim: {
                ...input,
                idempotencyKey: `dup-${suffix}-${i}`,
                incidentDate: "2026-02-03T12:00:00Z",
              },
            }),
          ),
        );
        graphIds.push(...results.map((r) => r.claim.id));
        assert.equal(results.filter((r) => r.accepted).length, 1);
        assert.equal(
          results.filter((r) => r.claim.status === "INVALID").length,
          1,
        );
      },
    );
    await t.test(
      "Synthetic Node stream completes through the same service",
      async () => {
        const starts = await Promise.allSettled([
          invoke("StartStream", { count: 2, intervalMs: 100 }),
          invoke("StartStream", { count: 2, intervalMs: 100 }),
        ]);
        assert.equal(starts.filter((s) => s.status === "fulfilled").length, 1);
        const deadline = Date.now() + 15000;
        let stream;
        do {
          await new Promise((resolve) => setTimeout(resolve, 100));
          stream = await invoke("GetStreamStatus");
        } while (stream.status === "RUNNING" && Date.now() < deadline);
        assert.equal(stream.status, "COMPLETED");
        assert.equal(stream.generated, 2);
        const generated = await ctx.db
          .collection("claims")
          .find({ description: "Synthetic stream claim for pipeline testing." })
          .toArray();
        graphIds.push(...generated.map((c) => c.id));
      },
    );
    await t.test(
      "Legacy migration plans read-only, backs up and copies flat records",
      async () => {
        const sourceName = `claimnexus_legacy_test_${suffix}`,
          targetName = `claimnexus_migration_test_${suffix}`;
        const legacy = ctx.mongo.db(sourceName),
          migrated = ctx.mongo.db(targetName);
        const now = new Date().toISOString();
        let backup;
        try {
          await legacy
            .collection("customers")
            .insertOne({
              customer_id: C,
              full_name: "Legacy customer",
              email: "legacy@example.com",
              created_at: now,
            });
          await legacy
            .collection("policies")
            .insertOne({
              policy_id: P,
              customer_id: C,
              policy_type: "AUTO",
              status: "ACTIVE",
              start_date: "2020-01-01T00:00:00Z",
              end_date: "2030-01-01T00:00:00Z",
              coverage_limit: 10000,
              deductible: 100,
              covered_assets: [{ identifier: V }],
              created_at: now,
            });
          await legacy
            .collection("service_providers")
            .insertOne({
              provider_id: G,
              business_name: "Legacy garage",
              provider_type: "GARAGE",
              created_at: now,
            });
          await legacy.collection("claims").insertOne({
            claim_id: "LEGACY-TEST",
            policy_id: P,
            customer_id: C,
            claim_type: "AUTO",
            incident_date: "2026-01-01T00:00:00Z",
            reported_date: "2026-01-02T00:00:00Z",
            claimed_amount: 1000,
            currency: "USD",
            description: "Original nested legacy claim",
            status: "VALIDATING",
            claim_details: { auto: { vin: V, vehicle_make: "Honda" } },
            involved_entities: [
              { entity_id: G, entity_type: "GARAGE" },
              { entity_id: A, entity_type: "AGENT", name: "Legacy agent" },
            ],
            created_at: now,
            updated_at: now,
          });
          const env = {
            ...process.env,
            LEGACY_MONGODB_URI: process.env.MONGODB_URI,
            LEGACY_MONGODB_DB_NAME: sourceName,
            MONGODB_DB_NAME: targetName,
          };
          const run = promisify(execFile);
          const plan = await run(process.execPath, ["scripts/migrate.js"], {
            cwd: root,
            env,
          });
          assert.match(plan.stdout, /DRY_RUN/);
          assert.equal(await migrated.collection("claims").countDocuments(), 0);
          const applied = await run(
            process.execPath,
            ["scripts/migrate.js", "--apply"],
            { cwd: root, env },
          );
          backup = applied.stdout.match(/Backup: (.+)\. Start the server/)[1];
          const saved = await migrated
            .collection("claims")
            .findOne({ id: "LEGACY-TEST" });
          assert.equal(saved.assetId, V);
          assert.equal(saved.status, "UNDER_REVIEW");
          assert.equal(saved.graphSync, "PENDING");
          assert.equal(saved.claim_details, undefined);
          assert.equal(await legacy.collection("claims").countDocuments(), 1);
          const archived = JSON.parse(await readFile(backup, "utf8"));
          assert.equal(
            archived.claims[0].claim_details.auto.vehicle_make,
            "Honda",
          );
          await assert.rejects(
            run(process.execPath, ["scripts/migrate.js", "--apply"], {
              cwd: root,
              env,
            }),
            /Target claims collection must be empty/,
          );
        } finally {
          await legacy.dropDatabase();
          await migrated.dropDatabase();
          if (backup) await rm(backup, { force: true });
        }
      },
    );
  },
);
