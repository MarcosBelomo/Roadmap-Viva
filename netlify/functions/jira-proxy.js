// netlify/functions/jira-proxy.js
// Proxy server-side para a API do Jira — evita CORS no browser.
// Variáveis de ambiente necessárias no Netlify:
//   JIRA_EMAIL, JIRA_API_TOKEN, JIRA_BASE_URL

exports.handler = async (event) => {
  const CORS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: CORS, body: "" };
  }

  const { JIRA_EMAIL, JIRA_API_TOKEN, JIRA_BASE_URL } = process.env;

  if (!JIRA_EMAIL || !JIRA_API_TOKEN || !JIRA_BASE_URL) {
    return {
      statusCode: 500,
      headers: CORS,
      body: JSON.stringify({ error: "Variáveis de ambiente do Jira não configuradas no Netlify." }),
    };
  }

  const auth = Buffer.from(`${JIRA_EMAIL}:${JIRA_API_TOKEN}`).toString("base64");
  const headers = {
    Authorization: `Basic ${auth}`,
    Accept: "application/json",
    "Content-Type": "application/json",
  };

  try {
    // 1. Descobre sprint ativa
    const probeRes = await fetch(`${JIRA_BASE_URL}/rest/api/3/search/jql`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        jql: "project = VVO AND sprint is not EMPTY ORDER BY key DESC",
        maxResults: 50,
        fields: ["customfield_10020"],
      }),
    });
    const probeData = await probeRes.json();

    const sprintMap = {};
    for (const issue of probeData.issues || []) {
      for (const s of issue.fields?.customfield_10020 || []) {
        sprintMap[s.id] = s;
      }
    }

    const activeSprint = Object.values(sprintMap)
      .filter((s) => s.state === "active")
      .sort((a, b) => new Date(b.startDate) - new Date(a.startDate))[0];

    if (!activeSprint) {
      return {
        statusCode: 404,
        headers: CORS,
        body: JSON.stringify({ error: "Nenhuma sprint ativa encontrada no projeto VVO." }),
      };
    }

    const sprintName = activeSprint.name;
    const sprintStart = activeSprint.startDate?.slice(0, 10);
    const sprintEnd = activeSprint.endDate?.slice(0, 10);

    // 2. Busca todos os itens da sprint
    const allIssues = [];
    let nextPageToken = null;
    do {
      const body = {
        jql: `project = VVO AND sprint = "${sprintName}" ORDER BY key ASC`,
        maxResults: 100,
        fields: [
          "summary", "status", "assignee", "issuetype", "parent",
          "customfield_10015", "duedate", "customfield_10020",
          "customfield_10014", "priority", "customfield_10021",
          "labels", "subtasks",
        ],
      };
      if (nextPageToken) body.nextPageToken = nextPageToken;

      const res = await fetch(`${JIRA_BASE_URL}/rest/api/3/search/jql`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });
      const data = await res.json();
      allIssues.push(...(data.issues || []));
      nextPageToken = data.nextPageToken || null;
    } while (nextPageToken);

    // 3. Processa KPIs
    const ASSIGNEE_MAP = {
      Erikson: ["Erikson"],
      Lucas: ["Lucas"],
      Rafael: ["Rafael"],
      Hamze: ["Hamze"],
      Vivahcare: ["Vivahcare"],
    };

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const items = allIssues.map((issue) => {
      const f = issue.fields;
      const assigneeName = f.assignee?.displayName || null;
      let assigneeGroup = "Sem Responsável";
      if (assigneeName) {
        for (const [group, keywords] of Object.entries(ASSIGNEE_MAP)) {
          if (keywords.some((k) => assigneeName.toLowerCase().includes(k.toLowerCase()))) {
            assigneeGroup = group;
            break;
          }
        }
      }
      const dueDate = f.duedate || null;
      let daysRemaining = null;
      if (dueDate) {
        const due = new Date(dueDate);
        daysRemaining = Math.ceil((due - today) / 86400000);
      }
      const labels = f.labels || [];
      return {
        key: issue.key,
        type: f.issuetype?.name,
        isSubtask: f.issuetype?.subtask || false,
        parentKey: f.parent?.key || null,
        parentSummary: f.parent?.fields?.summary || null,
        summary: f.summary,
        assignee: assigneeName,
        assigneeGroup,
        status: f.status?.name,
        startDate: f.customfield_10015 || null,
        dueDate,
        daysRemaining,
        flagged: !!f.customfield_10021,
        blocked: labels.includes("blocked") || labels.includes("impediment"),
        dependency: labels.includes("dependency"),
        sprint: sprintName,
      };
    });

    const statusMatch = (s, rx) => s && new RegExp(rx, "i").test(s);
    const kpis = {
      total: items.length,
      backlog: items.filter((i) => statusMatch(i.status, "backlog")).length,
      tarefasPendentes: items.filter((i) => statusMatch(i.status, "tarefas pendentes")).length,
      todo: items.filter((i) => statusMatch(i.status, "to ?do")).length,
      emAndamento: items.filter((i) => statusMatch(i.status, "andamento")).length,
      qa: items.filter((i) => statusMatch(i.status, "^qa$")).length,
      concluido: items.filter((i) => statusMatch(i.status, "conclu")).length,
      atrasados: items.filter((i) => i.daysRemaining !== null && i.daysRemaining < 0 && !statusMatch(i.status, "conclu")).length,
      flagged: items.filter((i) => i.flagged).length,
      bloqueados: items.filter((i) => i.blocked).length,
      porResponsavel: ["Erikson", "Lucas", "Rafael", "Hamze", "Vivahcare"].map((nome) => ({
        nome,
        total: items.filter((i) => i.assigneeGroup === nome).length,
      })),
    };

    const concluido = kpis.concluido;
    const total = kpis.total;
    const pctConcluido = total > 0 ? Math.round((concluido / total) * 100) : 0;
    const atrasados = kpis.atrasados;
    const bloqueados = kpis.bloqueados;

    // RAG por frente
    const workstreams = [
      { nome: "Escopo", rag: pctConcluido >= 70 ? "G" : pctConcluido >= 50 ? "A" : "R", nota: `${pctConcluido}% das tarefas concluídas` },
      { nome: "Cronograma", rag: atrasados === 0 ? "G" : atrasados <= 5 ? "A" : "R", nota: `${atrasados} itens atrasados` },
      { nome: "Qualidade", rag: bloqueados === 0 ? "G" : bloqueados <= 3 ? "A" : "R", nota: `${bloqueados} itens bloqueados` },
      { nome: "Equipe/Recursos", rag: "G", nota: "5 responsáveis ativos na sprint" },
      { nome: "Integração ESUS/APS", rag: items.filter((i) => i.blocked && (i.summary || "").toLowerCase().includes("esus")).length > 0 ? "R" : "A", nota: "Itens de relatórios/integração com pendências" },
    ];

    const overallRag = workstreams.some((w) => w.rag === "R") ? "R" : workstreams.some((w) => w.rag === "A") ? "A" : "G";

    // Riscos — itens bloqueados com maior destaque
    const riscos = items
      .filter((i) => i.blocked || i.flagged)
      .slice(0, 6)
      .map((i) => ({
        descricao: i.summary,
        impacto: i.flagged ? "Alto" : "Médio",
        prob: "Média",
        mitigacao: "Acompanhamento diário no standup",
        responsavel: i.assignee || "A definir",
      }));

    // Marcos
    const marcos = [
      { nome: "Início SP6", data: sprintStart, status: "done" },
      { nome: `${pctConcluido}% concluído`, data: today.toISOString().slice(0, 10), status: "current" },
      { nome: "Fim SP6 / Pré-implantação", data: sprintEnd, status: "pending" },
    ];

    // Próximos passos — itens em andamento ou pendentes sem data
    const proximosPassos = items
      .filter((i) => statusMatch(i.status, "andamento") || (statusMatch(i.status, "pendentes") && i.blocked))
      .slice(0, 5)
      .map((i) => ({
        acao: i.summary,
        responsavel: i.assignee || "A definir",
        data: i.dueDate || "A definir",
      }));

    return {
      statusCode: 200,
      headers: { ...CORS, "Content-Type": "application/json" },
      body: JSON.stringify({
        sprint: sprintName,
        sprintStart,
        sprintEnd,
        geradoEm: new Date().toISOString(),
        kpis,
        pctConcluido,
        overallRag,
        workstreams,
        riscos,
        marcos,
        proximosPassos,
      }),
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers: CORS,
      body: JSON.stringify({ error: err.message }),
    };
  }
};
