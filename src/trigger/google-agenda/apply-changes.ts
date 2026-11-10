import { logger, schemaTask } from "@trigger.dev/sdk";
import { z } from "zod";
import { ActionSchema, type Action } from "./lib/actions.js";
import { dateKey } from "../agenda-clickup/lib/agenda.js";
import { deleteEvent, getEvent, isOpenEndedSeries, moveEvent, patchEvent, recurrenceEndingOn } from "./lib/gcal.js";

type Status = "feito" | "ja-estava-feito" | "nao-encontrado" | "ignorado" | "erro";

async function applyOne(a: Action, hoje: string): Promise<{ status: Status; detalhe?: string }> {
  switch (a.tipo) {
    case "revisar":
      return { status: "ignorado", detalhe: "ação de revisão manual" };

    case "mover": {
      if (!a.destinoCalendarId) return { status: "erro", detalhe: "sem calendário de destino" };
      const ev = await getEvent(a.calendarId, a.eventId);
      if (!ev) {
        const noDestino = await getEvent(a.destinoCalendarId, a.eventId);
        return noDestino ? { status: "ja-estava-feito" } : { status: "nao-encontrado" };
      }
      await moveEvent(a.calendarId, a.eventId, a.destinoCalendarId);
      return { status: "feito" };
    }

    case "encerrar-serie": {
      const ev = await getEvent(a.calendarId, a.eventId);
      if (!ev) return { status: "nao-encontrado" };
      if (!isOpenEndedSeries(ev)) return { status: "ja-estava-feito" };
      await patchEvent(a.calendarId, a.eventId, { recurrence: recurrenceEndingOn(ev, hoje) });
      return { status: "feito" };
    }

    case "apagar-duplicado": {
      const ev = await getEvent(a.calendarId, a.eventId);
      if (!ev) return { status: "ja-estava-feito" };
      await deleteEvent(a.calendarId, a.eventId);
      return { status: "feito" };
    }
  }
}

/**
 * Executa SOMENTE as ações aprovadas por você (vindas da auditoria).
 * Idempotente: rodar de novo não refaz o que já foi feito.
 */
export const gcalApplyChanges = schemaTask({
  id: "gcal-apply-changes",
  schema: z.object({ acoes: z.array(ActionSchema).min(1) }),
  maxDuration: 600,
  run: async ({ acoes }) => {
    const hoje = dateKey(Date.now());
    const resultados: { n: number; tipo: string; titulo: string; status: Status; detalhe?: string }[] = [];

    for (const a of acoes) {
      try {
        const r = await applyOne(a, hoje);
        resultados.push({ n: a.n, tipo: a.tipo, titulo: a.titulo, ...r });
      } catch (err) {
        const detalhe = err instanceof Error ? err.message.slice(0, 200) : String(err);
        logger.error("Falha ao aplicar ação", { n: a.n, tipo: a.tipo, detalhe });
        resultados.push({ n: a.n, tipo: a.tipo, titulo: a.titulo, status: "erro", detalhe });
      }
    }

    const contagem = resultados.reduce<Record<string, number>>((acc, r) => ({ ...acc, [r.status]: (acc[r.status] ?? 0) + 1 }), {});
    logger.info("Resultado", contagem);
    return { contagem, resultados };
  },
});
