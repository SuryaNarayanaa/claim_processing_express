import { XMLParser, XMLValidator } from "fast-xml-parser";
import { DomainError } from "./domain.js";

const array = (v) => (v === undefined ? [] : Array.isArray(v) ? v : [v]);
function normalizedDate(value) {
  if (!value) return undefined;
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T12:00:00Z` : value;
}
export function parseClaimsXml(xml) {
  if (typeof xml !== "string" || !xml.trim())
    throw new DomainError("XML content is required");
  if (Buffer.byteLength(xml) > 1024 * 1024)
    throw new DomainError("XML exceeds 1 MiB");
  if (/<!DOCTYPE|<!ENTITY/i.test(xml))
    throw new DomainError("DTD and entity declarations are forbidden");
  if (XMLValidator.validate(xml) !== true)
    throw new DomainError("Malformed XML");
  const parsed = new XMLParser({
    ignoreAttributes: true,
    parseTagValue: false,
    trimValues: true,
    removeNSPrefix: true,
  }).parse(xml);
  const root = parsed.ClaimsBatch || parsed;
  const claims = [
    ...array(root.ACORDClaim),
    ...array(root.InsuranceClaim),
    ...array(root.Claim),
  ];
  if (!claims.length || claims.length > 100)
    throw new DomainError(
      "Expected 1 to 100 Claim, ACORDClaim or InsuranceClaim records",
    );
  return claims.map((c) => {
    const get = (...keys) => {
      for (const key of keys) if (c[key] !== undefined) return c[key];
    };
    const input = {
      policyId: get("policyId", "PolicyId", "PolicyRef"),
      customerId: get("customerId", "CustomerId", "InsuredRef"),
      type: get("type", "ClaimType", "LossType"),
      incidentDate: normalizedDate(
        get("incidentDate", "IncidentDate", "LossDate"),
      ),
      reportedDate: normalizedDate(
        get("reportedDate", "ReportedDate", "NoticeAt"),
      ),
      amount: get("amount", "Amount", "TotalLossAmount"),
      currency: get("currency", "Currency") || "USD",
      description: get("description", "Description", "LossNarrative"),
      idempotencyKey: get("idempotencyKey", "TransactionId"),
      assetId: get("assetId", "AssetId") || c.AutoDetails?.Vin,
      providerId: get(
        "providerId",
        "ProviderId",
        "RepairFacilityId",
        "FacilityId",
      ),
      agentId: get("agentId", "AgentId", "ProducerId"),
      location: get("location", "Location", "IncidentLocation"),
      diagnosisCodes: c.HealthDetails?.DiagnosisCodes,
      procedureCodes: c.HealthDetails?.ProcedureCodes,
    };
    return Object.fromEntries(
      Object.entries(input).filter(([, v]) => v !== undefined && v !== ""),
    );
  });
}
