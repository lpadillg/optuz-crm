import { NextResponse } from "next/server";
import { env } from "@/lib/env";
import { runDueJobs } from "@/lib/jobs";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * Dispara la cola de trabajos (reintentos, seguimientos, recordatorios…). Pensado para un cron externo cada minuto
 * (Vercel Cron, pg_cron + pg_net de Supabase, cron-job.org…). Protegido con CRON_SECRET:
 *   Authorization: Bearer <CRON_SECRET>   (Vercel Cron lo manda solo)   o   x-cron-secret: <CRON_SECRET>
 */
async function handle(req: Request) {
  const secret = env.cronSecret;
  if (!secret) return NextResponse.json({ error: "CRON_SECRET no está configurado" }, { status: 503 });
  const given = req.headers.get("x-cron-secret") ?? req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (given !== secret) return NextResponse.json({ error: "No autorizado" }, { status: 401 });

  const result = await runDueJobs();
  return NextResponse.json({ ok: true, ...result });
}

export const GET = handle;
export const POST = handle;
