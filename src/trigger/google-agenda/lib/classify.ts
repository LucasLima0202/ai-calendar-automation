// Classifica eventos do Google Agenda por área usando o Gemini.

import { z } from "zod";
import { geminiJson } from "../../shared/gemini.js";
import { CLASSIFIABLE_AREAS, type ClassifiableArea } from "./areas.js";

const ResultSchema = z.object({
  classificacoes: z.array(
    z.object({
      id: z.string(),
      area: z.enum(CLASSIFIABLE_AREAS),
      confianca: z.enum(["alta", "media", "baixa"]),
    }),
  ),
});

const SYSTEM = `Você organiza a agenda de uma pessoa no Brasil. Para cada evento, escolha a área:
- "trabalho": reuniões, clientes, entregas, compromissos profissionais
- "estudos": aulas, cursos, faculdade, desafios, side projects, leituras de estudo
- "pessoal": saúde, academia, médico, família, casa, contas, lazer, aniversários, viagens
Use título, descrição e recorrência. Se não der para saber, escolha a mais provável com confiança "baixa".
Responda com um item para CADA id recebido, sem inventar ids.`;

export interface EventToClassify {
  id: string;
  titulo: string;
  descricao?: string;
  recorrente: boolean;
}

export async function classifyEvents(events: EventToClassify[]) {
  const result = new Map<string, { area: ClassifiableArea; confianca: "alta" | "media" | "baixa" }>();
  const BATCH = 60;
  for (let i = 0; i < events.length; i += BATCH) {
    const batch = events.slice(i, i + BATCH).map((e) => ({
      id: e.id,
      titulo: e.titulo,
      descricao: e.descricao?.slice(0, 150),
      recorrente: e.recorrente,
    }));
    const out = await geminiJson({
      schema: ResultSchema,
      system: SYSTEM,
      userText: `Eventos (JSON):\n${JSON.stringify(batch)}`,
    });
    for (const c of out.classificacoes) result.set(c.id, { area: c.area, confianca: c.confianca });
  }
  return result;
}
