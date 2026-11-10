import { logger, task } from "@trigger.dev/sdk";
import { AREAS, type AreaKey } from "./lib/areas.js";
import { createCalendar, listCalendars, setCalendarColor } from "./lib/gcal.js";

/**
 * Rode UMA vez: cria no Google Agenda um calendário por área (se ainda não existir) e aplica as cores.
 * Idempotente: se o calendário já existe (mesmo nome, você é dono), só reaproveita.
 */
export const gcalSetupCalendars = task({
  id: "gcal-setup-calendars",
  maxDuration: 120,
  run: async () => {
    const existing = await listCalendars();
    const envVars: Record<string, string> = {};

    for (const [key, area] of Object.entries(AREAS) as [AreaKey, (typeof AREAS)[AreaKey]][]) {
      let cal = existing.find((c) => c.summary === area.nome && c.accessRole === "owner");
      if (cal) {
        logger.info("Calendário já existe", { nome: area.nome });
      } else {
        cal = await createCalendar(area.nome, area.descricao);
        logger.info("Calendário criado", { nome: area.nome });
      }
      await setCalendarColor(cal.id, area.cor);
      envVars[area.envVar] = cal.id;
    }

    logger.info("✅ Copie estes valores para o .env e para o dashboard do Trigger.dev", envVars);
    return {
      envVars,
      todosOsCalendarios: existing.map((c) => ({ nome: c.summary, principal: !!c.primary, acesso: c.accessRole })),
    };
  },
});
