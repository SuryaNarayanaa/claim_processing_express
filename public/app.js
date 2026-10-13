const $ = (id) => document.getElementById(id);
const esc = (v) =>
  String(v ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const arr = (v) => (v === undefined ? [] : Array.isArray(v) ? v : [v]);
const xml = (obj) =>
  Object.entries(obj)
    .map(([key, value]) =>
      arr(value)
        .map(
          (v) =>
            `<${key}>${v && typeof v === "object" ? xml(v) : esc(v)}</${key}>`,
        )
        .join(""),
    )
    .join("");
const pretty = (v) => String(v).replaceAll("_", " ").toLowerCase();
const money = (c) =>
  new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: c.currency,
  }).format(Number(c.amount));
let policies = [],
  providers = [],
  selectedId,
  offset = 0,
  total = 0,
  pendingKey;
function feedback(message, error = false) {
  $("feedback").textContent = message;
  $("feedback").className = error ? "error" : "success";
}
function objectFromXml(node) {
  if (!node.children.length) return node.textContent;
  const out = {};
  for (const child of node.children) {
    const value = objectFromXml(child),
      key = child.localName;
    if (key in out) out[key] = [...arr(out[key]), value];
    else out[key] = value;
  }
  return out;
}
async function call(name, args = {}) {
  const response = await fetch("/soap", {
    method: "POST",
    headers: {
      "Content-Type": "text/xml; charset=utf-8",
      SOAPAction: `"urn:claimnexus/${name}"`,
      "X-API-Key": $("key").value,
    },
    body: `<?xml version="1.0"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><${name} xmlns="urn:claimnexus">${xml(args)}</${name}></soap:Body></soap:Envelope>`,
  });
  const doc = new DOMParser().parseFromString(
    await response.text(),
    "text/xml",
  );
  if (doc.getElementsByTagName("parsererror").length)
    throw new Error(
      "Server returned invalid XML. Check the connection and retry.",
    );
  const fault = doc.getElementsByTagNameNS("*", "Fault")[0];
  if (fault)
    throw new Error(
      fault.getElementsByTagName("faultstring")[0]?.textContent ||
        "SOAP request failed",
    );
  if (!response.ok) throw new Error(`Request failed (${response.status})`);
  const result = doc.getElementsByTagNameNS("*", `${name}Response`)[0];
  if (!result) throw new Error("SOAP response is missing");
  return objectFromXml(result);
}
async function action(button, work) {
  const control = typeof button === "string" ? $(button) : button;
  control.disabled = true;
  try {
    await work();
  } catch (error) {
    feedback(error.message, true);
  } finally {
    control.disabled = false;
  }
}
async function ledger() {
  const data = await call("ListClaims", {
    status: $("status").value,
    type: $("type").value,
    limit: 25,
    offset,
  });
  total = Number(data.total);
  $("claims").innerHTML =
    arr(data.claim)
      .map(
        (c) =>
          `<tr><td><div class="claim-id">${esc(c.id)}</div><small>${esc(c.policyId)}</small></td><td>${esc(c.type)}</td><td>${esc(money(c))}</td><td><span class="badge ${esc(c.status.toLowerCase())}">${esc(pretty(c.status))}</span></td><td><span class="badge ${esc(c.graphSync.toLowerCase())}">${esc(pretty(c.graphSync))}</span></td><td>${esc(new Date(c.incidentDate).toLocaleDateString())}</td><td><button data-id="${esc(c.id)}">Inspect</button></td></tr>`,
      )
      .join("") ||
    '<tr><td colspan="7">No claims match this view. Submit a claim or add demo data.</td></tr>';
  $("record-count").textContent = total
    ? `${offset + 1}–${Math.min(offset + 25, total)} of ${total} claims`
    : "0 claims";
  $("previous").disabled = offset === 0;
  $("next").disabled = offset + 25 >= total;
}
async function refresh() {
  const [health, summary, policyData, providerData, stream, analytics, lake] =
    await Promise.all(
      [
        "GetHealth",
        "GetSummary",
        "ListPolicies",
        "ListProviders",
        "GetStreamStatus",
        "GetAnalyticsSummary",
        "GetLakeInfo",
      ].map((op) => call(op)),
    );
  $("health").textContent =
    `MongoDB: ${pretty(health.mongodb)} · Neo4j: ${pretty(health.neo4j)}`;
  $("summary").innerHTML =
    `<div class="metric"><strong>${esc(summary.total)}</strong><span>Total claims</span></div>` +
    arr(summary.status)
      .map(
        (s) =>
          `<div class="metric"><strong>${esc(s.count)}</strong><span>${esc(pretty(s.name))}</span></div>`,
      )
      .join("");
  policies = arr(policyData.policy);
  providers = arr(providerData.provider);
  const current = $("policy").value;
  $("policy").innerHTML =
    '<option value="">Choose a policy</option>' +
    policies
      .map(
        (p) =>
          `<option value="${esc(p.id)}">${esc(p.id)} · ${esc(p.type)}</option>`,
      )
      .join("");
  if (policies.some((p) => p.id === current)) $("policy").value = current;
  for (const [id, list] of [
    ["provider", providers.filter((p) => p.type !== "AGENT")],
    ["agent", providers.filter((p) => p.type === "AGENT")],
  ]) {
    const value = $(id).value;
    $(id).innerHTML =
      '<option value="">None</option>' +
      list
        .map(
          (p) =>
            `<option value="${esc(p.id)}">${esc(p.name)} · ${esc(p.type)}</option>`,
        )
        .join("");
    $(id).value = value;
  }
  $("jobs").textContent =
    `Stream: ${pretty(stream.status)} (${stream.generated} generated, ${stream.valid} valid, ${stream.invalid} invalid) · Analytics: ${analytics.processed} processed, ${analytics.candidates} newly flagged · Parquet: ${lake.files} snapshots`;
  await ledger();
}
async function inspect(id, focus = true) {
  const data = await call("GetClaim", { id });
  selectedId = id;
  $("detail").hidden = false;
  const labels = {
    id: "Claim ID",
    policyId: "Policy",
    customerId: "Customer",
    type: "Type",
    incidentDate: "Incident date",
    reportedDate: "Reported date",
    amount: "Claim amount",
    currency: "Currency",
    description: "Description",
    status: "Status",
    graphSync: "Graph synchronization",
    createdAt: "Created",
    updatedAt: "Last updated",
    assetId: "Asset",
    providerId: "Provider",
    agentId: "Agent",
    location: "Location",
    diagnosisCodes: "Diagnosis codes",
    procedureCodes: "Procedure codes",
    validationErrors: "Validation errors",
    riskIndicators: "Review indicators",
  };
  $("detail-content").innerHTML = `<dl class="detail-grid">${Object.entries(
    data.claim,
  )
    .filter(([k]) => k in labels)
    .map(
      ([k, v]) =>
        `<div><dt>${esc(labels[k])}</dt><dd>${esc(Array.isArray(v) ? v.join("; ") : v)}</dd></div>`,
    )
    .join("")}</dl>`;
  $("events").innerHTML = arr(data.event)
    .map(
      (e) =>
        `<li>${esc(pretty(e.type))}: ${esc(e.message)}<small>${esc(new Date(e.at).toLocaleString())} · ${esc(e.fromStatus || "NEW")} → ${esc(e.toStatus || "")}</small></li>`,
    )
    .join("");
  const transitions = {
    READY_FOR_ANALYSIS: [
      "UNDER_REVIEW",
      "INVESTIGATION_CANDIDATE",
      "APPROVED",
      "REJECTED",
    ],
    UNDER_REVIEW: ["INVESTIGATION_CANDIDATE", "APPROVED", "REJECTED"],
    INVESTIGATION_CANDIDATE: ["UNDER_REVIEW", "APPROVED", "REJECTED"],
    APPROVED: ["SETTLED"],
  };
  const options = transitions[data.claim.status] || [];
  $("status-form").hidden = !options.length;
  $("next-status").innerHTML = options
    .map((s) => `<option>${esc(s)}</option>`)
    .join("");
  $("related-results").textContent = "";
  if (focus) {
    $("detail").scrollIntoView({ behavior: "smooth", block: "start" });
    $("detail").focus({ preventScroll: true });
  }
}
$("claims").addEventListener("click", (e) => {
  const button = e.target.closest("button[data-id]");
  if (button) action(button, () => inspect(button.dataset.id));
});
for (const id of ["refresh", "connect"])
  $(id).onclick = () => action(id, refresh);
