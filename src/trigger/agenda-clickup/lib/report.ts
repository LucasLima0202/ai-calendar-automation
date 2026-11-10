// Monta o conteúdo do briefing: HTML (email) e Markdown (tarefa no ClickUp).

import { dateKey, dateLabel, shortLabel, type Agenda, type AgendaTask } from "./agenda.js";
import type { Insights } from "./insights.js";
import type { Compromisso } from "../../google-agenda/lib/upcoming.js";

/** Compromissos do Google Agenda para o briefing (null = Google não configurado). */
export interface AgendaGoogle {
  compromissos: Compromisso[];
  livreHojeMin?: number;
  erro?: string;
}

const hourFmt = new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Sao_Paulo", hour: "2-digit", minute: "2-digit" });

/** Agrupa compromissos por dia: [["qua 12/11", ["14:00–15:00 Reunião X (Trabalho)", ...]], ...] */
function compromissosPorDia(google: AgendaGoogle): [string, string[]][] {
  const dias = new Map<string, string[]>();
  for (const c of google.compromissos) {
    const ms = c.diaInteiro ? Date.parse(`${c.inicio}T12:00:00-03:00`) : Date.parse(c.inicio);
    const hora = c.diaInteiro ? "dia inteiro" : `${hourFmt.format(new Date(c.inicio))}–${hourFmt.format(new Date(c.fim))}`;
    const linha = `${hora} ${c.titulo} (${c.calendario})${c.local ? ` · ${c.local}` : ""}`;
    const key = `${dateKey(ms)}|${dateLabel(ms)}`;
    dias.set(key, [...(dias.get(key) ?? []), linha]);
  }
  return [...dias.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k.split("|")[1], v]);
}

export interface Report {
  subject: string;
  taskTitle: string;
  html: string;
  markdown: string;
}

