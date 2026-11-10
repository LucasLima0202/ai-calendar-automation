// Envio de email via API do Resend (fetch nativo).
// Docs: https://resend.com/docs/api-reference/emails/send-email

export async function sendEmail(params: { subject: string; html: string; idempotencyKey?: string }) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) throw new Error("RESEND_API_KEY is not set");
  const to = process.env.BRIEFING_EMAIL_TO;
  if (!to) throw new Error("BRIEFING_EMAIL_TO is not set");

  const headers: Record<string, string> = {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  };
  // Evita email duplicado se o Trigger.dev reexecutar a mesma tentativa.
  if (params.idempotencyKey) headers["Idempotency-Key"] = params.idempotencyKey;

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers,
    body: JSON.stringify({
      // Sem domínio verificado, o Resend só permite este remetente (e só para o email da sua conta).
      from: "Agenda <onboarding@resend.dev>",
      to: [to],
      subject: params.subject,
      html: params.html,
    }),
  });

  // 409 = esta chave de idempotência já foi usada hoje → o email deste briefing já foi enviado.
  if (res.status === 409 && params.idempotencyKey) {
    return { id: "ja-enviado-anteriormente" };
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Resend falhou (${res.status}): ${text.slice(0, 500)}`);
  }
  return (await res.json()) as { id: string };
}
