// Fluxo completo de um briefing (usado pelas tasks diária e semanal).

import { logger } from "@trigger.dev/sdk";
import { addDays, buildAgenda, dateKey, type BriefingMode } from "./agenda.js";
import { busyMinutes, getCompromissos, googleConfigured } from "../../google-agenda/lib/upcoming.js";
import type { AgendaGoogle } from "./report.js";
import { createTask, getClickUpToken, getTeamTasks } from "./clickup.js";
import { sendEmail } from "./email.js";
import { generateInsights, type Insights } from "./insights.js";
import { buildReport } from "./report.js";

const MAX_IDEIAS_POR_SEMANA = 3;

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

/** Normaliza nomes para comparar ideias ("Automatizar X!" == "automatizar x"). */
function normalize(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export async function runBriefing(mode: BriefingMode, now: number) {
  // Valida todas as variáveis antes de fazer qualquer coisa.
  const token = getClickUpToken();
  const teamId = requireEnv("CLICKUP_TEAM_ID");
  const spaceId = requireEnv("CLICKUP_SPACE_ID");
  const briefingsListId = requireEnv("CLICKUP_LIST_BRIEFINGS_ID");
  const ideiasListId = requireEnv("CLICKUP_LIST_IDEIAS_ID");
  requireEnv("GEMINI_API_KEY");
  requireEnv("RESEND_API_KEY");
  requireEnv("BRIEFING_EMAIL_TO");

  // 1. Coleta
  const sevenDaysAgo = now - 7 * 24 * 60 * 60 * 1000;
  const [abertasRaw, concluidasRaw] = [
    await getTeamTasks(token, teamId, { spaceIds: [spaceId], includeClosed: false }),
    await getTeamTasks(token, teamId, { spaceIds: [spaceId], includeClosed: true, dateDoneGt: sevenDaysAgo }),
  ];
  // Briefings e Ideias de Automação não entram na agenda (são listas de apoio).
  const isBriefing = (listId: string) => listId === briefingsListId || listId === ideiasListId;
  const abertas = abertasRaw.filter((t) => !isBriefing(t.list.id) && t.status.type !== "closed" && t.status.type !== "done");
  const concluidas = concluidasRaw.filter(
    (t) => !isBriefing(t.list.id) && (t.status.type === "closed" || t.status.type === "done"),
  );
  const ideiasTasks = abertasRaw.concat(concluidasRaw).filter((t) => t.list.id === ideiasListId);
  const ideiasExistentes = [...new Set(ideiasTasks.map((t) => t.name))];
  // Ideias que a própria IA já criou nos últimos 7 dias (contam para o limite semanal).
  const ideiasIaRecentes = new Set(
    ideiasTasks
      .filter((t) => t.tags.some((tag) => tag.name === "sugestao-ia") && Number(t.date_created) > sevenDaysAgo)
      .map((t) => t.id),
  ).size;

  logger.info("Tarefas coletadas", {
    abertas: abertas.length,
    concluidas7d: concluidas.length,
    ideiasExistentes: ideiasExistentes.length,
    ideiasIaUltimos7Dias: ideiasIaRecentes,
  });

  // 2. Agrupamento + métricas
  const agenda = buildAgenda(abertas, concluidas, mode, now);

  // 2b. Compromissos do Google Agenda (opcional — se falhar, o briefing sai sem essa seção)
  let google: AgendaGoogle | null = null;
  if (googleConfigured()) {
    // Brasil não tem horário de verão desde 2019, então -03:00 é fixo.
    const sp = (key: string, hm = "00:00") => Date.parse(`${key}T${hm}:00-03:00`);
    const [de, ate] =
      mode === "daily"
        ? [sp(agenda.hoje), sp(addDays(agenda.hoje, 2))] // hoje + amanhã
        : [sp(agenda.semanaAtual.inicio), sp(addDays(agenda.semanaAtual.fim, 1))];
    try {
      const compromissos = await getCompromissos(de, ate);
      const livreHojeMin = 12 * 60 - busyMinutes(compromissos, sp(agenda.hoje, "08:00"), sp(agenda.hoje, "20:00"));
      google = { compromissos, livreHojeMin };
      logger.info("Compromissos do Google lidos", { total: compromissos.length, livreHojeMin });
    } catch (err) {
      const erro = err instanceof Error ? err.message.slice(0, 200) : String(err);
      logger.error("Falha ao ler o Google Agenda — briefing segue sem compromissos", { erro });
      google = { compromissos: [], erro };
    }
  }

  // 3. Insights (se falhar, o briefing sai mesmo assim, sem IA)
  let insights: Insights | null = null;
  let insightsError: string | undefined;
  if (agenda.metricas.totalAbertas === 0 && concluidas.length === 0) {
    logger.info("Agenda vazia — pulando chamada à IA");
  } else {
    try {
      insights = await generateInsights(agenda, ideiasExistentes, google?.compromissos ?? []);
    } catch (err) {
      insightsError = err instanceof Error ? err.message.slice(0, 200) : "erro desconhecido";
      logger.error("Falha ao gerar insights — enviando briefing sem IA", { error: insightsError });
    }
  }

  // 4. Relatório
  const report = buildReport(agenda, insights, insightsError, google);

  // 5. Tarefa de briefing no ClickUp (não duplica se a run for reexecutada)
  const briefingsHoje = await getTeamTasks(token, teamId, { listIds: [briefingsListId], includeClosed: true });
  const jaExiste = briefingsHoje.find((t) => t.name === report.taskTitle && dateKey(Number(t.date_created)) === dateKey(now));
  let briefingTaskUrl = jaExiste?.url;
  if (jaExiste) {
    logger.info("Tarefa de briefing já existe para hoje — não vou duplicar", { url: jaExiste.url });
  } else {
    const created = await createTask(token, briefingsListId, {
      name: report.taskTitle,
      markdown_content: report.markdown,
      tags: ["briefing"],
    });
    briefingTaskUrl = created.url;
  }

  // 6. Ideias de automação (somente no semanal), sem duplicar
  const ideiasCriadas: string[] = [];
  if (mode === "weekly" && insights) {
    const existentes = new Set(ideiasExistentes.map(normalize));
    const vagas = Math.max(0, MAX_IDEIAS_POR_SEMANA - ideiasIaRecentes);
    if (vagas === 0) logger.info("Limite semanal de ideias já atingido — não vou criar novas", { ideiasIaRecentes });
    for (const ideia of insights.ideiasAutomacao) {
      if (ideiasCriadas.length >= vagas) break;
      if (existentes.has(normalize(ideia.titulo))) {
        logger.info("Ideia já existe, pulando", { titulo: ideia.titulo });
        continue;
      }
      await createTask(token, ideiasListId, {
        name: ideia.titulo,
        markdown_content: `${ideia.descricao}\n\n**Ferramenta sugerida:** ${ideia.ferramenta}\n**Ganho estimado:** ${ideia.ganhoEstimado}\n\n_Sugerida pela IA no ${report.taskTitle}._`,
        tags: ["sugestao-ia", "automatizavel"],
        priority: 4,
      });
      existentes.add(normalize(ideia.titulo));
      ideiasCriadas.push(ideia.titulo);
    }
  }

  // 7. Email (chave de idempotência = título do briefing; Resend guarda por 24h)
  const email = await sendEmail({
    subject: report.subject,
    html: report.html,
    idempotencyKey: `agenda-${mode}-${dateKey(now)}`,
  });

  return {
    modo: mode,
    dia: agenda.hoje,
    tarefasAbertas: agenda.metricas.totalAbertas,
    atrasadas: agenda.atrasadas.length,
    hoje: agenda.hojeTarefas.length,
    estaSemana: agenda.estaSemana.length,
    proximaSemana: agenda.proximaSemana.length,
    comInsightsIA: insights !== null,
    compromissosGoogle: google ? (google.erro ? `erro: ${google.erro}` : google.compromissos.length) : "não configurado",
    briefingTaskUrl,
    ideiasCriadas,
    emailId: email.id,
  };
}

/** Aceita Date (agendamento real) ou string (disparo manual pela API/dashboard). */
export function toEpoch(value: Date | string | undefined): number {
  const ms = value ? new Date(value).getTime() : NaN;
  return Number.isNaN(ms) ? Date.now() : ms;
}
