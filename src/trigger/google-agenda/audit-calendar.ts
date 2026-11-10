import { logger, task } from "@trigger.dev/sdk";
import { createTask, getClickUpToken, getTeamTasks, updateTask } from "../agenda-clickup/lib/clickup.js";
import type { Action } from "./lib/actions.js";
import { AREAS, getAreaCalendarIds } from "./lib/areas.js";
import { classifyEvents } from "./lib/classify.js";
import { describeWhen, normalizeTitle } from "./lib/format.js";
import { isOpenEndedSeries, listCalendars, listEvents, seriesUntilMs, type GCalendar, type GEvent } from "./lib/gcal.js";

const STALE_SERIES_DAYS = 180;
const GENERIC_TITLE = /^(|sem titulo|evento|novo evento|untitled|untitled event|busy|ocupado|teste|test|reuniao)$/;

const DAY = 24 * 60 * 60 * 1000;

interface Found {
  cal: GCalendar;
  ev: GEvent;
}

/**
 * SÓ LEITURA. Varre o Google Agenda (de hoje até 12 meses à frente) e PROPÕE ações numeradas.
 * Nada é alterado aqui — as ações aprovadas são executadas por `gcal-apply-changes`.
 */
export const gcalAuditCalendar = task({
  id: "gcal-audit-calendar",
  maxDuration: 600,
  run: async () => {
    const areaIds = getAreaCalendarIds();
    const areaCalendarIds = new Set(Object.values(areaIds));
    const now = Date.now();

    const calendars = await listCalendars();
    const primary = calendars.find((c) => c.primary);
    if (!primary) throw new Error("Calendário principal não encontrado");

    // Calendários que você pode editar, exceto o da sincronização do ClickUp.
    const writable = calendars.filter(
      (c) => (c.accessRole === "owner" || c.accessRole === "writer") && c.id !== areaIds.tarefas,
    );

    const timeMin = new Date(now).toISOString();
    const timeMax = new Date(now + 365 * DAY).toISOString();

    const proprios: Found[] = [];
    const convites: Found[] = [];
    const especiais: Record<string, number> = {};

    for (const cal of writable) {
      const events = await listEvents(cal.id, { timeMin, timeMax, singleEvents: false });
      for (const ev of events) {
        if (ev.eventType && ev.eventType !== "default") {
          especiais[ev.eventType] = (especiais[ev.eventType] ?? 0) + 1;
          continue;
        }
        if (ev.recurringEventId) continue; // exceção de uma série: a série é tratada pelo evento mestre
        const until = seriesUntilMs(ev);
        if (until !== null && until < now + DAY) continue; // série já encerrada (termina até amanhã)
        const souOrganizador = ev.organizer?.self === true || ev.organizer?.email === cal.id;
        (souOrganizador ? proprios : convites).push({ cal, ev });
      }
    }
    logger.info("Eventos lidos", { calendarios: writable.length, proprios: proprios.length, convites: convites.length, especiais });

    const acoes: Omit<Action, "n">[] = [];
    const tratados = new Set<string>(); // eventIds que já receberam uma ação

    // 1. Duplicados: mesmo título + mesmo início
    const grupos = new Map<string, Found[]>();
    for (const f of proprios) {
      const start = f.ev.start?.dateTime ?? f.ev.start?.date ?? "";
      const key = `${normalizeTitle(f.ev.summary)}|${start}`;
      grupos.set(key, [...(grupos.get(key) ?? []), f]);
    }
    for (const grupo of grupos.values()) {
      if (grupo.length < 2) continue;
      // Mantém o que já está num calendário de área; senão, o mais antigo.
      const ordenado = [...grupo].sort(
        (a, b) =>
          Number(areaCalendarIds.has(b.cal.id)) - Number(areaCalendarIds.has(a.cal.id)) ||
          (a.ev.created ?? "").localeCompare(b.ev.created ?? ""),
      );
      const [manter, ...extras] = ordenado;
      for (const f of extras) {
        acoes.push({
          tipo: "apagar-duplicado",
          calendarId: f.cal.id,
          eventId: f.ev.id,
          titulo: f.ev.summary ?? "(sem título)",
          quando: describeWhen(f.ev),
          detalhe: `cópia de um evento igual em "${manter.cal.summary}" (esse fica)`,
        });
        tratados.add(f.ev.id);
      }
    }

    // 2. Recorrências sem fim e sem nenhuma alteração há muito tempo
    //    (mover/manter uma série atualiza a data de alteração, então séries revisadas não voltam aqui)
    for (const f of proprios) {
      if (tratados.has(f.ev.id) || !isOpenEndedSeries(f.ev)) continue;
      const lastTouch = Date.parse(f.ev.updated ?? f.ev.created ?? "") || now;
      const idadeDias = Math.floor((now - lastTouch) / DAY);
      if (idadeDias < STALE_SERIES_DAYS) continue;
      acoes.push({
        tipo: "encerrar-serie",
        calendarId: f.cal.id,
        eventId: f.ev.id,
        titulo: f.ev.summary ?? "(sem título)",
        quando: describeWhen(f.ev),
        detalhe: `série sem data final e sem alterações há ${idadeDias} dias — encerrar hoje (o histórico fica)`,
      });
      tratados.add(f.ev.id);
    }

    // 3. Títulos vazios/genéricos: só para você revisar
    for (const f of proprios) {
      if (tratados.has(f.ev.id) || !GENERIC_TITLE.test(normalizeTitle(f.ev.summary))) continue;
      acoes.push({
        tipo: "revisar",
        calendarId: f.cal.id,
        eventId: f.ev.id,
        titulo: f.ev.summary || "(sem título)",
        quando: describeWhen(f.ev),
        detalhe: "título vazio/genérico — me diga o que é (renomear, mover ou apagar)",
      });
      tratados.add(f.ev.id);
    }

    // 4. Eventos no calendário principal → mover para a área certa
    const paraClassificar = proprios.filter((f) => f.cal.id === primary.id && !tratados.has(f.ev.id));
    if (paraClassificar.length) {
      const classes = await classifyEvents(
        paraClassificar.map((f) => ({
          id: f.ev.id,
          titulo: f.ev.summary ?? "",
          descricao: f.ev.description,
          recorrente: !!f.ev.recurrence,
        })),
      );
      for (const f of paraClassificar) {
        const c = classes.get(f.ev.id);
        if (!c) continue;
        acoes.push({
          tipo: "mover",
          calendarId: f.cal.id,
          eventId: f.ev.id,
          titulo: f.ev.summary ?? "(sem título)",
          quando: describeWhen(f.ev),
          detalhe: `→ ${AREAS[c.area].nome}${c.confianca === "baixa" ? " (palpite, confira)" : ""}`,
          destinoCalendarId: areaIds[c.area],
          destinoArea: c.area,
        });
      }
    }

    const numeradas: Action[] = acoes.map((a, i) => ({ ...a, n: i + 1 }));

    // Relatório
    const titulos: Record<Action["tipo"], string> = {
      "apagar-duplicado": "🗑️ Duplicados (apagar a cópia)",
      "encerrar-serie": "⏹️ Recorrências antigas sem fim (encerrar)",
      revisar: "❓ Para você revisar",
      mover: "📂 Mover para o calendário da área",
    };
    const md: string[] = [
      `# Auditoria do Google Agenda`,
      `Período: hoje até 12 meses à frente · ${proprios.length} eventos seus · ${convites.length} convites de outras pessoas (não mexo neles)`,
      "",
    ];
    for (const tipo of ["apagar-duplicado", "encerrar-serie", "revisar", "mover"] as const) {
      const lista = numeradas.filter((a) => a.tipo === tipo);
      if (!lista.length) continue;
      md.push(`## ${titulos[tipo]} (${lista.length})`);
      for (const a of lista) md.push(`${a.n}. **${a.titulo}** — ${a.quando} — ${a.detalhe}`);
      md.push("");
    }
    if (Object.keys(especiais).length) {
      md.push(`_Ignorados (tipos especiais do Google): ${Object.entries(especiais).map(([k, v]) => `${k}: ${v}`).join(", ")}_`, "");
    }
    if (convites.length) {
      md.push(`## 📨 Convites de outras pessoas (${convites.length}) — só informativo`);
      for (const f of convites.slice(0, 30)) md.push(`- ${f.ev.summary ?? "(sem título)"} — ${describeWhen(f.ev)} (de ${f.ev.organizer?.email ?? "?"})`);
      md.push("");
    }
    const relatorio = md.join("\n");

    // Cópia do relatório no ClickUp (se falhar, não derruba a auditoria)
    let clickupUrl: string | undefined;
    try {
      const listId = process.env.CLICKUP_LIST_BRIEFINGS_ID;
      const teamId = process.env.CLICKUP_TEAM_ID;
      if (listId && teamId) {
        const token = getClickUpToken();
        const name = `Auditoria Google Agenda ${new Date(now).toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo" })}`;
        // Uma tarefa por dia: se já existe, atualiza com o relatório mais recente.
        const existing = (await getTeamTasks(token, teamId, { listIds: [listId], includeClosed: true })).find(
          (t) => t.name === name,
        );
        const t = existing
          ? await updateTask(token, existing.id, { markdown_content: relatorio })
          : await createTask(token, listId, { name, markdown_content: relatorio, tags: ["briefing"] });
        clickupUrl = t.url;
      }
    } catch (err) {
      logger.warn("Não consegui salvar o relatório no ClickUp", { error: err instanceof Error ? err.message : String(err) });
    }

    return {
      resumo: {
        eventosProprios: proprios.length,
        convites: convites.length,
        duplicados: numeradas.filter((a) => a.tipo === "apagar-duplicado").length,
        seriesAntigas: numeradas.filter((a) => a.tipo === "encerrar-serie").length,
        revisar: numeradas.filter((a) => a.tipo === "revisar").length,
        mover: numeradas.filter((a) => a.tipo === "mover").length,
      },
      clickupUrl,
      relatorio,
      acoes: numeradas,
    };
  },
});
