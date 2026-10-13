// One contract generates a real document/literal WSDL and guides the server's handlers.
const strings = (names) => names.split(" ").map((name) => [name, "string"]);
export const dataTypes = {
  ClaimInput: [
    ...strings("policyId customerId type incidentDate"),
    ["amount", "double"],
    ...strings("currency description"),
    ...strings(
      "reportedDate assetId providerId agentId location diagnosisCodes procedureCodes idempotencyKey",
    ).map(([n, t]) => [n, t, "?"]),
  ],
  Claim: [
    ...strings("id policyId customerId type incidentDate reportedDate"),
    ["amount", "double"],
    ...strings("currency description status graphSync createdAt updatedAt"),
    ["version", "int"],
    ...strings(
      "assetId providerId agentId location diagnosisCodes procedureCodes idempotencyKey",
    ).map(([n, t]) => [n, t, "?"]),
    ["validationErrors", "string", "*"],
    ["riskIndicators", "string", "*"],
  ],
  Customer: [
    ...strings("id name"),
    ["email", "string", "?"],
    ["phone", "string", "?"],
  ],
  Policy: [
    ...strings("id customerId type startDate endDate"),
    ["coverageLimit", "double"],
    ["deductible", "double", "?"],
    ["currency", "string", "?"],
    ["status", "string", "?"],
    ["assetId", "string", "?"],
  ],
  Provider: strings("id name type"),
  Event: [
    ...strings("id claimId type at message"),
    ["fromStatus", "string", "?"],
    ["toStatus", "string", "?"],
  ],
  StatusCount: [
    ["name", "string"],
    ["count", "int"],
  ],
  Related: [
    ["claimId", "string"],
    ["status", "string"],
    ["amount", "double"],
    ["sharedEntity", "string", "*"],
  ],
  BatchResult: [
    ["index", "int"],
    ["id", "string", "?"],
    ["accepted", "boolean"],
    ["message", "string"],
  ],
  Cluster: [
    ["providerId", "string"],
    ["agentId", "string"],
    ["count", "int"],
  ],
};
export const operations = {
  SubmitClaim: [
    [["claim", "ClaimInput"]],
    [
      ["claim", "Claim"],
      ["accepted", "boolean"],
      ["replayed", "boolean"],
    ],
  ],
  GetClaim: [
    [["id", "string"]],
    [
      ["claim", "Claim"],
      ["event", "Event", "*"],
    ],
  ],
  ListClaims: [
    [
      ["status", "string", "?"],
      ["type", "string", "?"],
      ["limit", "int", "?"],
      ["offset", "int", "?"],
    ],
    [
      ["claim", "Claim", "*"],
      ["total", "int"],
    ],
  ],
  GetSummary: [
    [],
    [
      ["total", "int"],
      ["status", "StatusCount", "*"],
    ],
  ],
  SetClaimStatus: [
    [
      ["id", "string"],
      ["status", "string"],
      ["message", "string", "?"],
    ],
    [
      ["claim", "Claim"],
      ["event", "Event", "*"],
    ],
  ],
  CreateCustomer: [[["customer", "Customer"]], [["record", "Customer"]]],
  CreatePolicy: [[["policy", "Policy"]], [["record", "Policy"]]],
  CreateProvider: [[["provider", "Provider"]], [["record", "Provider"]]],
  ListCustomers: [[], [["customer", "Customer", "*"]]],
  ListPolicies: [[], [["policy", "Policy", "*"]]],
  ListProviders: [[], [["provider", "Provider", "*"]]],
  GetHealth: [[], strings("status mongodb neo4j")],
  GetRelatedClaims: [[["id", "string"]], [["related", "Related", "*"]]],
  RetryGraphSync: [
    [["limit", "int", "?"]],
    [
      ["attempted", "int"],
      ["synced", "int"],
    ],
  ],
  ImportClaimsXml: [
    [["xml", "string"]],
    [
      ["result", "BatchResult", "*"],
      ["submitted", "int"],
      ["accepted", "int"],
    ],
  ],
  ImportClaimsBatch: [
    [["claim", "ClaimInput", "*"]],
    [
      ["result", "BatchResult", "*"],
      ["submitted", "int"],
      ["accepted", "int"],
    ],
  ],
  SeedDemo: [
    [],
    [
      ["message", "string"],
      ["claims", "int"],
    ],
  ],
  StartStream: [
    [
      ["count", "int", "?"],
      ["intervalMs", "int", "?"],
    ],
    [
      ["status", "string"],
      ["generated", "int"],
      ["valid", "int"],
      ["invalid", "int"],
    ],
  ],
  GetStreamStatus: [
    [],
    [
      ["status", "string"],
      ["generated", "int"],
      ["valid", "int"],
      ["invalid", "int"],
      ["updatedAt", "string", "?"],
    ],
  ],
  RunAnalytics: [
    [],
    [
      ["engine", "string"],
      ["at", "string", "?"],
      ["processed", "int"],
      ["candidates", "int"],
      ["cluster", "Cluster", "*"],
    ],
  ],
  GetAnalyticsSummary: [
    [],
    [
      ["engine", "string"],
      ["at", "string", "?"],
      ["processed", "int"],
      ["candidates", "int"],
      ["cluster", "Cluster", "*"],
    ],
  ],
  ExportLake: [
    [],
    [
      ["file", "string"],
      ["count", "int"],
    ],
  ],
  GetLakeInfo: [
    [],
    [
      ["files", "int"],
      ["bytes", "double"],
    ],
  ],
};
const escape = (v) =>
  v.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");
