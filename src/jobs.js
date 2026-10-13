import { randomUUID } from "node:crypto";
import { mkdir, readdir, stat } from "node:fs/promises";
import path from "node:path";
import parquet from "parquetjs-lite";
import { DomainError } from "./domain.js";
import { transaction } from "./db.js";

const lakeSchema = new parquet.ParquetSchema({
  id: { type: "UTF8" },
  policyId: { type: "UTF8" },
  customerId: { type: "UTF8" },
  type: { type: "UTF8" },
  status: { type: "UTF8" },
  amount: { type: "DOUBLE" },
  currency: { type: "UTF8" },
  incidentDate: { type: "UTF8" },
  providerId: { type: "UTF8", optional: true },
  agentId: { type: "UTF8", optional: true },
  assetId: { type: "UTF8", optional: true },
});
export class Jobs {
  constructor(service, root) {
    this.service = service;
    this.root = root;
    this.stream = { status: "IDLE", generated: 0, valid: 0, invalid: 0 };
    this.timer = null;
    this.stopping = false;
    this.activeTick = Promise.resolve();
  }
  async importBatch(inputs) {
    if (!Array.isArray(inputs) || !inputs.length || inputs.length > 100)
      throw new DomainError("Supply 1 to 100 claims");
    const results = [];
    for (let i = 0; i < inputs.length; i++) {
      try {
        const result = await this.service.submit(inputs[i]);
        results.push({
          index: i,
          id: result.claim.id,
          accepted: result.accepted,
          message:
            result.claim.validationErrors.join("; ") ||
            (result.replayed ? "Idempotent replay" : "Accepted"),
        });
      } catch (error) {
        if (!(error instanceof DomainError)) throw error;
        results.push({ index: i, accepted: false, message: error.message });
      }
    }
    return {
      result: results,
      submitted: inputs.length,
      accepted: results.filter((r) => r.accepted).length,
    };
  }
  async startStream(args) {
    if (this.stream.status === "RUNNING" || this.streamStarting)
      throw new DomainError("A stream is already running");
    const count = Number(args.count || 20),
      intervalMs = Number(args.intervalMs ?? 500);
    if (
      !Number.isInteger(count) ||
      count < 1 ||
      count > 1000 ||
      !Number.isInteger(intervalMs) ||
      intervalMs < 100 ||
      intervalMs > 60000
    )
      throw new DomainError(
        "Count must be 1–1000; intervalMs must be 100–60000",
      );
    this.streamStarting = true;
    try {
      const policies = await this.service.db
        .collection("policies")
        .find({ status: "ACTIVE", type: "AUTO" })
        .limit(100)
        .toArray();
      if (!policies.length)
        throw new DomainError(
          "Add active AUTO policies or seed demo records first",
        );
      const provider = await this.service.db
        .collection("providers")
        .findOne({ type: "GARAGE" });
      const agent = await this.service.db
        .collection("providers")
        .findOne({ type: "AGENT" });
      this.stopping = false;
      this.stream = { status: "RUNNING", generated: 0, valid: 0, invalid: 0 };
      const tick = async () => {
        if (this.stopping) return;
        try {
          const policy = policies[this.stream.generated % policies.length];
          const input = {
            policyId: policy.id,
            customerId: policy.customerId,
            type: "AUTO",
            incidentDate: new Date(
              Date.now() - 3600000 - this.stream.generated * 1000,
            ).toISOString(),
            amount:
              Math.round(
                Math.min(policy.coverageLimit, 800 + Math.random() * 6000) *
                  100,
              ) / 100,
            currency: policy.currency,
            description: "Synthetic stream claim for pipeline testing.",
            ...(policy.assetId ? { assetId: policy.assetId } : {}),
            ...(provider ? { providerId: provider.id } : {}),
            ...(agent ? { agentId: agent.id } : {}),
          };
          const result = await this.service.submit(input);
          this.stream.generated++;
          this.stream[result.accepted ? "valid" : "invalid"]++;
          this.stream.updatedAt = new Date().toISOString();
          if (this.stopping) return;
          if (this.stream.generated < count)
            this.timer = setTimeout(() => {
              this.activeTick = tick();
            }, intervalMs);
          else this.stream.status = "COMPLETED";
        } catch (error) {
          console.error("Stream failed:", error);
          this.stream.status = "FAILED";
        }
      };
      this.timer = setTimeout(() => {
        this.activeTick = tick();
      }, intervalMs);
      return { ...this.stream };
    } finally {
      this.streamStarting = false;
    }
  }
  async stop() {
    this.stopping = true;
    clearTimeout(this.timer);
    await this.activeTick;
    if (this.stream.status === "RUNNING") this.stream.status = "STOPPED";
  }
  async exportLake() {
    const directory = path.join(this.root, "datalake", "snapshots");
    await mkdir(directory, { recursive: true });
    const filename = `claims-${Date.now()}-${randomUUID().slice(0, 8)}.parquet`;
    const writer = await parquet.ParquetWriter.openFile(
      lakeSchema,
      path.join(directory, filename),
    );
    let count = 0;
    try {
      for await (const claim of this.service.db.collection("claims").find({})) {
        await writer.appendRow(
          Object.fromEntries(
            Object.keys(lakeSchema.fields).map((k) => [k, claim[k]]),
          ),
        );
        count++;
      }
    } finally {
      await writer.close();
    }
    return { file: `datalake/snapshots/${filename}`, count };
  }
  async lakeInfo() {
    const directory = path.join(this.root, "datalake", "snapshots");
    let files;
    try {
      files = (await readdir(directory)).filter((f) => f.endsWith(".parquet"));
    } catch (error) {
      if (error.code === "ENOENT") return { files: 0, bytes: 0 };
      throw error;
    }
    let bytes = 0;
    for (const file of files)
      bytes += (await stat(path.join(directory, file))).size;
    return { files: files.length, bytes };
  }
  async analytics() {
    if (this.analyticsRunning)
      throw new DomainError("Analytics is already running");
    this.analyticsRunning = true;
    try {
      // Node aggregation deliberately replaces PySpark. No distributed-engine claims.
      const eligible = [
        "READY_FOR_ANALYSIS",
        "UNDER_REVIEW",
        "INVESTIGATION_CANDIDATE",
      ];
      const clusters = await this.service.db
        .collection("claims")
        .aggregate([
          {
            $match: {
              status: { $in: eligible },
              providerId: { $exists: true },
              agentId: { $exists: true },
            },
          },
          {
            $group: {
              _id: { providerId: "$providerId", agentId: "$agentId" },
              ids: { $push: "$id" },
              customers: { $addToSet: "$customerId" },
              count: { $sum: 1 },
            },
          },
          { $match: { count: { $gte: 3 }, "customers.1": { $exists: true } } },
        ])
        .toArray();
      const ids = new Set(clusters.flatMap((c) => c.ids));
      let candidates = 0;
      for (const id of ids) {
        const changed = await transaction(this.service.ctx, async (session) => {
          const claim = await this.service.db
            .collection("claims")
            .findOne({ id }, { session });
          if (!claim || !eligible.includes(claim.status)) return false;
          if (claim.riskIndicators?.includes("SHARED_PROVIDER_AGENT_CLUSTER"))
            return false;
          const at = new Date().toISOString();
          await this.service.db.collection("claims").updateOne(
            { id },
            {
              $set: {
                status: "INVESTIGATION_CANDIDATE",
                updatedAt: at,
                graphSync: "PENDING",
              },
              $addToSet: { riskIndicators: "SHARED_PROVIDER_AGENT_CLUSTER" },
              $inc: { version: 1 },
            },
            { session },
          );
          await this.service.db
            .collection("events")
            .insertOne(
              {
                id: randomUUID(),
                claimId: id,
                type: "INVESTIGATION_FLAGGED",
                fromStatus: claim.status,
                toStatus: "INVESTIGATION_CANDIDATE",
                at,
                message:
                  "At least 3 claims from at least 2 customers share a provider and agent. Review indicator only.",
              },
              { session },
            );
          return true;
        });
        if (changed) {
          candidates++;
          await this.service.bridge.sync(id);
        }
      }
      const summary = {
        engine: "Node.js + MongoDB aggregation",
        at: new Date().toISOString(),
        processed: await this.service.db
          .collection("claims")
          .countDocuments({ status: { $in: eligible } }),
        candidates,
        cluster: clusters.map((c) => ({
          providerId: c._id.providerId,
          agentId: c._id.agentId,
          count: c.count,
        })),
      };
      await this.service.db
        .collection("analytics")
        .replaceOne(
          { id: "latest" },
          { id: "latest", ...summary },
          { upsert: true },
        );
      return summary;
    } finally {
      this.analyticsRunning = false;
    }
  }
  async analyticsSummary() {
    const { _id, id, ...data } = (await this.service.db
      .collection("analytics")
      .findOne({ id: "latest" })) || {
      engine: "Node.js + MongoDB aggregation",
      processed: 0,
      candidates: 0,
      cluster: [],
    };
    return data;
  }
}