for (const id of ["status", "type"])
  $(id).onchange = () => {
    offset = 0;
    ledger().catch((e) => feedback(e.message, true));
  };
$("previous").onclick = () => {
  offset = Math.max(0, offset - 25);
  ledger().catch((e) => feedback(e.message, true));
};
$("next").onclick = () => {
  offset += 25;
  ledger().catch((e) => feedback(e.message, true));
};
$("new").onclick = () => {
  $("claim-panel").hidden = false;
  $("claim-panel").scrollIntoView({ behavior: "smooth" });
  $("policy").focus();
};
$("cancel").onclick = () => {
  $("claim-panel").hidden = true;
  $("new").focus();
};
$("policy").onchange = () => {
  const p = policies.find((p) => p.id === $("policy").value);
  if (p) {
    $("customer").value = p.customerId;
    $("asset").value = p.assetId || "";
    $("claim-type").value = p.type;
    $("currency").value = p.currency;
  }
};
$("claim-form").addEventListener("input", () => {
  pendingKey = null;
});
$("claim-form").onsubmit = (e) => {
  e.preventDefault();
  action(e.submitter, async () => {
    const claim = Object.fromEntries(
      [...new FormData(e.target)].filter(([, v]) => v !== ""),
    );
    claim.incidentDate = new Date(claim.incidentDate).toISOString();
    claim.amount = Number(claim.amount);
    pendingKey ||= crypto.randomUUID();
    claim.idempotencyKey = pendingKey;
    const result = await call("SubmitClaim", { claim });
    pendingKey = null;
    feedback(
      result.accepted === "true"
        ? `Claim ${result.claim.id} accepted.`
        : `Claim saved as invalid: ${arr(result.claim.validationErrors).join("; ")}`,
      result.accepted !== "true",
    );
    e.target.reset();
    $("claim-panel").hidden = true;
    await refresh();
    await inspect(result.claim.id);
  });
};
for (const [id, op, args, message] of [
  ["seed", "SeedDemo", {}, "Demo data added."],
  [
    "stream",
    "StartStream",
    { count: 20, intervalMs: 500 },
    "Synthetic stream started.",
  ],
  ["analytics", "RunAnalytics", {}, "Relationship analytics completed."],
  ["retry", "RetryGraphSync", { limit: 100 }, "Graph retry completed."],
  ["export", "ExportLake", {}, "Parquet snapshot exported."],
]) {
  $(id).onclick = () =>
    action(id, async () => {
      const result = await call(op, args);
      feedback(`${message} ${op === "ExportLake" ? result.file : ""}`);
      await refresh();
    });
}
$("import-toggle").onclick = () => {
  $("import-panel").hidden = !$("import-panel").hidden;
};
async function importData(op, args) {
  const result = await call(op, args);
  $("import-results").textContent = JSON.stringify(result, null, 2);
  feedback(
    `Imported ${result.accepted} of ${result.submitted} records. See per-record results.`,
  );
  await refresh();
}
$("import-xml").onclick = () =>
  action("import-xml", () =>
    importData("ImportClaimsXml", { xml: $("xml").value }),
  );
