import { schedules } from "@trigger.dev/sdk";
import { runBriefing, toEpoch } from "./lib/briefing.js";

// Todo dia às 6h (horário de Brasília): plano do dia + atrasadas + visão da semana.
export const dailyBriefing = schedules.task({
  id: "agenda-daily-briefing",
  cron: { pattern: "0 6 * * *", timezone: "America/Sao_Paulo", window: "5m" },
  maxDuration: 300,
  run: async (payload) => {
    return runBriefing("daily", toEpoch(payload.timestamp));
  },
});
