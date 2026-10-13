// Run in mongosh or the embedded MongoDB Compass shell.
// Connect: mongodb://127.0.0.1:27018/?replicaSet=rs0&directConnection=true
const demoDb = db.getSiblingDB("claimnexus_express");

// List collections and inspect the actual documents for each model.
printjson(demoDb.getCollectionNames());
for (const name of ["customers", "policies", "providers", "claims", "events"]) {
  print(name);
  printjson(demoDb.getCollection(name).findOne({}, { _id: 0, fingerprint: 0 }));
}

// The transaction IDs from the original XML become idempotency keys.
printjson(
  demoDb.claims
    .find(
      {
        idempotencyKey: {
          $in: ["XML-TX-AUTO-1001", "XML-TX-AUTO-1002", "XML-TX-HEALTH-2001"],
        },
      },
      { _id: 0, fingerprint: 0 },
    )
    .toArray(),
);

// Find one imported claim and its audit history by the same stable business ID.
const xmlClaim = demoDb.claims.findOne({ idempotencyKey: "XML-TX-AUTO-1001" });
if (xmlClaim) {
  print("Copy this claim ID into Neo4j Browser or Postman: " + xmlClaim.id);
  printjson(
    demoDb.events.find({ claimId: xmlClaim.id }).sort({ at: 1 }).toArray(),
  );
}

// Show failed or pending projections without changing their records.
printjson(
  demoDb.claims
    .find(
      { graphSync: { $in: ["PENDING", "FAILED", "NOT_CONFIGURED"] } },
      { _id: 0, id: 1, graphSync: 1, version: 1 },
    )
    .toArray(),
);
