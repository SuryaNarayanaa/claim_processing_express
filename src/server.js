import { connectDatabases } from "./db.js";
import { createApp } from "./app.js";
import { runtimeConfig } from "./runtime.js";

const { host, port, retryMs, endpoint } = runtimeConfig();
const ctx = await connectDatabases();
const { app, bridge, jobs } = await createApp(ctx);
const server = app.listen(port, host, () =>
  console.log(
    `ClaimNexus listening on ${host}:${port}\nSOAP WSDL: ${endpoint}?wsdl`,
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
