import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Prueba REAL contra Google Calendar y la base local (src/lib/google/booking.google.ts). No corre con `npm test`.
export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  test: { include: ["src/**/*.google.ts"], testTimeout: 120_000, fileParallelism: false },
});
