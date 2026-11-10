// Chamada genérica ao Google Gemini com saída JSON validada por Zod,
// com troca automática de modelo e novas tentativas quando o Google está sobrecarregado.
// Docs: https://ai.google.dev/gemini-api/docs/structured-output

import { logger, wait } from "@trigger.dev/sdk";
import { z } from "zod";

// Modelo principal + reservas. A env var opcional GEMINI_MODEL força um modelo na frente da fila.
const DEFAULT_MODELS = ["gemini-3.5-flash", "gemini-3.8-flash", "gemini-3.5-flash-lite"];
// Se todos estiverem sobrecarregados, espera e tenta de novo (a espera não consome compute).
const ROUNDS = 3;
const WAIT_BETWEEN_ROUNDS_SECONDS = 30;

interface GeminiResponse {
  candidates?: { content?: { parts?: { text?: string }[] }; finishReason?: string }[];
  promptFeedback?: { blockReason?: string };
  usageMetadata?: { totalTokenCount?: number };
  error?: { code: number; status: string; message: string };
}

class GeminiError extends Error {
  constructor(
    message: string,
    public readonly retryable: boolean,
  ) {
    super(message);
    this.name = "GeminiError";
  }
}

/** Erros em que vale tentar outro modelo (sobrecarga, limite, instabilidade, modelo indisponível). */
function isRetryableStatus(status: number) {
  return status === 404 || status === 429 || status >= 500;
}

function toJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const { $schema: _ignored, ...rest } = z.toJSONSchema(schema) as Record<string, unknown>;
  return rest;
}

async function callOnce<T extends z.ZodType>(
  apiKey: string,
  model: string,
  schema: T,
  system: string,
  userText: string,
  maxOutputTokens: number,
): Promise<z.infer<T>> {
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: "POST",
    headers: { "x-goog-api-key": apiKey, "Content-Type": "application/json" },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: "user", parts: [{ text: userText }] }],
      generationConfig: {
        responseMimeType: "application/json",
        responseJsonSchema: toJsonSchema(schema),
        maxOutputTokens,
      },
    }),
  });

  const data = (await res.json().catch(() => ({}))) as GeminiResponse;
  if (!res.ok) {
    throw new GeminiError(
      `Gemini ${model} falhou (${res.status} ${data.error?.status ?? ""}): ${data.error?.message?.slice(0, 200) ?? ""}`,
      isRetryableStatus(res.status),
    );
  }
  if (data.promptFeedback?.blockReason) {
    throw new GeminiError(`Gemini bloqueou a requisição (${data.promptFeedback.blockReason})`, false);
  }

  const candidate = data.candidates?.[0];
  if (candidate?.finishReason && candidate.finishReason !== "STOP") {
    throw new GeminiError(`Gemini terminou com finishReason=${candidate.finishReason}`, false);
  }
  const text = candidate?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
  if (!text) throw new GeminiError("Gemini retornou resposta vazia", true);

  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new GeminiError("Gemini retornou JSON inválido", true);
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    throw new GeminiError(`JSON do Gemini fora do formato esperado: ${parsed.error.message.slice(0, 200)}`, false);
  }

  logger.info("Gemini respondeu", { model, tokens: data.usageMetadata?.totalTokenCount });
  return parsed.data;
}

/** Pede ao Gemini uma resposta JSON no formato do `schema`. Lança erro se todos os modelos falharem. */
export async function geminiJson<T extends z.ZodType>(params: {
  schema: T;
  system: string;
  userText: string;
  maxOutputTokens?: number;
}): Promise<z.infer<T>> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY is not set");

  const models = [...new Set(process.env.GEMINI_MODEL ? [process.env.GEMINI_MODEL, ...DEFAULT_MODELS] : DEFAULT_MODELS)];
  let lastError: unknown;
  for (let round = 1; round <= ROUNDS; round++) {
    for (const model of models) {
      try {
        return await callOnce(apiKey, model, params.schema, params.system, params.userText, params.maxOutputTokens ?? 8192);
      } catch (err) {
        lastError = err;
        logger.warn("Falha no modelo Gemini", { round, model, error: err instanceof Error ? err.message : String(err) });
        if (err instanceof GeminiError && !err.retryable) throw err; // erro de conteúdo: não adianta trocar
      }
    }
    if (round < ROUNDS) await wait.for({ seconds: WAIT_BETWEEN_ROUNDS_SECONDS });
  }
  throw lastError instanceof Error ? lastError : new Error("Falha ao chamar o Gemini");
}
