// Busca os compromissos do Google Agenda num intervalo (usado pelo briefing).

import { listCalendars, listEvents } from "./gcal.js";

export interface Compromisso {
  titulo: string;
  calendario: string;
  diaInteiro: boolean;
  inicio: string; // ISO (com horário) ou "YYYY-MM-DD"
  fim: string;
  local?: string;
}

/** true se as credenciais do Google estão configuradas (senão o briefing pula a seção). */
export function googleConfigured(): boolean {
  return !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET && process.env.GOOGLE_REFRESH_TOKEN);
}

export async function getCompromissos(fromMs: number, toMs: number): Promise<Compromisso[]> {
  const tarefasCalId = process.env.GCAL_CAL_TAREFAS_ID; // tarefas do ClickUp já aparecem no briefing
  const calendars = (await listCalendars()).filter(
    (c) => c.accessRole !== "freeBusyReader" && c.id !== tarefasCalId,
  );

  const out: Compromisso[] = [];
  for (const cal of calendars) {
    const events = await listEvents(cal.id, {
      timeMin: new Date(fromMs).toISOString(),
      timeMax: new Date(toMs).toISOString(),
      singleEvents: true,
    });
    for (const ev of events) {
      if (ev.eventType && !["default", "birthday", "outOfOffice"].includes(ev.eventType)) continue;
      if (ev.attendees?.some((a) => a.self && a.responseStatus === "declined")) continue;
      out.push({
        titulo: ev.summary ?? "(sem título)",
        calendario: cal.primary ? "Principal" : cal.summary,
        diaInteiro: !!ev.start?.date,
        inicio: ev.start?.dateTime ?? ev.start?.date ?? "",
        fim: ev.end?.dateTime ?? ev.end?.date ?? "",
        local: ev.location,
      });
    }
  }
  return out.sort((a, b) => a.inicio.localeCompare(b.inicio));
}

/** Minutos ocupados por compromissos com horário dentro da janela [fromMs, toMs] (sobreposições contam uma vez). */
export function busyMinutes(compromissos: Compromisso[], fromMs: number, toMs: number): number {
  const intervals = compromissos
    .filter((c) => !c.diaInteiro)
    .map((c) => [Math.max(Date.parse(c.inicio), fromMs), Math.min(Date.parse(c.fim), toMs)] as const)
    .filter(([s, e]) => e > s)
    .sort((a, b) => a[0] - b[0]);
  let total = 0;
  let curStart = -1;
  let curEnd = -1;
  for (const [s, e] of intervals) {
    if (s > curEnd) {
      if (curEnd > curStart) total += curEnd - curStart;
      curStart = s;
      curEnd = e;
    } else curEnd = Math.max(curEnd, e);
  }
  if (curEnd > curStart) total += curEnd - curStart;
  return Math.round(total / 60_000);
}
