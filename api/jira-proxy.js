// api/jira-proxy.js — Vercel Serverless Function
// Proxy server-side para a API do Jira (sem CORS no browser)
// Variáveis de ambiente no Vercel: JIRA_EMAIL, JIRA_API_TOKEN, JIRA_BASE_URL

const https = require("https");

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

module.exports = async (req, res) => {
  // CORS preflight
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(204).end();

  const { JIRA_EMAIL, JIRA_API_TOKEN, JIRA_BASE_URL } = process.env;

  if (!JIRA_EMAIL || !JIRA_API_TOKEN || !JIRA_BASE_URL) {
    return res.status(500).json({
      error: "Variáveis de ambiente não configuradas no Vercel: JIRA_EMAIL, JIRA_API_TOKEN, JIRA_BASE_URL",
    });
  }

  const auth = Buffer.from(`${JIRA_EMAIL}:${JIRA_API_TOKEN}`).toString("base64");
  const headers = {
    Authorization: `Basic ${auth}`,
    Accept: "application/json",
    "Content-Type": "application/json",
  };

  const post = (path, body) =>
    httpsReq(`${JIRA_BASE_URL}${path}`, "POST", headers, JSON.stringify(body));

  try {
    // 1. Busca sprint ativa e itens
    let sprintName = "Sprint Ativa";
    let sprintStart = null;
    let sprintEnd = null;
    const allIssues = [];
    let startAt = 0;

    while (true) {
      const r = await post("/rest/api/3/search/jql", {
        jql: "project = VVO AND sprint in openSprints() ORDER BY key ASC",
        maxResults: 100,
        startAt,
        fields: [
          "summary", "status", "assignee", "issuetype", "parent",
          "customfield_10015", "duedate", "customfield_10020",
          "customfield_10021", "labels", "subtasks",
        ],
      });

      if (r.status !== 200) {
        return res.status(r.status).json({
          error: `Jira retornou ${r.status}`,
          detail: typeof r.body === "string" ? r.body : JSON.stringify(r.body),
        });
      }

      const batch = r.body.issues || [];
      allIssues.push(...batch);

      // Extrai info da sprint do primeiro item
      if (!sprintStart && batch.length > 0) {
        const sprints = batch[0].fields?.customfield_10020 || [];
        const active = sprints.find((s) => s.state === "active") || sprints[0];
        if (active) {
          sprintName = active.name;
          sprintStart = active.startDate?.slice(0, 10);
          sprintEnd = active.endDate?.slice(0, 10);
        }
      }

      if (batch.length < 100 || allIssues.length >= (r.body.total || 0)) break;
      startAt += 100;
    }

    // 2. Mapeia itens
    const GRUPOS = {
      Erikson: ["Erikson"], Lucas: ["Lucas"], Rafael: ["Rafael"],
      Hamze: ["Hamze"], Vivahcare: ["Vivahcare"],
    };
    const today = new Date(); today.setHours(0, 0, 0, 0);

    const itens = allIssues.map((issue) => {
      const f = issue.fields;
      const assigneeName = f.assignee?.displayName || null;
      let assigneeGroup = "Sem Responsável";
      if (assigneeName) {
        for (const [g, kws] of Object.entries(GRUPOS)) {
          if (kws.some((k) => assigneeName.toLowerCase().includes(k.toLowerCase()))) {
            assigneeGroup = g; break;
          }
        }
      }
      const dueDate = f.duedate || null;
      const daysRemaining = dueDate
        ? Math.ceil((new Date(dueDate) - today) / 86400000)
        : null;
      const labels = f.labels || [];

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
        sprint: sprintName,
      };
    });

    // 3. KPIs
    const sm = (s, rx) => s && new RegExp(rx, "i").test(s);
    const kpis = {
      total: itens.length,
      emAndamento: itens.filter((i) => sm(i.status, "andamento")).length,
      tarefasPendentes: itens.filter((i) => sm(i.status, "tarefas pendentes")).length,
      concluido: itens.filter((i) => sm(i.status, "conclu")).length,
      atrasados: itens.filter((i) => i.daysRemaining !== null && i.daysRemaining < 0 && !sm(i.status, "conclu")).length,
      bloqueados: itens.filter((i) => i.blocked).length,
      porResponsavel: ["Erikson", "Lucas", "Rafael", "Hamze", "Vivahcare"].map((nome) => ({
        nome,
        total: itens.filter((i) => i.assigneeGroup === nome).length,
      })),
    };

    const pctConcluido = kpis.total > 0
      ? Math.round((kpis.concluido / kpis.total) * 100)
      : 0;

    return res.status(200).json({
      sprint: sprintName,
      sprintStart,
      sprintEnd,
      geradoEm: new Date().toISOString(),
      kpis,
      pctConcluido,
      itens,
    });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
