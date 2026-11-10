// Agrupa as tarefas do ClickUp em "baldes" de tempo e calcula métricas.
// Todo o cálculo de datas é feito no fuso de São Paulo.

import type { ClickUpTask } from "./clickup.js";

export const TIMEZONE = "America/Sao_Paulo";

export type BriefingMode = "daily" | "weekly";

/** Versão enxuta de uma tarefa, usada no relatório e enviada ao Claude. */
export interface AgendaTask {
  id: string;
  nome: string;
  lista: string;
  status: string;
  prioridade: "urgente" | "alta" | "normal" | "baixa" | "sem prioridade";
  prazo: string | null; // "YYYY-MM-DD"
  prazoLegivel: string | null; // "ter 10/11"
  estimativaMin: number | null;
  tags: string[];
  url: string;
}

export interface Agenda {
  mode: BriefingMode;
  hoje: string; // "YYYY-MM-DD"
  hojeLegivel: string;
  semanaAtual: { inicio: string; fim: string };
  semanaSeguinte: { inicio: string; fim: string };
  atrasadas: AgendaTask[];
  hojeTarefas: AgendaTask[];
  estaSemana: AgendaTask[];
  proximaSemana: AgendaTask[];
  maisTarde: AgendaTask[];
  semData: AgendaTask[];
  concluidasUltimos7Dias: AgendaTask[];
  metricas: AgendaMetrics;
}

export interface AgendaMetrics {
  totalAbertas: number;
  porLista: Record<string, number>;
  porPrioridade: Record<string, number>;
  cargaPorDiaMin: { dia: string; tarefas: number; minutosEstimados: number }[];
  concluidasUltimos7Dias: number;
  semPrazo: number;
  semPrioridade: number;
  semEstimativa: number;
  marcadasAutomatizaveis: number;
}

// ─── Helpers de data (fuso de São Paulo) ──────────────────────────

const keyFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: TIMEZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

const labelFormatter = new Intl.DateTimeFormat("pt-BR", {
  timeZone: TIMEZONE,
  weekday: "short",
  day: "2-digit",
  month: "2-digit",
});

/** "YYYY-MM-DD" no fuso de São Paulo. */
export function dateKey(ms: number): string {
  return keyFormatter.format(new Date(ms));
}

/** "ter., 10/11" → "ter 10/11" */
export function dateLabel(ms: number): string {
  return labelFormatter.format(new Date(ms)).replace(".", "").replace(",", "");
}

/** Soma dias a uma chave "YYYY-MM-DD" (aritmética de calendário, sem fuso). */
export function addDays(key: string, days: number): string {
  const [y, m, d] = key.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return dt.toISOString().slice(0, 10);
}

