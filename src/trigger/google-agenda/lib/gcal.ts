// Cliente mínimo da Google Calendar API v3 usando fetch nativo.
// Docs: https://developers.google.com/calendar/api/v3/reference

const API = "https://www.googleapis.com/calendar/v3";
export const TIMEZONE = "America/Sao_Paulo";

export interface GCalendar {
  id: string;
  summary: string;
  primary?: boolean;
  accessRole: "owner" | "writer" | "reader" | "freeBusyReader";
  backgroundColor?: string;
}

export interface GEventTime {
  dateTime?: string;
  date?: string; // eventos de dia inteiro
  timeZone?: string;
}

export interface GEvent {
  id: string;
  status: "confirmed" | "tentative" | "cancelled";
  summary?: string;
  description?: string;
  location?: string;
  htmlLink?: string;
  created?: string;
  updated?: string;
  start?: GEventTime;
  end?: GEventTime;
  recurrence?: string[];
  recurringEventId?: string;
  organizer?: { email?: string; self?: boolean };
  creator?: { email?: string; self?: boolean };
  attendees?: { email?: string; self?: boolean; responseStatus?: string }[];
  eventType?: string; // default | birthday | fromGmail | focusTime | outOfOffice | workingLocation
  extendedProperties?: { private?: Record<string, string> };
}

export class GCalError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "GCalError";
  }
}

// ─── Autenticação ─────────────────────────────────────────────────

let cachedToken: { value: string; expiresAt: number } | null = null;

/** Troca o refresh token (permanente) por um access token (dura ~1h). */
export async function getAccessToken(): Promise<string> {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  if (!clientId) throw new Error("GOOGLE_CLIENT_ID is not set");
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientSecret) throw new Error("GOOGLE_CLIENT_SECRET is not set");
  const refreshToken = process.env.GOOGLE_REFRESH_TOKEN;
  if (!refreshToken) throw new Error("GOOGLE_REFRESH_TOKEN is not set");

  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) return cachedToken.value;

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });
  const data = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error?: string; error_description?: string };
  if (!res.ok || !data.access_token) {
    // invalid_grant = refresh token revogado/expirado → precisa gerar outro no OAuth Playground.
    throw new GCalError(`Google OAuth falhou (${res.status}): ${data.error ?? ""} ${data.error_description ?? ""}`.trim(), res.status);
  }
  cachedToken = { value: data.access_token, expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000 };
  return data.access_token;
}