const fieldsXml = (fields) =>
  fields
    .map(
      ([name, type, arity]) =>
        `<xsd:element name="${name}" type="${dataTypes[type] ? "tns" : "xsd"}:${type}" minOccurs="${arity ? 0 : 1}"${arity === "*" ? ' maxOccurs="unbounded"' : ""}/>`,
    )
    .join("");
export function makeWsdl(endpoint) {
  const names = Object.keys(operations);
  return `<?xml version="1.0" encoding="UTF-8"?>
<definitions xmlns="http://schemas.xmlsoap.org/wsdl/" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:tns="urn:claimnexus" xmlns:soap="http://schemas.xmlsoap.org/wsdl/soap/" targetNamespace="urn:claimnexus" name="ClaimService">
<types><xsd:schema targetNamespace="urn:claimnexus" elementFormDefault="qualified">
${Object.entries(dataTypes)
  .map(
    ([name, fields]) =>
      `<xsd:complexType name="${name}"><xsd:sequence>${fieldsXml(fields)}</xsd:sequence></xsd:complexType>`,
  )
  .join("\n")}
${names.map((name) => operations[name].map((fields, i) => `<xsd:element name="${name}${i ? "Response" : ""}"><xsd:complexType><xsd:sequence>${fieldsXml(fields)}</xsd:sequence></xsd:complexType></xsd:element>`).join("")).join("\n")}
</xsd:schema></types>
${names.map((name) => `<message name="${name}Request"><part name="parameters" element="tns:${name}"/></message><message name="${name}Response"><part name="parameters" element="tns:${name}Response"/></message>`).join("\n")}
<portType name="ClaimPortType">${names.map((name) => `<operation name="${name}"><input message="tns:${name}Request"/><output message="tns:${name}Response"/></operation>`).join("")}</portType>
<binding name="ClaimBinding" type="tns:ClaimPortType"><soap:binding style="document" transport="http://schemas.xmlsoap.org/soap/http"/>
${names.map((name) => `<operation name="${name}"><soap:operation soapAction="urn:claimnexus/${name}"/><input><soap:body use="literal"/></input><output><soap:body use="literal"/></output></operation>`).join("\n")}</binding>
<service name="ClaimService"><port name="ClaimPort" binding="tns:ClaimBinding"><soap:address location="${escape(endpoint)}"/></port></service></definitions>`;
}
// Keep output fields exactly within the published XML contract.
export function contractOutput(name, value) {
  const select = (fields, obj) =>
    Object.fromEntries(
      fields
        .filter(([key]) => obj?.[key] !== undefined)
        .map(([key, type, arity]) => {
          const v = obj[key];
          return [
            key,
            dataTypes[type]
              ? arity === "*"
                ? (Array.isArray(v) ? v : [v]).map((item) =>
                    select(dataTypes[type], item),
                  )
                : select(dataTypes[type], v)
              : v,
          ];
        }),
    );
  return select(operations[name][1], value);
}
