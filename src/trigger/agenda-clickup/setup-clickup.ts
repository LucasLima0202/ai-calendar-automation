import { logger, task } from "@trigger.dev/sdk";
import { addDays, dateKey } from "./lib/agenda.js";
import {
  createFolderlessList,
  createSpace,
  createSpaceTag,
  createTask,
  getClickUpToken,
  getFolderlessLists,
  getSpaces,
  getSpaceTags,
  getTeamTasks,
  getWorkspaces,
  type NewTask,
} from "./lib/clickup.js";

const SPACE_NAME = "Minha Agenda";

const LISTS = [
  { key: "trabalho", name: "Trabalho", content: "Tarefas do trabalho e clientes." },
  { key: "projetos", name: "Projetos & Estudos", content: "Cursos, desafios, side projects e estudos." },
  { key: "ideias", name: "Ideias de Automação", content: "Backlog de coisas que podem ser automatizadas. A IA adiciona sugestões aqui todo domingo." },
  { key: "briefings", name: "Briefings", content: "Resumos diários e semanais gerados automaticamente." },
] as const;

const TAGS = [
  { name: "urgente", bg: "#e5484d" },
  { name: "rapida", bg: "#30a46c" }, // até 15 minutos
  { name: "automatizavel", bg: "#6e56cf" },
  { name: "sugestao-ia", bg: "#0091ff" },
  { name: "briefing", bg: "#8b8d98" },
];

/** Meio-dia (São Paulo) do dia `key`, em epoch ms. */
function noonSP(key: string): number {
  return new Date(`${key}T12:00:00-03:00`).getTime();
}

/**
 * Rode UMA vez (manualmente) para criar a estrutura no ClickUp.
 * É idempotente: se algo já existir, só reaproveita.
 * Payload opcional: { "teamId": "...", "seedExemplos": true }
 */
export const setupClickUp = task({
  id: "agenda-setup-clickup",
  maxDuration: 120,
  retry: { maxAttempts: 1 },
  run: async (payload: { teamId?: string; seedExemplos?: boolean }) => {
    const token = getClickUpToken();

    // 1. Workspace
    const workspaces = await getWorkspaces(token);
    logger.info("Workspaces encontrados", { workspaces });
    const teamId = payload.teamId ?? process.env.CLICKUP_TEAM_ID ?? (workspaces.length === 1 ? workspaces[0].id : undefined);
    if (!teamId) {
      throw new Error(
        `Você tem ${workspaces.length} workspaces. Rode de novo com payload { "teamId": "..." } usando um destes: ${workspaces
          .map((w) => `${w.name}=${w.id}`)
          .join(", ")}`,
      );
    }

    // 2. Space
    const spaces = await getSpaces(token, teamId);
    let space = spaces.find((s) => s.name === SPACE_NAME);
    if (space) logger.info("Space já existe", { id: space.id });
    else {
      space = await createSpace(token, teamId, SPACE_NAME);
      logger.info("Space criado", { id: space.id });
    }

    // 3. Listas
    const existing = await getFolderlessLists(token, space.id);
    const listIds: Record<string, string> = {};
    for (const l of LISTS) {
      const found = existing.find((e) => e.name === l.name);
      const list = found ?? (await createFolderlessList(token, space.id, l.name, l.content));
      listIds[l.key] = list.id;
      logger.info(found ? "Lista já existe" : "Lista criada", { name: l.name, id: list.id });
    }

    // 4. Tags
    const existingTags = new Set((await getSpaceTags(token, space.id)).map((t) => t.name));
    for (const tag of TAGS) {
      if (!existingTags.has(tag.name)) await createSpaceTag(token, space.id, tag.name, tag.bg);
    }

    // 5. Tarefas de exemplo (opcional, só se a Space ainda estiver vazia)
    let exemplosCriados = 0;
    if (payload.seedExemplos) {
      const current = await getTeamTasks(token, teamId, { spaceIds: [space.id], includeClosed: true });
      if (current.length > 0) {
        logger.info("Space já tem tarefas — não vou criar exemplos", { total: current.length });
      } else {
        const hoje = dateKey(Date.now());
        const min = (m: number) => m * 60_000;
        const exemplos: { list: string; task: NewTask }[] = [
          { list: "trabalho", task: { name: "Revisar emails e responder pendências", priority: 2, due_date: noonSP(hoje), time_estimate: min(30), tags: ["rapida"] } },
          { list: "trabalho", task: { name: "Preparar relatório semanal", priority: 3, due_date: noonSP(addDays(hoje, 2)), time_estimate: min(60), tags: ["automatizavel"] } },
          { list: "projetos", task: { name: "Terminar Day 4 do 7 Day AIS Challenge", priority: 1, due_date: noonSP(hoje), time_estimate: min(90) } },
          { list: "projetos", task: { name: "Estudar documentação do Trigger.dev", priority: 3, due_date: noonSP(addDays(hoje, 8)), time_estimate: min(45) } },
          { list: "ideias", task: { name: "Automatizar captura de tarefas por email", priority: 4, tags: ["automatizavel"] } },
        ];
        for (const e of exemplos) {
          await createTask(token, listIds[e.list], e.task);
          exemplosCriados++;
        }
      }
    }

    const envVars = {
      CLICKUP_TEAM_ID: teamId,
      CLICKUP_SPACE_ID: space.id,
      CLICKUP_LIST_BRIEFINGS_ID: listIds.briefings,
      CLICKUP_LIST_IDEIAS_ID: listIds.ideias,
    };
    logger.info("✅ Pronto! Copie estes valores para o .env e para o dashboard do Trigger.dev", envVars);
    return { envVars, listas: listIds, exemplosCriados };
  },
});
