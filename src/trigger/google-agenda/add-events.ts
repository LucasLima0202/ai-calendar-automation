import { logger, schemaTask } from "@trigger.dev/sdk";
import { createHash } from "node:crypto";
import { z } from "zod";
import { addDays } from "../agenda-clickup/lib/agenda.js";
import { AREAS, CLASSIFIABLE_AREAS, getAreaCalendarIds } from "./lib/areas.js";
import { insertEvent, listEvents, TIMEZONE, type NewEvent } from "./lib/gcal.js";

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;

const EventoSchema = z
  .object({
    titulo: z.string().min(1),
    area: z.enum(CLASSIFIABLE_AREAS),
    /** "2026-11-12T14:00" (horário de Brasília) ou "2026-11-12" (dia inteiro) */
    inicio: z.string().refine((v) => DATE.test(v) || DATETIME.test(v), "use YYYY-MM-DD ou YYYY-MM-DDTHH:mm"),
    /** opcional: mesmo formato do início (no dia inteiro, é o último dia, inclusive) */
    fim: z.string().optional(),
    /** opcional para eventos com horário (padrão 60) */
    duracaoMin: z.number().int().positive().optional(),
    /** opcional, ex: "RRULE:FREQ=WEEKLY;BYDAY=MO,WE" */
    recorrencia: z.string().startsWith("RRULE:").optional(),
    descricao: z.string().optional(),
    local: z.string().optional(),
  })
  .refine((e) => !e.fim || (DATE.test(e.inicio) ? DATE.test(e.fim) : DATETIME.test(e.fim)), "fim deve ter o mesmo formato do início");

type Evento = z.infer<typeof EventoSchema>;

/** Soma minutos a um horário "YYYY-MM-DDTHH:mm" sem mexer com fuso (aritmética de relógio). */
function addMinutes(local: string, minutes: number): string {
  const [date, time] = local.split("T");
  const [y, mo, d] = date.split("-").map(Number);
  const [h, mi] = time.split(":").map(Number);
  return new Date(Date.UTC(y, mo - 1, d, h, mi + minutes)).toISOString().slice(0, 16);
}

function toGoogleEvent(e: Evento, chave: string): NewEvent {
  const allDay = DATE.test(e.inicio);
  const start = allDay ? { date: e.inicio } : { dateTime: `${e.inicio}:00`, timeZone: TIMEZONE };
  const end = allDay
    ? { date: addDays(e.fim ?? e.inicio, 1) } // no Google o fim do dia inteiro é exclusivo
    : { dateTime: `${e.fim ?? addMinutes(e.inicio, e.duracaoMin ?? 60)}:00`, timeZone: TIMEZONE };
  return {
    summary: e.titulo,
    description: e.descricao,
    location: e.local,
    start,
    end,
    recurrence: e.recorrencia ? [e.recorrencia] : undefined,
    extendedProperties: { private: { chave } },
  };
}

/**
 * Cria eventos em lote no calendário da área certa.
 * Idempotente: cada evento recebe uma "chave" (hash de área+título+início); se já existir, não duplica.
 */
export const gcalAddEvents = schemaTask({
  id: "gcal-add-events",
  schema: z.object({ eventos: z.array(EventoSchema).min(1) }),
  maxDuration: 300,
  run: async ({ eventos }) => {
    const areaIds = getAreaCalendarIds();
    const resultados: { titulo: string; area: string; status: "criado" | "ja-existia"; link?: string }[] = [];

    for (const e of eventos) {
      const calendarId = areaIds[e.area];
      const chave = createHash("sha1").update(`${e.area}|${e.titulo}|${e.inicio}`).digest("hex").slice(0, 16);
      const dia = e.inicio.slice(0, 10);
      const existentes = await listEvents(calendarId, {
        timeMin: `${addDays(dia, -1)}T00:00:00-03:00`,
        timeMax: `${addDays(dia, 2)}T00:00:00-03:00`,
        privateExtendedProperty: `chave=${chave}`,
      });
      if (existentes.length) {
        resultados.push({ titulo: e.titulo, area: AREAS[e.area].nome, status: "ja-existia", link: existentes[0].htmlLink });
        continue;
      }
      const criado = await insertEvent(calendarId, toGoogleEvent(e, chave));
      resultados.push({ titulo: e.titulo, area: AREAS[e.area].nome, status: "criado", link: criado.htmlLink });
    }

    logger.info("Eventos processados", {
      criados: resultados.filter((r) => r.status === "criado").length,
      jaExistiam: resultados.filter((r) => r.status === "ja-existia").length,
    });
    return { resultados };
  },
});
