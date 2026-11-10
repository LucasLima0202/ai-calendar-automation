import { defineConfig } from "@trigger.dev/sdk";
import { existsSync } from "node:fs";

// Localmente o project ref vem do .env; no GitHub Actions vem dos secrets.
if (!process.env.TRIGGER_PROJECT_REF && existsSync(".env")) process.loadEnvFile(".env");

// O "project ref" (proj_...) fica no .env (TRIGGER_PROJECT_REF) e no secret do GitHub.
const project = process.env.TRIGGER_PROJECT_REF;
if (!project) throw new Error("TRIGGER_PROJECT_REF is not set");

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