$("import-file").onchange = () =>
  action("import-xml", async () => {
    const file = $("import-file").files[0];
    if (!file) return;
    if (file.size > 900000) throw new Error("Use a file smaller than 900 KB.");
    const content = await file.text();
    if (file.name.toLowerCase().endsWith(".json"))
      await importData("ImportClaimsBatch", { claim: JSON.parse(content) });
    else {
      $("xml").value = content;
      await importData("ImportClaimsXml", { xml: content });
    }
  });
$("close-detail").onclick = () => {
  $("detail").hidden = true;
  $("refresh").focus();
};
$("related").onclick = () =>
  action("related", async () => {
    const result = await call("GetRelatedClaims", { id: selectedId });
    $("related-results").textContent =
      arr(result.related)
        .map((r) => `${r.claimId} · ${arr(r.sharedEntity).join(", ")}`)
        .join("\n") || "No shared relationships found.";
  });
$("status-form").onsubmit = (e) => {
  e.preventDefault();
  action(e.submitter, async () => {
    await call("SetClaimStatus", {
      id: selectedId,
      status: $("next-status").value,
      message: $("review-note").value || "Reviewed in dashboard",
    });
    feedback("Status and audit history updated.");
    await refresh();
    await inspect(selectedId, false);
  });
};
const masterFields = {
  Customer: ["id", "name", "email?", "phone?"],
  Provider: ["id", "name", "type"],
  Policy: [
    "id",
    "customerId",
    "type",
    "startDate",
    "endDate",
    "coverageLimit",
    "deductible?",
    "currency",
    "status",
    "assetId?",
  ],
};
function renderMaster() {
  const kind = $("master-type").value;
  $("master-fields").innerHTML = masterFields[kind]
    .map((field) => {
      const optional = field.endsWith("?"),
        name = field.replace("?", "");
      const options =
        name === "type"
          ? kind === "Provider"
            ? ["GARAGE", "HOSPITAL", "CONTRACTOR", "INSPECTOR", "AGENT"]
            : ["AUTO", "HEALTH", "PROPERTY"]
          : name === "status"
            ? ["ACTIVE", "LAPSED", "CANCELLED", "EXPIRED"]
            : null;
      const control = options
        ? `<select name="${name}">${options.map((v) => `<option>${v}</option>`).join("")}</select>`
        : `<input name="${name}" type="${name.endsWith("Date") ? "datetime-local" : ["coverageLimit", "deductible"].includes(name) ? "number" : name === "email" ? "email" : "text"}" ${optional ? "" : "required"} ${name === "currency" ? 'value="USD"' : ""}>`;
      return `<label>${name}${optional ? " (optional)" : ""}${control}</label>`;
    })
    .join("");
}
$("master-type").onchange = renderMaster;
$("master-toggle").onclick = () => {
  $("master-panel").hidden = !$("master-panel").hidden;
  renderMaster();
};
$("master-form").onsubmit = (e) => {
  e.preventDefault();
  action(e.submitter, async () => {
    const kind = $("master-type").value,
      value = Object.fromEntries(
        [...new FormData(e.target)].filter(([, v]) => v !== ""),
      );
    for (const name of ["startDate", "endDate"])
      if (value[name]) value[name] = new Date(value[name]).toISOString();
    await call(`Create${kind}`, { [kind.toLowerCase()]: value });
    feedback(`${kind} created.`);
    e.target.reset();
    await refresh();
  });
};
refresh().catch((e) => {
  $("health").textContent = "Connection failed";
  feedback(e.message, true);
});
setInterval(
  () =>
    call("GetStreamStatus")
      .then((s) => {
        if (s.status === "RUNNING" || s.status === "COMPLETED")
          return refresh();
      })
      .catch(() => {}),
  5000,
);