async function request<T>(method: "GET" | "POST" | "PATCH" | "DELETE", path: string, body?: unknown): Promise<T> {
  const token = await getAccessToken();
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new GCalError(`Google Calendar ${method} ${path.split("?")[0]} falhou (${res.status}): ${text.slice(0, 400)}`, res.status);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

const enc = encodeURIComponent;

// ─── Calendários ──────────────────────────────────────────────────

export async function listCalendars(): Promise<GCalendar[]> {
  const all: GCalendar[] = [];
  let pageToken: string | undefined;
  do {
    const qs = new URLSearchParams({ maxResults: "250" });
    if (pageToken) qs.set("pageToken", pageToken);
    const data = await request<{ items: GCalendar[]; nextPageToken?: string }>("GET", `/users/me/calendarList?${qs}`);
    all.push(...(data.items ?? []));
    pageToken = data.nextPageToken;
  } while (pageToken);
  return all;
}

export async function createCalendar(summary: string, description: string): Promise<GCalendar> {
  return request<GCalendar>("POST", "/calendars", { summary, description, timeZone: TIMEZONE });
}

export async function setCalendarColor(calendarId: string, backgroundColor: string) {
  await request("PATCH", `/users/me/calendarList/${enc(calendarId)}?colorRgbFormat=true`, {
    backgroundColor,
    foregroundColor: "#ffffff",
  });
}

// ─── Eventos ──────────────────────────────────────────────────────

/**
 * Lista eventos de um calendário. Com singleEvents=false, uma série recorrente vem como
 * UM evento "mestre" (com `recurrence`) — é o que queremos para auditar recorrências.
 */
export async function listEvents(
  calendarId: string,
  opts: { timeMin: string; timeMax: string; singleEvents?: boolean; privateExtendedProperty?: string },
): Promise<GEvent[]> {
  const all: GEvent[] = [];
  let pageToken: string | undefined;
  do {
    const qs = new URLSearchParams({
      timeMin: opts.timeMin,
      timeMax: opts.timeMax,
      singleEvents: String(opts.singleEvents ?? false),
      maxResults: "2500",
      showDeleted: "false",
    });
    if (opts.singleEvents) qs.set("orderBy", "startTime");
    if (opts.privateExtendedProperty) qs.set("privateExtendedProperty", opts.privateExtendedProperty);
    if (pageToken) qs.set("pageToken", pageToken);
    const data = await request<{ items: GEvent[]; nextPageToken?: string }>("GET", `/calendars/${enc(calendarId)}/events?${qs}`);
    all.push(...(data.items ?? []));
    pageToken = data.nextPageToken;
  } while (pageToken);
  return all.filter((e) => e.status !== "cancelled");
}

/** Retorna o evento, ou null se ele não existe mais nesse calendário. */
export async function getEvent(calendarId: string, eventId: string): Promise<GEvent | null> {
  try {
    const ev = await request<GEvent>("GET", `/calendars/${enc(calendarId)}/events/${enc(eventId)}`);
    return ev.status === "cancelled" ? null : ev;
  } catch (err) {
    if (err instanceof GCalError && (err.status === 404 || err.status === 410)) return null;
    throw err;
  }
}

export async function moveEvent(calendarId: string, eventId: string, destinationCalendarId: string) {
  return request<GEvent>(
    "POST",
    `/calendars/${enc(calendarId)}/events/${enc(eventId)}/move?destination=${enc(destinationCalendarId)}&sendUpdates=none`,
  );
}

export async function patchEvent(calendarId: string, eventId: string, patch: Partial<GEvent>) {
  return request<GEvent>("PATCH", `/calendars/${enc(calendarId)}/events/${enc(eventId)}?sendUpdates=none`, patch);
}

export async function deleteEvent(calendarId: string, eventId: string) {
  await request("DELETE", `/calendars/${enc(calendarId)}/events/${enc(eventId)}?sendUpdates=none`);
}

export interface NewEvent {
  summary: string;
  description?: string;
  location?: string;
  start: GEventTime;
  end: GEventTime;
  recurrence?: string[];
  extendedProperties?: { private: Record<string, string> };
}

export async function insertEvent(calendarId: string, event: NewEvent) {
  return request<GEvent>("POST", `/calendars/${enc(calendarId)}/events?sendUpdates=none`, event);
}

// ─── Helpers de recorrência ───────────────────────────────────────

/** true se a série não tem data final (sem UNTIL nem COUNT). */
export function isOpenEndedSeries(ev: GEvent): boolean {
  const rrule = ev.recurrence?.find((r) => r.startsWith("RRULE:"));
  return !!rrule && !/;(UNTIL|COUNT)=/i.test(rrule);
}

/**
 * Devolve o array `recurrence` com a série terminando no dia `untilKey` ("YYYY-MM-DD").
 * Eventos de dia inteiro usam UNTIL=YYYYMMDD; os demais UNTIL=YYYYMMDDT235959Z.
 */
export function recurrenceEndingOn(ev: GEvent, untilKey: string): string[] {
  const compact = untilKey.replace(/-/g, "");
  const until = ev.start?.date ? compact : `${compact}T235959Z`;
  return (ev.recurrence ?? []).map((line) => {
    if (!line.startsWith("RRULE:")) return line;
    const parts = line
      .slice("RRULE:".length)
      .split(";")
      .filter((p) => !/^(UNTIL|COUNT)=/i.test(p));
    parts.push(`UNTIL=${until}`);
    return `RRULE:${parts.join(";")}`;
  });
}

/** Momento (ms) em que a série termina, pelo UNTIL do RRULE; null se não tiver UNTIL. */
export function seriesUntilMs(ev: GEvent): number | null {
  const rrule = ev.recurrence?.find((r) => r.startsWith("RRULE:"));
  const m = rrule && /UNTIL=(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})Z)?/i.exec(rrule);
  if (!m) return null;
  const [, y, mo, d, h = "23", mi = "59", s = "59"] = m;
  return Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s));
}
