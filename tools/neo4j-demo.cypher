// Run each statement separately in Neo4j Browser.
// Local Browser: http://127.0.0.1:7475
// Connect URI: bolt://127.0.0.1:7688. Use your configured Neo4j credentials.

// 1. Show the labels and count nodes for each model.
MATCH (n)
RETURN labels(n) AS model, count(*) AS records
ORDER BY model;

// 2. Show the node property sets and one sample per label.
MATCH (n)
WITH labels(n) AS model, collect(properties(n)) AS samples
RETURN model, keys(samples[0]) AS fields, samples[0] AS sample;

// 3. Show the relationships created by the Express bridge.
MATCH (a)-[r]->(b)
RETURN labels(a) AS sourceModel, type(r) AS relationship,
       labels(b) AS targetModel, count(*) AS links
ORDER BY relationship;

// 4. Show AUTO claims imported from the original partner XML.
// This is a table of the stored data, not an authored visualization.
MATCH (c:Claim)-[:UNDER_POLICY]->(p:Policy)
WHERE p.id IN ['POL-8101-TX', 'POL-8102-TX']
RETURN c.id AS claimId, p.id AS policyId, c.type AS claimType,
       c.amount AS amount, c.currency AS currency, c.status AS status,
       c.incidentDate AS incidentDate, c.version AS version;

// 5. Show all links attached to those XML claims as a table.
MATCH (c:Claim)-[r]-(entity)
WHERE EXISTS {
  MATCH (c)-[:UNDER_POLICY]->(p:Policy)
  WHERE p.id IN ['POL-8101-TX', 'POL-8102-TX']
}
RETURN c.id AS claimId, type(r) AS relationship,
       labels(entity) AS entityModel, entity.id AS entityId,
       entity.name AS entityName
ORDER BY claimId, relationship;

// 6. Prove that two different claims share a garage and agent.
MATCH (first:Claim)-[:SERVICED_BY]->(garage:Provider)<-[:SERVICED_BY]-(second:Claim)
MATCH (first)-[:HANDLED_BY]->(agent:Agent)<-[:HANDLED_BY]-(second)
WHERE first.id < second.id AND garage.id = 'GARAGE-CENTRAL-01'
RETURN first.id AS firstClaim, second.id AS secondClaim,
       garage.id AS sharedGarage, agent.id AS sharedAgent;

// 7. Show the HEALTH claim relationships and common projected properties.
MATCH (c:Claim)-[:UNDER_POLICY]->(p:Policy {id:'POL-HEALTH-301'})
OPTIONAL MATCH (c)-[:SERVICED_BY]->(hospital:Provider)
RETURN c.id AS claimId, c.amount AS amount, c.status AS status,
       hospital.id AS hospitalId, hospital.type AS providerType;

// Descriptions, diagnosis/procedure codes, audit history and coverage limits
// are not copied into Neo4j by this bridge. Inspect them in MongoDB Compass.