/** 0=domingo ... 6=sábado para uma chave "YYYY-MM-DD". */
function weekday(key: string): number {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/** Segunda-feira da semana que contém `key`. */
function mondayOf(key: string): string {
  const wd = weekday(key);
  return addDays(key, wd === 0 ? -6 : 1 - wd);
}

/** "2026-11-10" → "10/11" */
export function shortLabel(key: string): string {
  const [, m, d] = key.split("-");
  return `${d}/${m}`;
}

// ─── Conversão das tarefas ────────────────────────────────────────

const PRIORITY_MAP: Record<string, AgendaTask["prioridade"]> = {
  urgent: "urgente",
  high: "alta",
  normal: "normal",
  low: "baixa",
};

export function toAgendaTask(t: ClickUpTask): AgendaTask {
  const due = t.due_date ? Number(t.due_date) : null;
  return {
    id: t.id,
    nome: t.name,
    lista: t.list?.name ?? "?",
    status: t.status?.status ?? "?",
    prioridade: t.priority ? (PRIORITY_MAP[t.priority.priority] ?? "normal") : "sem prioridade",
    prazo: due ? dateKey(due) : null,
    prazoLegivel: due ? dateLabel(due) : null,
    estimativaMin: t.time_estimate ? Math.round(t.time_estimate / 60_000) : null,
    tags: (t.tags ?? []).map((tag) => tag.name),
    url: t.url,
  };
}

const PRIORITY_ORDER: Record<AgendaTask["prioridade"], number> = {
  urgente: 0,
  alta: 1,
  normal: 2,
  baixa: 3,
  "sem prioridade": 4,
};

function sortTasks(tasks: AgendaTask[]) {
  return tasks.sort(
    (a, b) =>
      (a.prazo ?? "9999").localeCompare(b.prazo ?? "9999") ||
      PRIORITY_ORDER[a.prioridade] - PRIORITY_ORDER[b.prioridade],
  );
}

// ─── Montagem da agenda ───────────────────────────────────────────

/**
 * @param openTasks tarefas abertas (sem a lista de Briefings)
 * @param doneTasks tarefas concluídas recentemente
 * @param mode "daily": semana atual = semana de hoje.
 *             "weekly" (roda domingo à noite): semana atual = a que começa amanhã.
 */
export function buildAgenda(
  openTasks: ClickUpTask[],
  doneTasks: ClickUpTask[],
  mode: BriefingMode,
  now: number = Date.now(),
): Agenda {
  const hoje = dateKey(now);
  const anchor = mode === "weekly" ? addDays(hoje, 1) : hoje;
  const semanaInicio = mondayOf(anchor);
  const semanaFim = addDays(semanaInicio, 6);
  const proxInicio = addDays(semanaInicio, 7);
  const proxFim = addDays(semanaInicio, 13);

  const agenda: Agenda = {
    mode,
    hoje,
    hojeLegivel: dateLabel(now),
    semanaAtual: { inicio: semanaInicio, fim: semanaFim },
    semanaSeguinte: { inicio: proxInicio, fim: proxFim },
    atrasadas: [],
    hojeTarefas: [],
    estaSemana: [],
    proximaSemana: [],
    maisTarde: [],
    semData: [],
    concluidasUltimos7Dias: doneTasks.map(toAgendaTask),
    metricas: {} as AgendaMetrics,
  };

  const abertas = openTasks.map(toAgendaTask);
  for (const t of abertas) {
    if (!t.prazo) agenda.semData.push(t);
    else if (t.prazo < hoje) agenda.atrasadas.push(t);
    else if (t.prazo === hoje) agenda.hojeTarefas.push(t);
    else if (t.prazo <= semanaFim) agenda.estaSemana.push(t);
    else if (t.prazo <= proxFim) agenda.proximaSemana.push(t);
    else agenda.maisTarde.push(t);
  }
  for (const bucket of [
    agenda.atrasadas,
    agenda.hojeTarefas,
    agenda.estaSemana,
    agenda.proximaSemana,
    agenda.maisTarde,
    agenda.semData,
  ]) {
    sortTasks(bucket);
  }

  agenda.metricas = computeMetrics(abertas, agenda, hoje);
  return agenda;
}

function computeMetrics(abertas: AgendaTask[], agenda: Agenda, hoje: string): AgendaMetrics {
  const porLista: Record<string, number> = {};
  const porPrioridade: Record<string, number> = {};
  for (const t of abertas) {
    porLista[t.lista] = (porLista[t.lista] ?? 0) + 1;
    porPrioridade[t.prioridade] = (porPrioridade[t.prioridade] ?? 0) + 1;
  }

  // Carga dos próximos 7 dias (hoje incluso), atrasadas somadas em "hoje".
  const cargaPorDiaMin: AgendaMetrics["cargaPorDiaMin"] = [];
  for (let i = 0; i < 7; i++) {
    const dia = addDays(hoje, i);
    const doDia = abertas.filter((t) => t.prazo === dia || (i === 0 && t.prazo !== null && t.prazo < hoje));
    cargaPorDiaMin.push({
      dia,
      tarefas: doDia.length,
      minutosEstimados: doDia.reduce((s, t) => s + (t.estimativaMin ?? 0), 0),
    });
  }

  return {
    totalAbertas: abertas.length,
    porLista,
    porPrioridade,
    cargaPorDiaMin,
    concluidasUltimos7Dias: agenda.concluidasUltimos7Dias.length,
    semPrazo: agenda.semData.length,
    semPrioridade: abertas.filter((t) => t.prioridade === "sem prioridade").length,
    semEstimativa: abertas.filter((t) => t.estimativaMin === null).length,
    marcadasAutomatizaveis: abertas.filter((t) => t.tags.includes("automatizavel")).length,
  };
}
