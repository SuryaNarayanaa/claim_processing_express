import express from "express";
import soap from "soap";
import { timingSafeEqual } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { GraphBridge } from "./graph.js";
import { ClaimService } from "./claims.js";
import { Jobs } from "./jobs.js";
import { makeWsdl, operations, contractOutput } from "./contract.js";
import { parseClaimsXml } from "./xml.js";
import { seedDemo } from "./seed.js";
import { DomainError, limitValue, requireId } from "./domain.js";

export const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
export async function createApp(ctx, env = process.env) {
  const app = express();
  app.disable("x-powered-by");
  const bridge = new GraphBridge(ctx);
  const service = new ClaimService(ctx, bridge);
  const jobs = new Jobs(service, root);
  const handlers = {
    SubmitClaim: (a) => service.submit(a.claim),
    GetClaim: (a) => service.get(a.id),
    ListClaims: (a) => service.list(a),
    GetSummary: () => service.summary(),
    SetClaimStatus: (a) => service.transition(a.id, a.status, a.message),
    CreateCustomer: (a) => service.createMaster("customers", a.customer),
    CreatePolicy: (a) => service.createMaster("policies", a.policy),
    CreateProvider: (a) => service.createMaster("providers", a.provider),
    ListCustomers: async () => ({
      customer: await service.listMaster("customers"),
    }),
    ListPolicies: async () => ({
      policy: await service.listMaster("policies"),
    }),
    ListProviders: async () => ({
      provider: await service.listMaster("providers"),
    }),
    GetHealth: () => service.health(),
    GetRelatedClaims: (a) => bridge.related(requireId(a.id)),
    RetryGraphSync: (a) => bridge.retry(limitValue(a.limit)),
    ImportClaimsXml: (a) => jobs.importBatch(parseClaimsXml(a.xml)),
    ImportClaimsBatch: (a) =>
      jobs.importBatch(
        Array.isArray(a.claim) ? a.claim : a.claim ? [a.claim] : [],
      ),
    SeedDemo: () => seedDemo(service),
    StartStream: (a) => jobs.startStream(a),
    GetStreamStatus: () => ({ ...jobs.stream }),
    RunAnalytics: () => jobs.analytics(),
    GetAnalyticsSummary: () => jobs.analyticsSummary(),
    ExportLake: () => jobs.exportLake(),
    GetLakeInfo: () => jobs.lakeInfo(),
  };
  const soapFault = (res, message, code = "Client", status = 400) => {
    res
      .status(status)
      .type("text/xml")
      .send(
        `<?xml version="1.0"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><soap:Fault><faultcode>soap:${code}</faultcode><faultstring>${message}</faultstring></soap:Fault></soap:Body></soap:Envelope>`,
      );
  };
  app.use((req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "same-origin");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'",
    );
    next();
  });
  app.use(
    "/soap",
    (req, res, next) => {
      if (env.SOAP_API_KEY) {
        const provided = Buffer.from(req.get("X-API-Key") || ""),
          expected = Buffer.from(env.SOAP_API_KEY);
        if (
          provided.length !== expected.length ||
          !timingSafeEqual(provided, expected)
        )
          return soapFault(res, "Invalid API key", "Client", 401);
      }
      if (!["GET", "POST"].includes(req.method))
        return soapFault(
          res,
          "SOAP supports GET WSDL and POST envelopes",
          "Client",
          405,
        );
      if (
        req.method === "POST" &&
        !/^text\/xml(?:;|$)/i.test(req.get("content-type") || "")
      )
        return soapFault(
          res,
          "Use SOAP 1.1 with Content-Type text/xml",
          "Client",
          415,
        );
      next();
    },
    express.raw({ type: () => true, limit: "1mb" }),
    (req, res, next) => {
      if (req.body && /<!DOCTYPE|<!ENTITY/i.test(req.body.toString()))
        return soapFault(res, "DTD and entity declarations are forbidden");
      next();
    },
  );
  const methods = Object.fromEntries(
    Object.keys(operations).map((name) => [
      name,
      async (args) => {
        try {
          return contractOutput(name, await handlers[name](args || {}));
        } catch (error) {
          if (!(error instanceof DomainError))
            console.error(`SOAP ${name} failed:`, error);
          throw {
            Fault: {
              faultcode: `soap:${error instanceof DomainError ? error.code : "Server"}`,
              faultstring:
                error instanceof DomainError
                  ? error.message
                  : "Operation failed. Check the server log and retry.",
              statusCode: 500,
            },
          };
        }
      },
    ]),
  );
  const endpoint =
    env.SOAP_PUBLIC_URL || `http://127.0.0.1:${env.PORT || 3100}/soap`;
  await new Promise((resolve, reject) =>
    soap.listen(app, {
      path: "/soap",
      services: { ClaimService: { ClaimPort: methods } },
      xml: makeWsdl(endpoint),
      enableChunkedEncoding: false,
      callback: (error) => (error ? reject(error) : resolve()),
    }),
  );
  app.use(express.static(path.join(root, "public")));
  app.use((req, res) =>
    res
      .status(404)
      .type("text")
      .send("Not found. Business operations are available through /soap?wsdl."),
  );
  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    soapFault(
      res,
      error.type === "entity.too.large"
        ? "SOAP envelope exceeds 1 MiB"
        : "Invalid request body",
      "Client",
      error.status || 400,
    );
  });
  return { app, service, bridge, jobs };
}
