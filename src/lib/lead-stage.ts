import "server-only";
import { env } from "@/lib/env";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Las etapas del tablero se deducen de hechos, no del criterio de nadie. Aquí viven las que dependen del paso
 * del tiempo o del estado de las citas; las que dependen de un mensaje entrante las pone un trigger en la base.
 */

/**
 * Quien lleva `NO_REPLY_HOURS` sin contestar (el último mensaje es nuestro) pasa a «Sin respuesta»; y quien lleva
 * `ARCHIVE_AFTER_DAYS` ahí sale del tablero, para que esa columna no crezca sin fin.
 * Devuelve cuántos cambiaron, para poder verlo en Sistema.
 */
export async function refreshLeadStages(): Promise<{ sinRespuesta: number; archivados: number }> {
  const db = createAdminClient();
  const quiet = new Date(Date.now() - env.noReplyHours * 3_600_000).toISOString();

  // Conversaciones calladas desde hace rato en las que el último en hablar fuimos nosotros.
  const { data: stale, error } = await db
    .from("conversations")
    .select("lead_id, last_message_at, last_message_sender")
    .in("last_message_sender", ["bot", "humano"])
    .lt("last_message_at", quiet)
    .limit(2000);
  if (error) throw error;

  const ids = (stale ?? []).map((c) => c.lead_id as string);
  let sinRespuesta = 0;
  if (ids.length) {
    // Tener cita por delante manda: esos no se mueven aunque no contesten.
    const { data: moved } = await db
      .from("leads")
      .update({ stage: "sin_respuesta" })
      .in("id", ids)
      .eq("stage", "seguimiento")
      .is("archived_at", null)
      .select("id");
    sinRespuesta = moved?.length ?? 0;
  }

  let archivados = 0;
  if (env.archiveAfterDays > 0) {
    const old = new Date(Date.now() - env.archiveAfterDays * 86_400_000).toISOString();
    const { data: stillQuiet } = await db
      .from("conversations")
      .select("lead_id")
      .in("last_message_sender", ["bot", "humano"])
      .lt("last_message_at", old)
      .limit(2000);
    const oldIds = (stillQuiet ?? []).map((c) => c.lead_id as string);
    if (oldIds.length) {
      const { data: gone } = await db
        .from("leads")
        .update({ archived_at: new Date().toISOString(), archive_reason: "inactivo" })
        .in("id", oldIds)
        .eq("stage", "sin_respuesta")
        .is("archived_at", null)
        .select("id");
      archivados = gone?.length ?? 0;
    }
  }
  return { sinRespuesta, archivados };
}

/**
 * Tras crear, cancelar o marcar una cita, recalcula en qué etapa queda el cliente:
 * con una cita por delante → «Cita agendada»; sin ninguna → vuelve al embudo; atendida → sale del tablero;
 * no vino → «No asistió», que es una columna aparte para poder recuperarlo.
 */
export async function syncStageFromAppointments(leadId: string): Promise<void> {
  const db = createAdminClient();
  const { data: appts, error } = await db
    .from("appointments")
    .select("status, scheduled_at")
    .eq("lead_id", leadId)
    .order("scheduled_at", { ascending: false })
    .limit(50);
  if (error) throw error;

  const now = Date.now();
  const rows = appts ?? [];
  const upcoming = rows.some((a) => ["agendada", "confirmada"].includes(a.status as string) && new Date(a.scheduled_at as string).getTime() > now);

  if (upcoming) {
    await db.from("leads").update({ stage: "cita_agendada", archived_at: null, archive_reason: null }).eq("id", leadId);
    return;
  }

  // Vino: el canal cumplió del todo. Sale del tablero (vuelve solo si escribe otra vez).
  if (rows.some((a) => a.status === "atendida")) {
    await db
      .from("leads")
      .update({ archived_at: new Date().toISOString(), archive_reason: "atendido" })
      .eq("id", leadId)
      .is("archived_at", null);
    return;
  }

  // No vino: a su propia columna del tablero, para que alguien le escriba en vez de darlo por perdido.
  if (rows.some((a) => a.status === "no_show")) {
    await db.from("leads").update({ stage: "no_asistio", archived_at: null, archive_reason: null }).eq("id", leadId);
    return;
  }

  // Canceló y no le queda ninguna: hay que volver a conseguir la cita.
  await db.from("leads").update({ stage: "seguimiento" }).eq("id", leadId).eq("stage", "cita_agendada");
}
