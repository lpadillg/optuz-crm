import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Pruebas "en vivo": llaman de verdad a OpenAI (cuestan una fracción de centavo). No corren con `npm test`.
export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  test: { include: ["src/**/*.live.ts"], testTimeout: 120_000 },
});
