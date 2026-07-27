# PMO Report — Projeto Vivahcare

Relatório executivo PMO gerado dinamicamente a partir do Jira (projeto VVO), hospedado no Netlify.

## Arquivos

| Arquivo | Descrição |
|---|---|
| `report-viva.html` | Página principal do relatório — abre no browser |
| `netlify/functions/jira-proxy.js` | Netlify Function que faz proxy para a API do Jira (evita CORS) |
| `netlify.toml` | Configuração do Netlify (Node 18, pasta de functions) |

## Como funciona

1. O usuário acessa `report-viva.html` no Netlify
2. Clica em **"Atualizar do Jira"**
3. O HTML chama `/.netlify/functions/jira-proxy` (server-side)
4. A Function autentica no Jira com as variáveis de ambiente e busca os itens da sprint ativa (`openSprints()`)
5. Os dados são processados e o relatório é renderizado na tela

## Seções do relatório

| # | Seção | Descrição |
|---|---|---|
| 1 | Capa | Nome do projeto, sprint, período, data de geração |
| 2 | Resumo Executivo | KPIs: progresso %, total de itens, atrasados, bloqueados |
| 7 | Roadmap — Histórias e Tarefas | Gantt SVG com Histórias e Tarefas não concluídas (07/07–10/08/2026) |

## Variáveis de ambiente no Netlify

Configurar em: **Project configuration → Environment variables**

| Variável | Valor |
|---|---|
| `JIRA_EMAIL` | E-mail da conta Atlassian |
| `JIRA_API_TOKEN` | Token gerado em [id.atlassian.com/manage-profile/security/api-tokens](https://id.atlassian.com/manage-profile/security/api-tokens) |
| `JIRA_BASE_URL` | `https://vivahcare.atlassian.net` |

## Filtros do Roadmap

- Somente **Histórias** e **Tarefas** (sem épicos, sem subtarefas)
- Status: **"Tarefas pendentes"** ou **"Em andamento"**
- Se tiver subtarefas: ao menos **1 subtarefa não concluída**
- Período visível: **07/07/2026 a 10/08/2026**
- Ordenação: por **data de início**, depois por **data de fim**
- Cores: 🟠 laranja = Em andamento / ⬜ cinza = Tarefas pendentes

## Deploy

O site está conectado ao repositório `MarcosBelomo/Gantt_Jira` no Netlify:
- URL: `https://elaborate-kelpie-d72e84.netlify.app/report-viva.html`
- Deploy automático a cada push no branch `main`

## Botão Gerar PDF

Clique em **"Gerar PDF"** → abre o diálogo de impressão do browser → selecione **"Salvar como PDF"** (A4 paisagem).
