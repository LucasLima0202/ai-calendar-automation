import { defineConfig } from "@trigger.dev/sdk";
import { existsSync } from "node:fs";

// Carrega o .env local (no GitHub Actions ele não existe, e tudo bem).
if (!process.env.TRIGGER_PROJECT_REF && existsSync(".env")) process.loadEnvFile(".env");

// Project ref não é segredo (o painel do Trigger.dev manda colocá-lo aqui).
// TRIGGER_PROJECT_REF no .env continua podendo sobrescrever, se um dia mudar de projeto.
const project = process.env.TRIGGER_PROJECT_REF ?? "proj_eazbjvvlmmsolivandag";

export default defineConfig({
  project,
  dirs: ["./src/trigger"],
  maxDuration: 300, // 5 minutos por run é mais que suficiente
  retries: {
    enabledInDev: true,
    default: {
      maxAttempts: 3,
      factor: 2,
      minTimeoutInMs: 5_000,
      maxTimeoutInMs: 60_000,
      randomize: true,
    },
  },
});
