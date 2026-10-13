const loopbackHosts = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

export function soapEndpoint(env = process.env) {
  const address = env.SOAP_PUBLIC_URL ||
    (env.RENDER_EXTERNAL_URL ? new URL("/soap", env.RENDER_EXTERNAL_URL).href :
      `http://127.0.0.1:${env.PORT || 3100}/soap`);
  let url;
  try {
    url = new URL(address);
  } catch {
    throw new Error("SOAP_PUBLIC_URL must be an absolute URL ending in /soap");
  }
  if (url.pathname !== "/soap" || url.search || url.hash || url.username || url.password ||
      !(url.protocol === "https:" || (url.protocol === "http:" && loopbackHosts.has(url.hostname))))
    throw new Error("SOAP_PUBLIC_URL must use HTTPS (HTTP is allowed only on loopback) and end in /soap");
  return url.href;
}

export function runtimeConfig(env = process.env) {
  const host = env.HOST || (env.RENDER === "true" ? "0.0.0.0" : "127.0.0.1");
  if (!loopbackHosts.has(host) && !env.SOAP_API_KEY)
    throw new Error("Set SOAP_API_KEY before exposing the SOAP server on a non-loopback host");
  if (env.NODE_ENV === "production") {
    for (const name of ["MONGODB_URI", "NEO4J_URI", "NEO4J_PASSWORD"])
      if (!env[name]) throw new Error(`Set ${name} for the hosted application`);
    if ((env.SOAP_API_KEY || "").length < 32)
      throw new Error("Use a SOAP_API_KEY of at least 32 characters in production");
  }
  const port = Number(env.PORT || 3100);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("Invalid PORT");
  const retryMs = Number(env.GRAPH_RETRY_MS || 10000);
  if (!Number.isInteger(retryMs) || retryMs < 1000)
    throw new Error("GRAPH_RETRY_MS must be at least 1000");
  return { host, port, retryMs, endpoint: soapEndpoint(env) };
}
