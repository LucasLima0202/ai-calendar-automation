// Formato das ações propostas pela auditoria e executadas (após aprovação) pelo apply.

import { z } from "zod";

export const ActionSchema = z.object({
  n: z.number().int(),
  tipo: z.enum(["mover", "encerrar-serie", "apagar-duplicado", "revisar"]),
  calendarId: z.string(),
  eventId: z.string(),
  titulo: z.string(),
  quando: z.string(),
  detalhe: z.string(),
  destinoCalendarId: z.string().optional(),
  destinoArea: z.string().optional(),
});

export type Action = z.infer<typeof ActionSchema>;
