import { connectDatabases } from "./db.js";
import { createApp } from "./app.js";

const host = process.env.HOST || "127.0.0.1";
if (
  !["127.0.0.1", "localhost", "::1"].includes(host) &&
  !process.env.SOAP_API_KEY
)
  throw new Error(
    "Set SOAP_API_KEY before exposing the SOAP server on a non-loopback host",
  );
const port = Number(process.env.PORT || 3100);
if (!Number.isInteger(port) || port < 1 || port > 65535)
  throw new Error("Invalid PORT");
const retryMs = Number(process.env.GRAPH_RETRY_MS || 10000);
if (!Number.isInteger(retryMs) || retryMs < 1000)
  throw new Error("GRAPH_RETRY_MS must be at least 1000");
const ctx = await connectDatabases();
const { app, bridge, jobs } = await createApp(ctx);
const server = app.listen(port, host, () =>
  console.log(
    `ClaimNexus: http://${host}:${port}\nSOAP WSDL: http://${host}:${port}/soap?wsdl`,
  ),
);
let retryActive;
const retry = setInterval(() => {
  if (retryActive) return;
  retryActive = bridge
    .retry()
    .catch((error) => console.error("Graph retry failed:", error.message))
    .finally(() => {
      retryActive = null;
    });
}, retryMs);
retry.unref();
let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  clearInterval(retry);
  await jobs.stop();
  await new Promise((resolve) => server.close(resolve));
  await retryActive;
  await bridge.tail;
  await ctx.close();
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
server.on("error", async (error) => {
  console.error(error);
  await shutdown();
  process.exitCode = 1;
});
