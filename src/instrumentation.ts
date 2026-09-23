// Se ejecuta una vez al arrancar el servidor de Next (solo Node).
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  // En Vercel no hay proceso persistente; JOBS_TICKER=off lo desactiva (p. ej. en la E2E, que dispara las tareas a mano).
  if (process.env.VERCEL || process.env.JOBS_TICKER === "off") return;
  const { startJobTicker } = await import("@/lib/job-ticker");
  startJobTicker();
}
