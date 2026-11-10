import { schedules } from "@trigger.dev/sdk";
import { runBriefing, toEpoch } from "./lib/briefing.js";

// Domingo às 19h (horário de Brasília): revisão da semana + semana que começa + próxima,
// e cria até 3 ideias de automação no ClickUp.
export const weeklyBriefing = schedules.task({
  id: "agenda-weekly-briefing",
  cron: { pattern: "0 19 * * 0", timezone: "America/Sao_Paulo", window: "5m" },
  maxDuration: 300,
  run: async (payload) => {
    return runBriefing("weekly", toEpoch(payload.timestamp));
  },
});
