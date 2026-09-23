import "server-only";
import { runDueJobs } from "@/lib/jobs";

let started = false;

/**
 * Ejecuta las tareas vencidas cada `everyMs` (reintentos, seguimientos, recordatorios, escalamientos).
 * Solo para servidores que se quedan encendidos (desarrollo local, `next start`, un VPS). En Vercel no hay proceso vivo:
 * allí se usa un cron que llame a /api/jobs/run (README → «Tareas en segundo plano»).
 */
export function startJobTicker(everyMs = 20_000) {
  if (started) return;
  started = true;
  let running = false;
  const timer = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      await runDueJobs();
    } catch (err) {
      console.error("[jobs] el ticker falló", err);
    } finally {
      running = false;
    }
  }, everyMs);
  timer.unref?.();
  console.info(`[jobs] ticker activo (cada ${everyMs / 1000} s)`);
}
