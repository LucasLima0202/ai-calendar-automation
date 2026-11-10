import type { GEvent } from "./gcal.js";
import { TIMEZONE } from "./gcal.js";

const dt = new Intl.DateTimeFormat("pt-BR", {
  timeZone: TIMEZONE,
  weekday: "short",
  day: "2-digit",
  month: "2-digit",
  year: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
});
const d = new Intl.DateTimeFormat("pt-BR", { timeZone: "UTC", weekday: "short", day: "2-digit", month: "2-digit", year: "2-digit" });

const FREQ: Record<string, string> = { DAILY: "diário", WEEKLY: "semanal", MONTHLY: "mensal", YEARLY: "anual" };

/** "qua., 12/11/26, 14:00 · repete semanal" */
export function describeWhen(ev: GEvent): string {
  let when = "?";
  if (ev.start?.dateTime) when = dt.format(new Date(ev.start.dateTime));
  else if (ev.start?.date) when = `${d.format(new Date(`${ev.start.date}T00:00:00Z`))} (dia inteiro)`;
  const rrule = ev.recurrence?.find((r) => r.startsWith("RRULE:"));
  if (rrule) {
    const freq = /FREQ=(\w+)/.exec(rrule)?.[1] ?? "";
    const since = ev.start?.dateTime ?? ev.start?.date;
    when = `repete ${FREQ[freq] ?? freq.toLowerCase()} desde ${since ? since.slice(0, 10) : "?"}`;
  }
  return when;
}

export function normalizeTitle(s: string | undefined): string {
  return (s ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
