// Gera os insights do briefing com o Google Gemini (saída JSON validada por Zod).
// Docs: https://ai.google.dev/gemini-api/docs/structured-output

import { geminiJson } from "../../shared/gemini.js";
import { z } from "zod";
import type { Agenda, AgendaTask } from "./agenda.js";
import type { Compromisso } from "../../google-agenda/lib/upcoming.js";

export const InsightsSchema = z.object({
  resumo: z.string().describe("2 a 4 frases, tom direto e motivador, em português do Brasil"),
  foco: z
    .array(
      z.object({
        tarefa: z.string().describe("nome exato da tarefa da agenda"),
        motivo: z.string().describe("por que ela é prioridade agora, em 1 frase"),
      }),
    )
    .describe("até 3 tarefas para focar (no diário: hoje; no semanal: na semana)"),
  alertas: z
    .array(z.string())
    .describe("sobrecarga, atrasos, prazos colados, tarefas sem prazo/prioridade. Vazio se não houver"),
  insights: z.array(z.string()).describe("2 a 4 observações práticas de produtividade baseadas nos dados"),
  ideiasAutomacao: z
    .array(
      z.object({
        titulo: z.string().describe("curto, começando com verbo. Ex: 'Automatizar envio de relatório semanal'"),
        descricao: z.string().describe("o que automatizar, como, e qual tarefa/padrão inspirou a ideia"),
        ferramenta: z.string().describe("ex: Trigger.dev + API do ClickUp, Google Calendar API, Gemini"),
        ganhoEstimado: z.string().describe("ex: '~30 min/semana'"),
      }),
    )
    .describe("até 3 ideias concretas e NOVAS (não repetir as já existentes)"),
});

export type Insights = z.infer<typeof InsightsSchema>;

const SYSTEM_PROMPT = `Você é um assistente de produtividade pessoal. Recebe a agenda do usuário (extraída do ClickUp, já agrupada por período e com métricas calculadas) e escreve um briefing curto e acionável em português do Brasil.

Regras:
- Use somente as tarefas e números fornecidos. Não invente tarefas, prazos nem números.
- Seja específico: cite tarefas pelo nome. Nada de conselhos genéricos ("beba água", "faça pausas").
- Priorize: atrasadas e urgentes primeiro, depois prazos mais próximos, depois impacto.
- "compromissosGoogle" são eventos com horário marcado (reuniões, aulas etc.). Considere-os ao avaliar a carga do dia: muitas tarefas num dia cheio de compromissos é um alerta.
- Sinalize sobrecarga quando um dia tiver muitas tarefas ou mais de ~6h estimadas.
- Ideias de automação devem nascer de padrões reais da agenda (tarefas repetitivas, tag "automatizavel", tarefas de rotina) ou de lacunas no próprio processo de organização. Prefira ideias implementáveis com Trigger.dev + APIs. Nunca repita uma ideia que já existe na lista enviada.
- Se a agenda estiver quase vazia, foque em como organizar melhor e sugira o que cadastrar.`;

function compactTask(t: AgendaTask) {
  return {
    nome: t.nome,
    lista: t.lista,
    prioridade: t.prioridade,
    prazo: t.prazo,
    estimativaMin: t.estimativaMin,
    tags: t.tags.length ? t.tags : undefined,
    status: t.status,
  };
}

export async function generateInsights(
  agenda: Agenda,
  ideiasExistentes: string[],
  compromissos: Compromisso[] = [],
): Promise<Insights> {
  const tipo =
    agenda.mode === "daily"
      ? `BRIEFING DIÁRIO de ${agenda.hojeLegivel}. Foco: o que fazer HOJE (incluindo atrasadas) e o que vem nos próximos 2 dias. Ideias de automação: no máximo 1, só se algo saltar aos olhos.`
      : `BRIEFING SEMANAL (domingo à noite). "estaSemana" = semana que começa amanhã (${agenda.semanaAtual.inicio} a ${agenda.semanaAtual.fim}); "proximaSemana" = ${agenda.semanaSeguinte.inicio} a ${agenda.semanaSeguinte.fim}. Faça também uma revisão do que foi concluído nos últimos 7 dias. Sugira até 3 ideias de automação.`;

  const dados = {
    hoje: agenda.hoje,
    atrasadas: agenda.atrasadas.map(compactTask),
    hoje_tarefas: agenda.hojeTarefas.map(compactTask),
    estaSemana: agenda.estaSemana.map(compactTask),
    proximaSemana: agenda.proximaSemana.map(compactTask),
    maisTarde: agenda.maisTarde.map(compactTask),
    semData: agenda.semData.map(compactTask),
    concluidasUltimos7Dias: agenda.concluidasUltimos7Dias.map((t) => ({ nome: t.nome, lista: t.lista })),
    metricas: agenda.metricas,
    ideiasDeAutomacaoJaExistentes: ideiasExistentes,
    compromissosGoogle: compromissos.map((c) => ({ titulo: c.titulo, inicio: c.inicio, fim: c.fim, diaInteiro: c.diaInteiro || undefined })),
  };
  const userText = `${tipo}\n\nDados da agenda (JSON):\n${JSON.stringify(dados, null, 2)}`;

  return geminiJson({ schema: InsightsSchema, system: SYSTEM_PROMPT, userText });
}
