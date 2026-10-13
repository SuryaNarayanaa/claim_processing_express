import test from "node:test";
import assert from "node:assert/strict";
import { claimSchema, policySchema, parse } from "../src/domain.js";
import { parseClaimsXml } from "../src/xml.js";
import { readFile } from "node:fs/promises";
const claim = {
  policyId: "P",
  customerId: "C",
  type: "PROPERTY",
  incidentDate: "2026-01-01T10:00:00+05:30",
  amount: "250",
  description: "Storm damage to roof.",
};
test("Flat claims need no nested type-specific object and normalize dates", () => {
  const result = parse(claimSchema, claim);
  assert.equal(result.amount, 250);
  assert.equal(result.incidentDate, "2026-01-01T04:30:00.000Z");
  assert.equal(result.currency, "USD");
});
test("Reject malformed dates, amounts, type and injected Mongo objects", () => {
  for (const patch of [
    { incidentDate: "not a date" },
    { amount: -1 },
    { amount: Infinity },
    { type: "OTHER" },
    { policyId: { $ne: null } },
    { unexpected: true },
  ])
    assert.throws(() => parse(claimSchema, { ...claim, ...patch }));
});
test("Reject inverted policy dates", () => {
  assert.throws(() =>
    parse(policySchema, {
      id: "P",
      customerId: "C",
      type: "AUTO",
      startDate: "2026-02-01T00:00:00Z",
      endDate: "2026-01-01T00:00:00Z",
      coverageLimit: 1000,
    }),
  );
});
test("Read both original partner XML feeds without inventing medical or vehicle data", async () => {
  const auto = parseClaimsXml(
    await readFile(
      new URL("../data/xml_claims/partner_auto_batch.xml", import.meta.url),
      "utf8",
    ),
  );
  const health = parseClaimsXml(
    await readFile(
      new URL("../data/xml_claims/hospital_billing_feed.xml", import.meta.url),
      "utf8",
    ),
  );
  assert.equal(auto.length, 2);
  assert.equal(auto[0].assetId, "1FTFW1ED4MFA19283");
  assert.equal(health[0].type, "HEALTH");
  assert.equal(health[0].diagnosisCodes, "S13.4XXA, M54.2");
});
test("Reject malformed and entity-bearing XML; preserve PROPERTY", () => {
  assert.throws(() => parseClaimsXml("<Claim>"));
  assert.throws(() =>
    parseClaimsXml(
      '<!DOCTYPE Claim [<!ENTITY x SYSTEM "file:///etc/passwd">]><Claim>&x;</Claim>',
    ),
  );
  const [property] = parseClaimsXml(
    "<Claim><PolicyId>P</PolicyId><CustomerId>C</CustomerId><ClaimType>PROPERTY</ClaimType><IncidentDate>2026-01-01</IncidentDate><Amount>50</Amount><Description>Roof damage</Description></Claim>",
  );
  assert.equal(property.type, "PROPERTY");
  assert.equal(property.assetId, undefined);
});
