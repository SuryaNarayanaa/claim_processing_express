import { randomUUID, createHash } from "node:crypto";
import {
  claimSchema,
  customerSchema,
  policySchema,
  providerSchema,
  parse,
  requireId,
  limitValue,
  statuses,
  types,
  transitions,
  DomainError,
} from "./domain.js";
import { transaction } from "./db.js";

const clean = (doc) => {
  if (!doc) return doc;
  const { _id, fingerprint, graphError, ...value } = doc;
  return value;
};
export class ClaimService {
  constructor(ctx, bridge) {
    this.ctx = ctx;
    this.db = ctx.db;
    this.bridge = bridge;
  }
  async createMaster(collection, raw) {
    const schema = {
      customers: customerSchema,
      policies: policySchema,
      providers: providerSchema,
    }[collection];
    const value = parse(schema, raw);
    if (
      collection === "policies" &&
      !(await this.db.collection("customers").findOne({ id: value.customerId }))
    )
      throw new DomainError("Customer not found");
    try {
      await this.db
        .collection(collection)
        .insertOne({ ...value, createdAt: new Date().toISOString() });
    } catch (error) {
      if (error.code === 11000)
        throw new DomainError(`${collection} ID already exists`);
      throw error;
    }
    return { record: value };
  }
  async listMaster(collection) {
    return this.db
      .collection(collection)
      .find({}, { projection: { _id: 0 } })
      .sort({ id: 1 })
      .limit(500)
      .toArray();
  }
  async submit(raw) {
    const input = parse(claimSchema, raw);
    const fingerprint = createHash("sha256")
      .update(
        JSON.stringify(
          Object.fromEntries(
            Object.entries(input).sort(([a], [b]) => a.localeCompare(b)),
          ),
        ),
      )
      .digest("hex");
    const checkExisting = async () => {
      if (!input.idempotencyKey) return null;
      const existing = await this.db
        .collection("claims")
        .findOne({ idempotencyKey: input.idempotencyKey });
      if (existing && existing.fingerprint !== fingerprint)
        throw new DomainError(
          "Idempotency key was already used for a different request",
        );
      return existing;
    };
    const previous = await checkExisting();
    if (previous)
      return {
        claim: clean(previous),
        accepted: previous.status !== "INVALID",
        replayed: true,
      };
    const now = new Date().toISOString();
    const reportedDate = input.reportedDate || now;
    let saved;
    try {
      saved = await transaction(this.ctx, async (session) => {
        const opts = { session };
        const policy = await this.db
          .collection("policies")
          .findOne({ id: input.policyId }, opts);
        const customer = await this.db
          .collection("customers")
          .findOne({ id: input.customerId }, opts);
        const errors = [];
        if (!customer) errors.push("Customer not found");
        if (!policy) errors.push("Policy not found");
        if (input.incidentDate > reportedDate)
          errors.push("Incident date follows reported date");
        if (Date.parse(input.incidentDate) > Date.now() + 300000)
          errors.push("Incident date is in the future");
        if (Date.parse(reportedDate) > Date.now() + 300000)
          errors.push("Reported date is in the future");
        if (policy) {
          if (policy.customerId !== input.customerId)
            errors.push("Customer does not hold this policy");
          if (policy.type !== input.type)
            errors.push("Claim type does not match policy type");
          if (policy.status !== "ACTIVE") errors.push("Policy is not active");
          if (
            input.incidentDate < policy.startDate ||
            input.incidentDate > policy.endDate
          )
            errors.push("Incident is outside policy coverage dates");
          if (input.amount > policy.coverageLimit)
            errors.push("Amount exceeds policy coverage limit");
          if (input.currency !== policy.currency)
            errors.push("Currency does not match policy currency");
          if (
            policy.assetId &&
            (!input.assetId ||
              policy.assetId.toUpperCase() !== input.assetId.toUpperCase())
          )
            errors.push("Asset does not match policy");
          // Updating one policy serializes concurrent submissions for the same policy.
          await this.db
            .collection("policies")
            .updateOne(
              { id: policy.id },
              { $inc: { submissionVersion: 1 } },
              opts,
            );
        }
        if (input.providerId) {
          const provider = await this.db
            .collection("providers")
            .findOne({ id: input.providerId }, opts);
          const allowed = {
            AUTO: ["GARAGE"],
            HEALTH: ["HOSPITAL"],
            PROPERTY: ["CONTRACTOR", "INSPECTOR"],
          };
          if (!provider || !allowed[input.type].includes(provider.type))
            errors.push("Provider is missing or does not match the claim type");
        }
        if (
          input.agentId &&
          !(await this.db
            .collection("providers")
            .findOne({ id: input.agentId, type: "AGENT" }, opts))
        )
          errors.push("Agent not found");
        const duplicate = await this.db
          .collection("claims")
          .findOne(
            {
              policyId: input.policyId,
              incidentDate: input.incidentDate,
              amount: input.amount,
              status: { $ne: "INVALID" },
            },
            opts,
          );
        if (duplicate) errors.push(`Duplicate of ${duplicate.id}`);
        const claim = {
          ...input,
          id: `CLM-${randomUUID()}`,
          reportedDate,
          status: errors.length ? "INVALID" : "READY_FOR_ANALYSIS",
          validationErrors: errors,
          riskIndicators: [],
          graphSync: "PENDING",
          version: 1,
          fingerprint,
          createdAt: now,
          updatedAt: now,
        };
        await this.db.collection("claims").insertOne({ ...claim }, opts);
        await this.db.collection("events").insertMany(
          [
            {
              id: randomUUID(),
              claimId: claim.id,
              type: "CLAIM_RECEIVED",
              toStatus: "RECEIVED",
              at: now,
              message: "Claim submitted through SOAP",
            },
            {
              id: randomUUID(),
              claimId: claim.id,
              type: errors.length
                ? "VALIDATION_FAILED"
                : "VALIDATION_SUCCEEDED",
              fromStatus: "RECEIVED",
              toStatus: claim.status,
              at: now,
              message:
                errors.join("; ") ||
                "Policy, dates, amount and references verified",
            },
          ],
          opts,
        );
        return claim;
      });
    } catch (error) {
      if (error.code === 11000 && input.idempotencyKey) {
        const existing = await checkExisting();
        if (existing)
          return {
            claim: clean(existing),
            accepted: existing.status !== "INVALID",
            replayed: true,
          };
      }
      throw error;
    }
    await this.bridge.sync(saved.id);
    return {
      claim: clean(
        await this.db.collection("claims").findOne({ id: saved.id }),
      ),
      accepted: saved.status !== "INVALID",
      replayed: false,
    };
  }
  async get(id) {
    id = requireId(id);
    const claim = await this.db.collection("claims").findOne({ id });
    if (!claim) throw new DomainError("Claim not found");
    const events = await this.db
      .collection("events")
      .find({ claimId: id }, { projection: { _id: 0 } })
      .sort({ at: 1, _id: 1 })
      .toArray();
    return { claim: clean(claim), event: events };
  }
  async list(filter = {}) {
    const query = {};
    if (filter.status && filter.status !== "ALL") {
      if (!statuses.includes(filter.status))
        throw new DomainError("Unknown status");
      query.status = filter.status;
    }
    if (filter.type && filter.type !== "ALL") {
      if (!types.includes(filter.type))
        throw new DomainError("Unknown claim type");
      query.type = filter.type;
    }
    const limit = limitValue(filter.limit);
    const offset = Number(filter.offset || 0);
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > 1000000)
      throw new DomainError("Offset must be an integer between 0 and 1000000");
    return {
      claim: (
        await this.db
          .collection("claims")
          .find(query)
          .sort({ createdAt: -1, id: 1 })
          .skip(offset)
          .limit(limit)
          .toArray()
      ).map(clean),
      total: await this.db.collection("claims").countDocuments(query),
    };
  }
  async summary() {
    const groups = await this.db
      .collection("claims")
      .aggregate([{ $group: { _id: "$status", count: { $sum: 1 } } }])
      .toArray();
    return {
      total: groups.reduce((sum, g) => sum + g.count, 0),
      status: groups.map((g) => ({ name: g._id, count: g.count })),
    };
  }
  async transition(id, status, message = "Status updated through SOAP") {
    id = requireId(id);
    await transaction(this.ctx, async (session) => {
      const claim = await this.db
        .collection("claims")
        .findOne({ id }, { session });
      if (!claim) throw new DomainError("Claim not found");
      if (!(transitions[claim.status] || []).includes(status))
        throw new DomainError(`Cannot move ${claim.status} to ${status}`);
      const now = new Date().toISOString();
      await this.db
        .collection("claims")
        .updateOne(
          { id, version: claim.version },
          {
            $set: { status, updatedAt: now, graphSync: "PENDING" },
            $inc: { version: 1 },
          },
          { session },
        );
      await this.db
        .collection("events")
        .insertOne(
          {
            id: randomUUID(),
            claimId: id,
            type: "LIFECYCLE_TRANSITION",
            fromStatus: claim.status,
            toStatus: status,
            at: now,
            message: String(message).slice(0, 2000),
          },
          { session },
        );
    });
    await this.bridge.sync(id);
    return this.get(id);
  }
  async health() {
    let mongodb = "CONNECTED",
      neo4j = this.ctx.graph ? "DISCONNECTED" : "NOT_CONFIGURED";
    try {
      await this.db.command({ ping: 1 });
    } catch {
      mongodb = "DISCONNECTED";
    }
    try {
      if (this.ctx.graph) {
        await this.ctx.graph.verifyConnectivity();
        neo4j = "CONNECTED";
      }
    } catch {
      /* returned as degraded */
    }
    return {
      mongodb,
      neo4j,
      status:
        mongodb === "CONNECTED" && neo4j === "CONNECTED"
          ? "HEALTHY"
          : "DEGRADED",
    };
  }
}
