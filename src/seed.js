export async function seedDemo(service) {
  const db = service.db;
  const masters = {
    customers: [
      { id: "CUST-1001", name: "Elena Rostova", email: "elena@example.com" },
      { id: "CUST-1002", name: "Marcus Vance", email: "marcus@example.com" },
      { id: "CUST-HLTH-88", name: "Health policyholder" },
      { id: "CUST-XML-01", name: "Partner policyholder 1" },
      { id: "CUST-XML-02", name: "Partner policyholder 2" },
    ],
    providers: [
      { id: "GAR-77401", name: "Apex Auto Collision", type: "GARAGE" },
      { id: "AGT-3029", name: "David Miller Agency", type: "AGENT" },
      {
        id: "HOSP-STDAVIDS-01",
        name: "St. David's Medical Center",
        type: "HOSPITAL",
      },
      {
        id: "AGENT-AUSTIN-LIFE",
        name: "Austin Life and Health Brokers",
        type: "AGENT",
      },
      {
        id: "GARAGE-CENTRAL-01",
        name: "Central Metro Collision",
        type: "GARAGE",
      },
      { id: "AGENT-LONE-STAR", name: "Lone Star Underwriters", type: "AGENT" },
    ],
    policies: [
      {
        id: "POL-AUTO-88219",
        customerId: "CUST-1001",
        type: "AUTO",
        assetId: "1HGCR2F83HA019284",
      },
      {
        id: "POL-AUTO-99304",
        customerId: "CUST-1002",
        type: "AUTO",
        assetId: "4T1B11HK5JU109482",
      },
      { id: "POL-HEALTH-301", customerId: "CUST-HLTH-88", type: "HEALTH" },
      {
        id: "POL-8101-TX",
        customerId: "CUST-XML-01",
        type: "AUTO",
        assetId: "1FTFW1ED4MFA19283",
      },
      {
        id: "POL-8102-TX",
        customerId: "CUST-XML-02",
        type: "AUTO",
        assetId: "4T1B11HK5JU819203",
      },
    ].map((p) => ({
      ...p,
      status: "ACTIVE",
      startDate: `${new Date().getUTCFullYear() - 1}-01-01T00:00:00.000Z`,
      endDate: `${new Date().getUTCFullYear() + 1}-12-31T23:59:59.000Z`,
      coverageLimit: 50000,
      deductible: 500,
      currency: "USD",
    })),
  };
  for (const [collection, records] of Object.entries(masters)) {
    for (const record of records)
      await db
        .collection(collection)
        .updateOne(
          { id: record.id },
          { $setOnInsert: { ...record, createdAt: new Date().toISOString() } },
          { upsert: true },
        );
  }
  for (let i = 0; i < 2; i++) {
    const policy = masters.policies[i];
    await service.submit({
      policyId: policy.id,
      customerId: policy.customerId,
      type: "AUTO",
      assetId: policy.assetId,
      amount: 6850 + i * 350,
      currency: "USD",
      incidentDate: `${new Date().getUTCFullYear()}-01-0${i + 2}T12:00:00.000Z`,
      description: "Demo collision claim. Synthetic data for local testing.",
      providerId: "GAR-77401",
      agentId: "AGT-3029",
      idempotencyKey: `demo-${i}`,
    });
  }
  return {
    message: "Demo master records added. Existing records preserved.",
    claims: await db.collection("claims").countDocuments(),
  };
}
