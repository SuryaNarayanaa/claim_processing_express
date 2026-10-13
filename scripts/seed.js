import soap from "soap";
const url = process.env.SOAP_PUBLIC_URL || "http://127.0.0.1:3100/soap";
const headers = process.env.SOAP_API_KEY
  ? { "X-API-Key": process.env.SOAP_API_KEY }
  : {};
const client = await soap.createClientAsync(`${url}?wsdl`, {
  wsdl_headers: headers,
});
client.setEndpoint(url);
client.addHttpHeader("X-API-Key", process.env.SOAP_API_KEY || "");
console.log((await client.SeedDemoAsync({}))[0]);
