import { DomainError } from "./domain.js";

// Relationships are a projection. MongoDB remains the source of truth.
export class GraphBridge {
  constructor(ctx) {
    this.ctx = ctx;
    this.tail = Promise.resolve();
    this.constraintsReady = false;
  }
  sync(id) {
    const task = this.tail.then(() => this.project(id));
    this.tail = task.catch(() => {});
    return task;
  }
  async project(id) {
    const { db, graph, graphDatabase } = this.ctx;
    const claims = db.collection("claims");
    const claim = await claims.findOne({ id });
    if (!claim) throw new DomainError("Claim not found");
    if (!graph) {
      await claims.updateOne(
        { id, version: claim.version },
        { $set: { graphSync: "NOT_CONFIGURED" } },
      );
      return "NOT_CONFIGURED";
    }
    const session = graph.session({ database: graphDatabase });
    try {
      if (!this.constraintsReady) {
        for (const label of [
          "Claim",
          "Customer",
          "Policy",
          "Provider",
          "Agent",
          "Asset",
        ]) {
          await session.run(
            `CREATE CONSTRAINT ${label.toLowerCase()}_id IF NOT EXISTS FOR (n:${label}) REQUIRE n.id IS UNIQUE`,
          );
        }
        this.constraintsReady = true;
      }
      await session.executeWrite(async (tx) => {
        await tx.run(
          `
          MERGE (cl:Claim {id:$id})
          WITH cl WHERE coalesce(cl.version, 0) <= $version
          SET cl.type=$type, cl.amount=$amount, cl.currency=$currency,
              cl.status=$status, cl.incidentDate=$incidentDate, cl.version=$version
          MERGE (c:Customer {id:$customerId}) MERGE (p:Policy {id:$policyId})
          MERGE (c)-[:HOLDS]->(p) MERGE (c)-[:FILED]->(cl) MERGE (cl)-[:UNDER_POLICY]->(p)
          WITH cl
          OPTIONAL MATCH (cl)-[r:SERVICED_BY|HANDLED_BY|INVOLVES]->()
          DELETE r`,
          {
            id: claim.id,
            version: claim.version,
            type: claim.type,
            amount: claim.amount,
            currency: claim.currency,
            status: claim.status,
            incidentDate: claim.incidentDate,
            customerId: claim.customerId,
            policyId: claim.policyId,
          },
        );
        for (const [field, label, relation] of [
          ["providerId", "Provider", "SERVICED_BY"],
          ["agentId", "Agent", "HANDLED_BY"],
          ["assetId", "Asset", "INVOLVES"],
        ]) {
          if (!claim[field]) continue;
          const master =
            label === "Provider" || label === "Agent"
              ? await db.collection("providers").findOne({ id: claim[field] })
              : null;
          await tx.run(
            `MATCH (cl:Claim {id:$id}) WHERE cl.version=$version
            MERGE (n:${label} {id:$entityId}) SET n.name=$name, n.type=$type
            MERGE (cl)-[:${relation}]->(n)`,
            {
              id: claim.id,
              version: claim.version,
              entityId: claim[field],
              name: master?.name || claim[field],
              type: master?.type || label.toUpperCase(),
            },
          );
        }
      });
      await claims.updateOne(
        { id, version: claim.version },
        { $set: { graphSync: "SYNCED" }, $unset: { graphError: "" } },
      );
      return "SYNCED";
    } catch (error) {
      console.error("Graph projection failed:", error.message);
      await claims.updateOne(
        { id, version: claim.version },
        {
          $set: {
            graphSync: "FAILED",
            graphError: "Neo4j projection failed; automatic retry scheduled.",
          },
        },
      );
      return "FAILED";
    } finally {
      await session.close();
    }
  }
  async retry(limit = 100) {
    const pending = await this.ctx.db
      .collection("claims")
      .find({ graphSync: { $in: ["PENDING", "FAILED", "NOT_CONFIGURED"] } })
      .sort({ createdAt: 1 })
      .limit(limit)
      .toArray();
    let synced = 0;
    for (const claim of pending)
      if ((await this.sync(claim.id)) === "SYNCED") synced++;
    return { attempted: pending.length, synced };
  }
  async related(id) {
    if (!this.ctx.graph)
      throw new DomainError("Neo4j is not configured", "Server");
    const claim = await this.ctx.db.collection("claims").findOne({ id });
    if (!claim) throw new DomainError("Claim not found");
    if (claim.graphSync !== "SYNCED")
      throw new DomainError(
        "Claim graph is pending. Retry synchronization before querying relationships.",
        "Server",
      );
    const session = this.ctx.graph.session({
      database: this.ctx.graphDatabase,
    });
    try {
      const result = await session.executeRead((tx) =>
        tx.run(
          `
        MATCH (cl:Claim {id:$id})-[:SERVICED_BY|HANDLED_BY|INVOLVES]->(shared)<-[:SERVICED_BY|HANDLED_BY|INVOLVES]-(other:Claim)
        WHERE other.id <> cl.id
        RETURN other.id AS claimId, collect(DISTINCT shared.id) AS sharedEntities
        ORDER BY claimId LIMIT 100`,
          { id },
        ),
      );
      const rows = [];
      for (const record of result.records) {
        const other = await this.ctx.db
          .collection("claims")
          .findOne(
            { id: record.get("claimId"), graphSync: "SYNCED" },
            { projection: { _id: 0 } },
          );
        if (other)
          rows.push({
            claimId: other.id,
            status: other.status,
            amount: other.amount,
            sharedEntity: record.get("sharedEntities"),
          });
      }
      return { related: rows };
    } finally {
      await session.close();
    }
  }
}
