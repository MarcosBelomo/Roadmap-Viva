// netlify/functions/jira-proxy.js
const https = require("https");

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function httpsReq(url, method, headers, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const opts = {
      hostname: u.hostname,
      path: u.pathname + u.search,
      method,
      headers: body
        ? { ...headers, "Content-Length": Buffer.byteLength(body) }
        : headers,
    };
    const req = https.request(opts, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch (e) { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: CORS, body: "" };
  }

  const { JIRA_EMAIL, JIRA_API_TOKEN, JIRA_BASE_URL } = process.env;
  if (!JIRA_EMAIL || !JIRA_API_TOKEN || !JIRA_BASE_URL) {
    return {
      statusCode: 500,
      headers: CORS,
      body: JSON.stringify({ error: "Variáveis JIRA_EMAIL, JIRA_API_TOKEN, JIRA_BASE_URL não configuradas." }),
    };
  }

  const auth = Buffer.from(`${JIRA_EMAIL}:${JIRA_API_TOKEN}`).toString("base64");
  const h = {
    Authorization: `Basic ${auth}`,
    Accept: "application/json",
    "Content-Type": "application/json",
  };

  const post = (path, body) =>
    httpsReq(`${JIRA_BASE_URL}${path}`, "POST", h, JSON.stringify(body));
  const get = (path) =>
    httpsReq(`${JIRA_BASE_URL}${path}`, "GET", h, null);

  try {
    // 1. Busca sprint ativa via API de boards
    let sprintName = "Sprint Ativa";
    let sprintStart = null;
    let sprintEnd = null;

    // Tenta pegar via campo customfield_10020 de um item qualquer
    const probeR = await post("/rest/api/3/search/jql", {
      jql: "project = VVO AND sprint in openSprints() ORDER BY key ASC",
      maxResults: 1,
      fields: ["customfield_10020", "summary"],
    });

    if (probeR.body.issues && probeR.body.issues.length > 0) {
      const sprints = probeR.body.issues[0].fields?.customfield_10020 || [];
      const active = sprints.find(s => s.state === "active") || sprints[0];
      if (active) {
        sprintName = active.name;
        sprintStart = active.startDate?.slice(0, 10);
        sprintEnd = active.endDate?.slice(0, 10);
      }
    }

    // 2. Busca TODOS os itens da sprint ativa
    const allIssues = [];
    let startAt = 0;
    const fields = [
      "summary", "status", "assignee", "issuetype", "parent",
      "customfield_10015", "duedate", "customfield_10020",
      "customfield_10021", "labels", "subtasks", "customfield_10014",
    ];

    while (true) {
      const r = await post("/rest/api/3/search/jql", {
        jql: "project = VVO AND sprint in openSprints() ORDER BY key ASC",
        maxResults: 100,
        startAt,
        fields,
      });

      const batch = r.body.issues || [];
      allIssues.push(...batch);
      if (batch.length < 100 || allIssues.length >= (r.body.total || 0)) break;
      startAt += 100;
    }

    if (allIssues.length === 0) {
      return {
        statusCode: 200,
        headers: { ...CORS, "Content-Type": "application/json" },
        body: JSON.stringify({
          error: `Debug: probe_status=${probeR.status}, total=${probeR.body.total||0}, errorMsg=${probeR.body.errorMessages||probeR.body.message||'none'}`,
          sprint: sprintName, sprintStart, sprintEnd,
          geradoEm: new Date().toISOString(),
          kpis: { total:0, concluido:0, atrasados:0, bloqueados:0, emAndamento:0, tarefasPendentes:0, porResponsavel:[] },
          pctConcluido: 0, overallRag: "G",
          itens: [],
          semResponsavelLabel: "Sem Responsável",
        }),
      };
    }

    // 3. Mapeia itens
    const GROUPS = { Erikson:["Erikson"], Lucas:["Lucas"], Rafael:["Rafael"], Hamze:["Hamze"], Vivahcare:["Vivahcare"] };
    const today = new Date(); today.setHours(0,0,0,0);

    const items = allIssues.map(issue => {
      const f = issue.fields;
      const assigneeName = f.assignee?.displayName || null;
      let assigneeGroup = "Sem Responsável";
      if (assigneeName) {
        for (const [g, kws] of Object.entries(GROUPS)) {
          if (kws.some(k => assigneeName.toLowerCase().includes(k.toLowerCase()))) {
            assigneeGroup = g; break;
          }
        }
      }
      const dueDate = f.duedate || null;
      const daysRemaining = dueDate ? Math.ceil((new Date(dueDate) - today) / 86400000) : null;
      const labels = f.labels || [];

      // Sprint info do item
      const itemSprints = f.customfield_10020 || [];
      const activeSprint = itemSprints.find(s => s.state === "active") || itemSprints[0];
      if (activeSprint && !sprintStart) {
        sprintStart = activeSprint.startDate?.slice(0, 10);
        sprintEnd = activeSprint.endDate?.slice(0, 10);
        sprintName = activeSprint.name;
      }

      return {
        key: issue.key,
        type: f.issuetype?.name || "",
        isSubtask: f.issuetype?.subtask || false,
        parentKey: f.parent?.key || null,
        parentSummary: f.parent?.fields?.summary || null,
        summary: f.summary || "",
        assignee: assigneeName,
        assigneeGroup,
        status: f.status?.name || "",
        startDate: f.customfield_10015 || null,
        dueDate,
        daysRemaining,
        flagged: !!f.customfield_10021,
        blocked: labels.includes("blocked") || labels.includes("impediment"),
        dependency: labels.includes("dependency"),
        sprint: sprintName,
      };
    });

    // 4. KPIs
    const sm = (s, rx) => s && new RegExp(rx, "i").test(s);
    const kpis = {
      total: items.length,
      tarefasPendentes: items.filter(i => sm(i.status, "tarefas pendentes")).length,
      emAndamento: items.filter(i => sm(i.status, "andamento")).length,
      concluido: items.filter(i => sm(i.status, "conclu")).length,
      atrasados: items.filter(i => i.daysRemaining !== null && i.daysRemaining < 0 && !sm(i.status, "conclu")).length,
      flagged: items.filter(i => i.flagged).length,
      bloqueados: items.filter(i => i.blocked).length,
      porResponsavel: ["Erikson","Lucas","Rafael","Hamze","Vivahcare"].map(nome => ({
        nome, total: items.filter(i => i.assigneeGroup === nome).length,
      })),
    };
    const pctConcluido = kpis.total > 0 ? Math.round((kpis.concluido / kpis.total) * 100) : 0;
    const overallRag = kpis.atrasados > 5 ? "R" : kpis.atrasados > 0 ? "A" : "G";

    return {
      statusCode: 200,
      headers: { ...CORS, "Content-Type": "application/json" },
      body: JSON.stringify({
        sprint: sprintName, sprintStart, sprintEnd,
        geradoEm: new Date().toISOString(),
        kpis, pctConcluido, overallRag,
        itens: items,
        semResponsavelLabel: "Sem Responsável",
      }),
    };

  } catch (err) {
    return {
      statusCode: 500,
      headers: CORS,
      body: JSON.stringify({ error: err.message, stack: err.stack }),
    };
  }
};
