import { MongoClient } from "mongodb";
import neo4j from "neo4j-driver";

export async function connectDatabases(env = process.env) {
  const mongo = new MongoClient(
    env.MONGODB_URI ||
      "mongodb://127.0.0.1:27018/?replicaSet=rs0&directConnection=true",
    { serverSelectionTimeoutMS: 8000 },
  );
  let graph;
  try {
    await mongo.connect();
    const db = mongo.db(env.MONGODB_DB_NAME || "claimnexus_express");
    const hello = await db.admin().command({ hello: 1 });
    if (!hello.setName && hello.msg !== "isdbgrid")
      throw new Error(
        "MongoDB requires a replica set for atomic claims and audit history. Use docker compose up -d.",
      );
    for (const name of ["claims", "customers", "policies", "providers"])
      await db.collection(name).createIndex({ id: 1 }, { unique: true });
    await db
      .collection("claims")
      .createIndex(
        { idempotencyKey: 1 },
        {
          unique: true,
          partialFilterExpression: { idempotencyKey: { $type: "string" } },
        },
      );
    await db
      .collection("claims")
      .createIndex({ policyId: 1, incidentDate: 1, amount: 1 });
    await db.collection("claims").createIndex({ status: 1, createdAt: -1 });
    await db.collection("claims").createIndex({ graphSync: 1 });
    await db.collection("events").createIndex({ id: 1 }, { unique: true });
    await db.collection("events").createIndex({ claimId: 1, at: 1 });
    await db.collection("policies").createIndex({ customerId: 1 });
    if (env.NEO4J_URI && env.NEO4J_PASSWORD)
      graph = neo4j.driver(
        env.NEO4J_URI,
        neo4j.auth.basic(env.NEO4J_USERNAME || "neo4j", env.NEO4J_PASSWORD),
        { connectionTimeout: 5000, maxTransactionRetryTime: 5000 },
      );
    return {
      mongo,
      db,
      graph,
      graphDatabase: env.NEO4J_DATABASE || "neo4j",
      close: async () => {
        await graph?.close();
        await mongo.close();
      },
    };
  } catch (error) {
    await graph?.close();
    await mongo.close();
    throw error;
  }
}

export async function transaction(ctx, work) {
  const session = ctx.mongo.startSession();
  try {
    return await session.withTransaction(() => work(session));
  } finally {
    await session.endSession();
  }
}