const PRIORITY_EMOJI: Record<AgendaTask["prioridade"], string> = {
  urgente: "🔴",
  alta: "🟠",
  normal: "🔵",
  baixa: "⚪",
  "sem prioridade": "▫️",
};

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function fmtMin(min: number): string {
  if (min < 60) return `${min}min`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${h}h${String(m).padStart(2, "0")}` : `${h}h`;
}

function taskMeta(t: AgendaTask, showDate: boolean): string {
  const parts = [t.lista];
  if (showDate && t.prazoLegivel) parts.unshift(t.prazoLegivel);
  if (t.estimativaMin) parts.push(fmtMin(t.estimativaMin));
  return parts.join(" · ");
}

interface Section {
  title: string;
  tasks: AgendaTask[];
  showDate: boolean;
}

function sectionsFor(agenda: Agenda): Section[] {
  const semana = `${shortLabel(agenda.semanaAtual.inicio)}–${shortLabel(agenda.semanaAtual.fim)}`;
  const prox = `${shortLabel(agenda.semanaSeguinte.inicio)}–${shortLabel(agenda.semanaSeguinte.fim)}`;
  const all: Section[] = [
    { title: "⚠️ Atrasadas", tasks: agenda.atrasadas, showDate: true },
    { title: "📌 Hoje", tasks: agenda.hojeTarefas, showDate: false },
    {
      title: agenda.mode === "weekly" ? `🗓️ Semana que começa (${semana})` : `🗓️ Resto desta semana (${semana})`,
      tasks: agenda.estaSemana,
      showDate: true,
    },
    { title: `⏭️ Próxima semana (${prox})`, tasks: agenda.proximaSemana, showDate: true },
    { title: "📥 Sem prazo definido", tasks: agenda.semData, showDate: false },
  ];
  // No diário, "hoje" sempre aparece (mesmo vazio); os demais só se tiverem algo.
  return all.filter((s) => s.tasks.length > 0 || (agenda.mode === "daily" && s.title.includes("Hoje")));
}

export function buildReport(
  agenda: Agenda,
  insights: Insights | null,
  insightsError?: string,
  google: AgendaGoogle | null = null,
): Report {
  const isDaily = agenda.mode === "daily";
  const dia = shortLabel(agenda.hoje);
  const subject = isDaily
    ? `☀️ Seu dia — ${agenda.hojeLegivel}`
    : `📅 Sua semana — ${shortLabel(agenda.semanaAtual.inicio)} a ${shortLabel(agenda.semanaAtual.fim)}`;
  const taskTitle = isDaily ? `Briefing diário ${dia}` : `Briefing semanal ${dia}`;
  const sections = sectionsFor(agenda);
  const m = agenda.metricas;
  const vazio = m.totalAbertas === 0;

  // ─── Markdown (ClickUp) ───
  const md: string[] = [];
  if (insights) {
    md.push(`## Resumo`, insights.resumo, "");
    if (insights.foco.length) {
      md.push(`## 🎯 Foco`);
      insights.foco.forEach((f, i) => md.push(`${i + 1}. **${f.tarefa}** — ${f.motivo}`));
      md.push("");
    }
    if (insights.alertas.length) {
      md.push(`## 🚨 Alertas`, ...insights.alertas.map((a) => `- ${a}`), "");
    }
  } else if (vazio) {
    md.push(`## Agenda livre`, "Nenhuma tarefa aberta no ClickUp. Cadastre suas tarefas com prazo e prioridade para receber insights.", "");
  }
  if (insightsError) md.push(`> ⚠️ Insights da IA indisponíveis nesta execução: ${insightsError}`, "");
  const livreHoje =
    google?.livreHojeMin !== undefined && isDaily ? ` · livre hoje (8h–20h): ${fmtMin(Math.max(0, google.livreHojeMin))}` : "";
  if (google) {
    md.push(`## 📆 Compromissos${livreHoje}`);
    if (google.erro) md.push(`_Não consegui ler o Google Agenda: ${google.erro}_`);
    else if (!google.compromissos.length) md.push("_Nenhum compromisso marcado._");
    for (const [dia, linhas] of compromissosPorDia(google)) md.push(`**${dia}**`, ...linhas.map((l) => `- ${l}`));
    md.push("");
  }
  for (const s of sections) {
    md.push(`## ${s.title} (${s.tasks.length})`);
    if (!s.tasks.length) md.push("_Nada para hoje._");
    for (const t of s.tasks) {
      md.push(`- ${PRIORITY_EMOJI[t.prioridade]} [${t.nome}](${t.url}) — ${taskMeta(t, s.showDate)}`);
    }
    md.push("");
  }
  md.push(
    `## 📊 Números`,
    `- Abertas: **${m.totalAbertas}** · Concluídas nos últimos 7 dias: **${m.concluidasUltimos7Dias}**`,
    `- Sem prazo: ${m.semPrazo} · Sem prioridade: ${m.semPrioridade} · Sem estimativa: ${m.semEstimativa}`,
    "",
  );
  if (insights?.insights.length) md.push(`## 💡 Insights`, ...insights.insights.map((i) => `- ${i}`), "");
  if (insights?.ideiasAutomacao.length) {
    md.push(`## 🤖 Ideias de automação`);
    for (const idea of insights.ideiasAutomacao) {
      md.push(`- **${idea.titulo}** (${idea.ganhoEstimado}) — ${idea.descricao} _Ferramenta: ${idea.ferramenta}_`);
    }
    md.push("");
  }

  // ─── HTML (email) ───
  const h: string[] = [];
  const box = (inner: string, bg = "#f6f7fb") =>
    `<div style="background:${bg};border-radius:10px;padding:14px 16px;margin:0 0 16px">${inner}</div>`;
  const h2 = (t: string) => `<h2 style="font-size:16px;margin:20px 0 8px;color:#1f2937">${esc(t)}</h2>`;

  h.push(`<div style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;max-width:620px;margin:0 auto;color:#111827;line-height:1.5">`);
  h.push(`<h1 style="font-size:20px;margin:0 0 12px">${esc(subject)}</h1>`);

  if (insights) {
    h.push(box(`<p style="margin:0">${esc(insights.resumo)}</p>`));
    if (insights.foco.length) {
      h.push(h2("🎯 Foco"));
      h.push(
        `<ol style="padding-left:20px;margin:0">${insights.foco
          .map((f) => `<li style="margin-bottom:6px"><b>${esc(f.tarefa)}</b> — ${esc(f.motivo)}</li>`)
          .join("")}</ol>`,
      );
    }
    if (insights.alertas.length) {
      h.push(h2("🚨 Alertas"));
      h.push(box(`<ul style="padding-left:18px;margin:0">${insights.alertas.map((a) => `<li>${esc(a)}</li>`).join("")}</ul>`, "#fef2f2"));
    }
  } else if (vazio) {
    h.push(box(`<p style="margin:0"><b>Agenda livre.</b> Nenhuma tarefa aberta no ClickUp. Cadastre suas tarefas com prazo, prioridade e estimativa para receber insights.</p>`));
  }
  if (insightsError) {
    h.push(box(`<p style="margin:0;font-size:13px">⚠️ Insights da IA indisponíveis nesta execução (${esc(insightsError)}). Abaixo, a agenda completa.</p>`, "#fffbeb"));
  }

  if (google) {
    h.push(h2(`📆 Compromissos${livreHoje}`));
    if (google.erro) h.push(`<p style="margin:0;color:#b45309;font-size:13px">Não consegui ler o Google Agenda: ${esc(google.erro)}</p>`);
    else if (!google.compromissos.length) h.push(`<p style="margin:0;color:#6b7280">Nenhum compromisso marcado.</p>`);
    for (const [dia, linhas] of compromissosPorDia(google)) {
      h.push(
        `<p style="margin:8px 0 4px;font-weight:600">${esc(dia)}</p><ul style="padding-left:18px;margin:0">${linhas
          .map((l) => `<li style="font-size:14px">${esc(l)}</li>`)
          .join("")}</ul>`,
      );
    }
  }
  for (const s of sections) {
    h.push(h2(`${s.title} (${s.tasks.length})`));
    if (!s.tasks.length) {
      h.push(`<p style="margin:0;color:#6b7280">Nada para hoje.</p>`);
      continue;
    }
    h.push(
      `<ul style="list-style:none;padding:0;margin:0">${s.tasks
        .map(
          (t) =>
            `<li style="padding:6px 0;border-bottom:1px solid #eee">${PRIORITY_EMOJI[t.prioridade]} <a href="${esc(t.url)}" style="color:#111827;text-decoration:none"><b>${esc(t.nome)}</b></a><br><span style="font-size:12px;color:#6b7280">${esc(taskMeta(t, s.showDate))}</span></li>`,
        )
        .join("")}</ul>`,
    );
  }

  h.push(h2("📊 Números"));
  h.push(
    box(
      `<p style="margin:0;font-size:14px">Abertas: <b>${m.totalAbertas}</b> · Concluídas (7 dias): <b>${m.concluidasUltimos7Dias}</b><br>Sem prazo: ${m.semPrazo} · Sem prioridade: ${m.semPrioridade} · Sem estimativa: ${m.semEstimativa}</p>`,
    ),
  );

  if (insights?.insights.length) {
    h.push(h2("💡 Insights"));
    h.push(`<ul style="padding-left:18px;margin:0">${insights.insights.map((i) => `<li style="margin-bottom:6px">${esc(i)}</li>`).join("")}</ul>`);
  }
  if (insights?.ideiasAutomacao.length) {
    h.push(h2("🤖 Ideias de automação"));
    h.push(
      insights.ideiasAutomacao
        .map((i) =>
          box(
            `<b>${esc(i.titulo)}</b> <span style="font-size:12px;color:#6b7280">(${esc(i.ganhoEstimado)})</span><br><span style="font-size:14px">${esc(i.descricao)}</span><br><span style="font-size:12px;color:#6b7280">Ferramenta: ${esc(i.ferramenta)}</span>`,
            "#eef6ff",
          ),
        )
        .join(""),
    );
  }

  h.push(`<p style="font-size:11px;color:#9ca3af;margin-top:24px">Gerado automaticamente pelo Trigger.dev a partir do seu ClickUp.</p></div>`);

  return { subject, taskTitle, html: h.join("\n"), markdown: md.join("\n") };
}
