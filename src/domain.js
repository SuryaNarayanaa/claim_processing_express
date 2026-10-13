import { z } from "zod";

export const types = ["AUTO", "HEALTH", "PROPERTY"];
export const statuses = [
  "READY_FOR_ANALYSIS",
  "INVALID",
  "UNDER_REVIEW",
  "INVESTIGATION_CANDIDATE",
  "APPROVED",
  "REJECTED",
  "SETTLED",
];
const id = z.string().trim().min(1).max(120);
const text = z.string().trim().max(2000);
const date = z.iso
  .datetime({ offset: true })
  .transform((v) => new Date(v).toISOString());
const amount = z.coerce.number().finite().positive().max(1e12);
export const claimSchema = z
  .object({
    policyId: id,
    customerId: id,
    type: z.enum(types),
    incidentDate: date,
    reportedDate: date.optional(),
    amount,
    currency: z
      .string()
      .regex(/^[A-Z]{3}$/)
      .default("USD"),
    description: text.min(5),
    assetId: id.optional(),
    providerId: id.optional(),
    agentId: id.optional(),
    location: text.optional(),
    diagnosisCodes: text.optional(),
    procedureCodes: text.optional(),
    idempotencyKey: id.optional(),
  })
  .strict();
export const customerSchema = z
  .object({
    id,
    name: text.min(1),
    email: z.email().optional(),
    phone: text.optional(),
  })
  .strict();
export const providerSchema = z
  .object({
    id,
    name: text.min(1),
    type: z.enum(["GARAGE", "HOSPITAL", "CONTRACTOR", "INSPECTOR", "AGENT"]),
  })
  .strict();
export const policySchema = z
  .object({
    id,
    customerId: id,
    type: z.enum(types),
    status: z
      .enum(["ACTIVE", "LAPSED", "CANCELLED", "EXPIRED"])
      .default("ACTIVE"),
    startDate: date,
    endDate: date,
    coverageLimit: amount,
    deductible: z.coerce.number().finite().nonnegative().default(0),
    currency: z
      .string()
      .regex(/^[A-Z]{3}$/)
      .default("USD"),
    assetId: id.optional(),
  })
  .strict()
  .refine(
    (v) => v.endDate >= v.startDate,
    "Policy end date must follow start date",
  );
export class DomainError extends Error {
  constructor(message, code = "Client") {
    super(message);
    this.code = code;
  }
}
export function parse(schema, input) {
  const result = schema.safeParse(input);
  if (!result.success)
    throw new DomainError(
      result.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; "),
    );
  return result.data;
}
export const requireId = (value) => parse(id, value);
export const limitValue = (value) =>
  parse(z.coerce.number().int().min(1).max(500).default(50), value);
export const transitions = {
  READY_FOR_ANALYSIS: [
    "UNDER_REVIEW",
    "INVESTIGATION_CANDIDATE",
    "APPROVED",
    "REJECTED",
  ],
  UNDER_REVIEW: ["INVESTIGATION_CANDIDATE", "APPROVED", "REJECTED"],
  INVESTIGATION_CANDIDATE: ["UNDER_REVIEW", "APPROVED", "REJECTED"],
  APPROVED: ["SETTLED"],
  REJECTED: [],
  SETTLED: [],
  INVALID: [],
};
