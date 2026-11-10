// As áreas da agenda: um calendário do Google para cada uma (mesmas áreas das listas do ClickUp).

export const AREAS = {
  trabalho: {
    nome: "Trabalho",
    cor: "#4285F4",
    envVar: "GCAL_CAL_TRABALHO_ID",
    descricao: "Reuniões e compromissos de trabalho.",
  },
  estudos: {
    nome: "Estudos & Projetos",
    cor: "#8E24AA",
    envVar: "GCAL_CAL_ESTUDOS_ID",
    descricao: "Aulas, cursos, desafios e projetos pessoais.",
  },
  pessoal: {
    nome: "Pessoal",
    cor: "#33B679",
    envVar: "GCAL_CAL_PESSOAL_ID",
    descricao: "Saúde, família, casa, lazer e compromissos pessoais.",
  },
  tarefas: {
    nome: "Tarefas (ClickUp)",
    cor: "#F6BF26",
    envVar: "GCAL_CAL_TAREFAS_ID",
    descricao: "Preenchido automaticamente pela sincronização do ClickUp. Não crie eventos aqui.",
  },
} as const;

export type AreaKey = keyof typeof AREAS;
/** Áreas para onde a auditoria pode mover eventos (o calendário do ClickUp é só da sincronização). */
export const CLASSIFIABLE_AREAS = ["trabalho", "estudos", "pessoal"] as const;
export type ClassifiableArea = (typeof CLASSIFIABLE_AREAS)[number];

/** IDs dos calendários das áreas, lidos das env vars (preenchidas após `gcal-setup-calendars`). */
export function getAreaCalendarIds(): Record<AreaKey, string> {
  const out = {} as Record<AreaKey, string>;
  for (const [key, area] of Object.entries(AREAS) as [AreaKey, (typeof AREAS)[AreaKey]][]) {
    const id = process.env[area.envVar];
    if (!id) throw new Error(`${area.envVar} is not set (rode a task gcal-setup-calendars primeiro)`);
    out[key] = id;
  }
  return out;
}
