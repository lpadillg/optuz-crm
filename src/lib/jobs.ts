import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Cola de trabajos con reintentos (tabla `jobs`). Todo lo que no debe perderse ni bloquear el webhook pasa por aquí:
 * responder con el agente, descargar medios, recordatorios, seguimientos, escalamientos…
 *
 *  - `enqueue` guarda la tarea (con clave de deduplicación opcional: p. ej. "agent:<conversación>").
 *  - `runDueJobs` reclama las vencidas (FOR UPDATE SKIP LOCKED: varios trabajadores no se pisan), las ejecuta y, si fallan,
 *    reintenta con espera creciente; agotados los intentos ejecuta el manejador `onGiveUp` (p. ej. avisar a una persona).
 *  - Quién la dispara: el webhook (justo después de responder a Meta), el ticker local (src/instrumentation.ts) y, en la
 *    nube, un cron que llame a /api/jobs/run (README → «Tareas en segundo plano»).
 */

export interface Job {
  id: string;
  kind: string;
  payload: Record<string, unknown>;
  attempts: number;
  max_attempts: number;
  run_at: string;
}

/** Devolver `rescheduleMs` = «todavía no: vuelve a intentarlo dentro de X ms» (no cuenta como intento fallido). */
export type HandlerResult = void | { rescheduleMs: number };

interface Registered {
  run: (payload: Record<string, unknown>, job: Job) => Promise<HandlerResult>;
  onGiveUp?: (payload: Record<string, unknown>, err: unknown) => Promise<void>;
}
const registry = new Map<string, Registered>();

export function registerJob(kind: string, run: Registered["run"], onGiveUp?: Registered["onGiveUp"]) {
  registry.set(kind, { run, onGiveUp });
}

export interface EnqueueOptions {
  kind: string;
  payload?: Record<string, unknown>;
  runAt?: Date;
  /** Una sola tarea PENDIENTE por clave. */
  dedupeKey?: string;
  maxAttempts?: number;
  /** Si ya hay una pendiente con la misma clave, la adelanta/atrasa a `runAt` en vez de ignorar la nueva (agrupa ráfagas). */
  debounce?: boolean;
}

export async function enqueue(opts: EnqueueOptions): Promise<void> {
  const db = createAdminClient();
  const row = {
    kind: opts.kind,
    payload: opts.payload ?? {},
    run_at: (opts.runAt ?? new Date()).toISOString(),
    dedupe_key: opts.dedupeKey ?? null,
    ...(opts.maxAttempts && { max_attempts: opts.maxAttempts }),
  };
  const { error } = await db.from("jobs").insert(row);
  if (!error) return;
  if (error.code === "23505" && opts.dedupeKey) {
    if (opts.debounce) await db.from("jobs").update({ run_at: row.run_at, payload: row.payload }).eq("dedupe_key", opts.dedupeKey).eq("status", "pending");
    return; // ya había una pendiente: no se duplica
  }
  throw error;
}

/** ¿Hay alguna tarea viva (pendiente o en curso) de ese tipo para esa conversación? */
export async function hasLiveJob(kind: string, conversationId: string): Promise<boolean> {
  const { count, error } = await createAdminClient()
    .from("jobs")
    .select("id", { count: "exact", head: true })
    .eq("kind", kind)
    .in("status", ["pending", "running"])
    .contains("payload", { conversationId });
  if (error) throw error;
  return (count ?? 0) > 0;
}

const BACKOFF_MS = [30_000, 120_000, 600_000];

/** Repaso del tablero una vez por hora: no hace falta más, y así no depende de que alguien escriba. */
async function ensureStageSweep(db: ReturnType<typeof createAdminClient>): Promise<void> {
  // Se programa para la HORA SIGUIENTE, no para ahora: así queda pendiente todo ese rato y el índice único
  // de `dedupe_key` impide crear otra. Programarla para «ya» la ejecutaba y la cerraba al instante, con lo que
  // cada pasada del ticker (20 s) creaba una fila nueva: 180 por hora.
  const next = new Date(Math.floor(Date.now() / 3_600_000) * 3_600_000 + 3_600_000);
  const { error } = await db.from("jobs").insert({
    kind: "lead_stages",
    payload: {},
    run_at: next.toISOString(),
    dedupe_key: `stages:${next.toISOString().slice(0, 13)}`,
    max_attempts: 2,
  });
  // 23505 = ya está programada, que es justo lo que se busca. Cualquier otro fallo hay que verlo: si esto se
  // rompe en silencio, el tablero deja de moverse solo y nadie se entera.
  if (error && error.code !== "23505") console.error("[tablero] no se pudo programar el repaso de etapas", error);
}

/** Ejecuta las tareas vencidas (y las que estas encadenen), hasta `rounds` pasadas. */
export async function runDueJobs(limit = 10, rounds = 3): Promise<{ ran: number; failed: number }> {
  await import("@/lib/job-handlers"); // registra los manejadores (import dinámico para evitar un ciclo)
  const db = createAdminClient();
  await ensureStageSweep(db);
  let ran = 0;
  let failed = 0;

  for (let round = 0; round < rounds; round++) {
    const { data, error } = await db.rpc("claim_jobs", { p_limit: limit });
    if (error) throw error;
    const jobs = (data ?? []) as Job[];
    if (jobs.length === 0) break;

    await Promise.all(
      jobs.map(async (job) => {
        const handler = registry.get(job.kind);
        try {
          if (!handler) throw new Error(`No hay manejador para «${job.kind}»`);
          const result = await handler.run(job.payload, job);
          if (result && "rescheduleMs" in result) {
            await db
              .from("jobs")
              .update({ status: "pending", run_at: new Date(Date.now() + result.rescheduleMs).toISOString(), attempts: Math.max(0, job.attempts - 1), locked_at: null })
              .eq("id", job.id);
            return;
          }
          await db.from("jobs").update({ status: "done", finished_at: new Date().toISOString(), locked_at: null, last_error: null }).eq("id", job.id);
          ran++;
        } catch (err) {
          failed++;
          const message = (err instanceof Error ? err.message : String(err)).slice(0, 500);
          console.error(`[jobs] «${job.kind}» falló (intento ${job.attempts}/${job.max_attempts})`, err);
          if (job.attempts >= job.max_attempts) {
            await db.from("jobs").update({ status: "failed", last_error: message, finished_at: new Date().toISOString(), locked_at: null }).eq("id", job.id);
            await handler?.onGiveUp?.(job.payload, err).catch((e) => console.error("[jobs] onGiveUp falló", e));
          } else {
            const wait = BACKOFF_MS[Math.min(job.attempts - 1, BACKOFF_MS.length - 1)];
            await db
              .from("jobs")
              .update({ status: "pending", last_error: message, run_at: new Date(Date.now() + wait).toISOString(), locked_at: null })
              .eq("id", job.id);
          }
        }
      }),
    );
  }
  return { ran, failed };
}

/** Espera `delayMs` (p. ej. lo que dura el agrupamiento de mensajes) y luego ejecuta lo vencido. Pensada para `after()`. */
export async function kickJobs(delayMs = 0): Promise<void> {
  if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
  await runDueJobs();
}
