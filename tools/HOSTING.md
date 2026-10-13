# Render, MongoDB Atlas and Neo4j Aura

Deploy the actual Express application from [the public repository](https://github.com/SuryaNarayanaa/claim_processing_express). Render runs Node.js and serves the dashboard and SOAP service. Atlas stores claims, policies, customers, providers, audit events and analytics. Aura stores the graph projection. Only synthetic demo data should be added to this shared-key demo application.

The checked-in [Render Blueprint](../render.yaml) selects the free web-service plan and requests credentials through Render's secret fields. It does not create Atlas or Aura accounts or databases. No credentials belong in GitHub or a chat message.

## Create the free databases

1. Sign in at [MongoDB Atlas](https://cloud.mongodb.com/). Create a separate project named `ClaimNexus` and select **Free / M0** for a cluster named `claimnexus`. Choose Singapore if the selected provider offers it; otherwise choose the closest available free region. Do not select Flex or a paid dedicated tier.
2. Create a database user named `claimnexus_app` with a generated password. Grant `readWrite` on the `claimnexus_express` database. Keep the password in your password manager. In **Connect → Drivers**, copy the Node.js `mongodb+srv://` URI and replace the password placeholder with the URL-encoded password. This cluster supports the application's MongoDB transactions; do not replace it with a standalone MongoDB server.
3. Sign in at [Neo4j Aura](https://console.neo4j.io/). Create **AuraDB Free**, named `ClaimNexus`, and save the generated credentials file. Wait for the instance to become available. Use its `neo4j+s://…databases.neo4j.io` URI, username `neo4j`, generated password and database `neo4j`. Keep TLS certificate verification enabled.

Use fresh databases for this deployment. Startup creates MongoDB indexes and checks Neo4j connectivity; claim ingestion creates graph uniqueness constraints. Local databases are not copied or exposed by deploying the app. Add demo data after deployment through SOAP or the dashboard.

## Create the Render service

Open [Deploy to Render](https://render.com/deploy?repo=https://github.com/SuryaNarayanaa/claim_processing_express), sign in, and review the Blueprint for the repository's `main` branch. It creates one free Docker web service in Singapore.

Fill the prompted secret values directly in Render:

| Variable | Value |
| --- | --- |
| `MONGODB_URI` | Atlas SRV connection URI with the database user's encoded password |
| `NEO4J_URI` | Aura encrypted `neo4j+s://` URI |
| `NEO4J_PASSWORD` | Aura's generated database password |

The Blueprint sets `MONGODB_DB_NAME=claimnexus_express`, `NEO4J_USERNAME=neo4j`, `NEO4J_DATABASE=neo4j`, `HOST=0.0.0.0`, `PORT=10000` and `NODE_ENV=production`. Render generates a random 256-bit `SOAP_API_KEY`. Do not copy local `.env` defaults into Render.

Atlas accepts connections only from its configured network access list. Once the Render service exists, open **Connect → Outbound** and add all listed CIDR ranges to the Atlas project's **Network Access** list. Render's outbound ranges are shared by services in the selected region, so a strong, scoped database credential remains necessary. Avoid allowing `0.0.0.0/0`. If the first deploy fails before this setup is finished, redeploy after adding the ranges.

Wait for Render to report a successful deployment and note the actual `https://…onrender.com` address. The WSDL uses `RENDER_EXTERNAL_URL` automatically. If you later add a custom domain, set `SOAP_PUBLIC_URL=https://your-domain/soap` in Render and redeploy. Never put an API key into that URL.

## Verify the hosted service

1. Open the hosted dashboard. Expand **Connection key**, enter Render's generated `SOAP_API_KEY`, and click **Connect**. Both database statuses must be connected.
2. Click **Add demo data**. Submit or import a claim and confirm its graph synchronization state is `SYNCED`. Use **Service contract** to download the authenticated WSDL.
3. Import `tools/postman/ClaimNexus-SOAP.postman_collection.json` into Postman. Set `baseUrl` to the real Render origin and set `apiKey` to the generated key. Keep the key local; do not export it with a collection. Run the collection to exercise SOAP XML, partner XML, graph queries and audit history.

For an additional read-only command-line check, create an ignored `.env.hosting` file on your own computer containing `HOSTED_BASE_URL` and `SOAP_API_KEY`, then run:

```powershell
npm.cmd run verify:hosting
```

This check verifies the dashboard, `/healthz`, denial without a key, authenticated WSDL and its actual SOAP address, a real SOAP response, MongoDB connectivity and Neo4j connectivity. It does not modify claims or publish secrets. `/healthz` returns only `ok` or `unavailable`, based on MongoDB readiness. Neo4j availability is checked by authenticated `GetHealth`; a later graph outage uses the durable retry mechanism while MongoDB remains usable.

## Free-plan behavior

[Render Free](https://render.com/docs/free) sleeps after 15 minutes without incoming traffic and takes time to wake. In-memory synthetic streams stop on shutdown. Claims, audit history and analytics persist in Atlas, and graph records persist in Aura. Projection retry resumes when the application starts again.

Local Parquet snapshots are lost on Render restarts, redeploys and idle shutdowns. The Docker image provides a writable directory, but the free plan has no persistent disk. For durable Parquet storage, a later change can add external object storage, or a paid Render service can mount a persistent disk at `/app/datalake`. Neither paid service nor paid disk is provisioned by this Blueprint.

[AuraDB Free](https://neo4j.com/docs/aura/managing-instances/instance-actions/) pauses after 72 hours of inactivity. Resume it in Aura before a demonstration if needed. A paused graph causes `GetHealth` to report degraded connectivity, and graph writes remain queued in MongoDB for retry.

This deployment uses a shared API key; everyone with it can perform all SOAP operations. The public dashboard shell contains no claims until a valid key is supplied. Use demo data for public demonstrations; production deployment with customer data needs individual authentication and permissions.

## Provider references

- [Render Blueprint fields and generated secrets](https://render.com/docs/blueprint-spec)
- [Render public URL environment variable](https://render.com/docs/environment-variables)
- [Render outbound IP ranges](https://render.com/docs/outbound-ip-addresses)
- [Atlas free cluster setup](https://www.mongodb.com/docs/atlas/tutorial/deploy-free-tier-cluster/)
- [Atlas IP access list](https://www.mongodb.com/docs/atlas/security/ip-access-list/)
- [Aura instance creation](https://neo4j.com/docs/aura/getting-started/create-instance/)
