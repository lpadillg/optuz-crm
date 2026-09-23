"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { clearReminderJobs } from "@/lib/appointment-ops";
import { notifyNoShow, notifyReschedule } from "@/lib/appointment-notify";
import { BookingError, rescheduleAppointment } from "@/lib/appointments";
import { syncStageFromAppointments } from "@/lib/lead-stage";
import { deleteCalendarEvent } from "@/lib/google/calendar";
import { requireAdmin, requireUser } from "@/lib/session";
import { parseLimaLocal } from "@/lib/time";
import { APPOINTMENT_STATUSES } from "@/lib/types";

// Todas las escrituras usan la sesión del usuario: RLS es la barrera (vendedor = su sucursal, admin = todo).

export async function updateAppointmentStatus(formData: FormData) {
  const { supabase } = await requireUser();
  const { id, status } = z
    .object({ id: z.uuid(), status: z.enum(APPOINTMENT_STATUSES) })
    .parse({ id: formData.get("id"), status: formData.get("status") });

  const { data: appt } = await supabase
    .from("appointments")
    .select("google_event_id, branches(google_calendar_id)")
    .eq("id", id)
    .maybeSingle();
  if (!appt) throw new Error("Cita no encontrada");

  const { error } = await supabase.from("appointments").update({ status }).eq("id", id);
  if (error) throw error;
  // El tablero se recalcula solo: atendida sale del embudo, cancelada sin otra cita vuelve a seguimiento.
  const { data: owner } = await supabase.from("appointments").select("lead_id").eq("id", id).maybeSingle();
  if (owner?.lead_id) await syncStageFromAppointments(owner.lead_id as string);
  // Una cita cancelada no debe recibir recordatorios.
  if (status === "cancelada") await clearReminderJobs(id);

  // Cancelar libera el hueco también en Google Calendar (el índice único ya lo libera en la base).
  const calendarId = (appt.branches as unknown as { google_calendar_id: string | null } | null)?.google_calendar_id;
  if (status === "cancelada" && appt.google_event_id && calendarId) {
    await deleteCalendarEvent(calendarId, appt.google_event_id).catch((err) =>
      console.error("[citas] no se pudo borrar el evento de Calendar", err),
    );
  }
  revalidatePath("/citas");
}

/** Vuelve a una pantalla con un aviso (redirect lanza una excepción: no llamarla dentro de try/catch). */
function backTo(path: string, kind: "ok" | "error", message: string): never {
  redirect(`${path}?${kind}=${encodeURIComponent(message)}`);
}

/**
 * Mueve una cita a otra hora (y opcionalmente a otra sucursal) y se lo dice al cliente por WhatsApp.
 *
 * El aviso no es opcional por capricho: una cita que cambia sin que el paciente se entere es peor que no
 * tenerla. Aun así puede desmarcarse, porque a veces el cambio se acordó por teléfono en ese mismo momento.
 */
export async function reprogramarCita(formData: FormData) {
  await requireUser();
  const parsed = z
    .object({
      id: z.uuid(),
      starts_at: z.string().min(1, "Falta la nueva fecha y hora"),
      branch_id: z.string().optional(),
      avisar: z.string().optional(),
    })
    .safeParse(Object.fromEntries(formData));
  if (!parsed.success) backTo("/citas", "error", parsed.error.issues[0].message);

  const startsAt = parseLimaLocal(parsed.data.starts_at);
  if (!startsAt) backTo("/citas", "error", "Fecha y hora inválidas");
  if (startsAt.getTime() <= Date.now()) backTo("/citas", "error", "Esa fecha ya pasó: elige un horario futuro");

  let resultado;
  try {
    resultado = await rescheduleAppointment(parsed.data.id, startsAt, parsed.data.branch_id || undefined);
  } catch (err) {
    if (err instanceof BookingError) backTo("/citas", "error", err.message);
    throw err;
  }

  const cuando = new Intl.DateTimeFormat("es-PE", { timeZone: "America/Lima", dateStyle: "long", timeStyle: "short" }).format(resultado.ahora);
  if (!parsed.data.avisar) {
    revalidatePath("/citas");
    backTo("/citas", "ok", `Cita movida al ${cuando}. No se le avisó al cliente: díselo tú.`);
  }

  const aviso = await notifyReschedule({
    appointmentId: resultado.appointmentId,
    leadId: resultado.leadId,
    antes: resultado.antes,
    ahora: resultado.ahora,
    branch: resultado.branch,
    cambioDeSede: !!parsed.data.branch_id && parsed.data.branch_id !== "",
  });
  revalidatePath("/citas");
  const cola = {
    sent: "Ya se le avisó por WhatsApp.",
    skipped: "No se le avisó: pidió no recibir mensajes.",
    needs_human: "No se le pudo avisar (pasaron 24 h sin que escribiera y falta la plantilla): quedó marcado en el inbox.",
  }[aviso];
  backTo("/citas", aviso === "needs_human" ? "error" : "ok", `Cita movida al ${cuando}. ${cola}`);
}

/**
 * Escribe a quien no vino a su cita para ofrecerle otro horario. Se llama desde el tablero, así que devuelve
 * el resultado en vez de redirigir.
 *
 * El mensaje no sale solo al marcar «no asistió»: alguien de la tienda decide cuándo, porque a veces el
 * cliente avisó por teléfono y escribirle sería quedar mal.
 */
export async function escribirANoAsistio(leadId: string): Promise<{ ok: boolean; error?: string; message?: string }> {
  const { supabase } = await requireUser();
  const id = z.uuid().safeParse(leadId);
  if (!id.success) return { ok: false, error: "Contacto inválido" };

  // Con la sesión del usuario: RLS decide si puede ver a este cliente.
  const { data: appt } = await supabase
    .from("appointments")
    .select("id, lead_id, scheduled_at")
    .eq("lead_id", id.data)
    .eq("status", "no_show")
    .order("scheduled_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!appt) return { ok: false, error: "Este contacto no tiene ninguna cita marcada como «no vino»" };

  const aviso = await notifyNoShow({
    appointmentId: appt.id as string,
    leadId: appt.lead_id as string,
    cuando: new Date(appt.scheduled_at as string),
  });
  revalidatePath("/pipeline");
  if (aviso === "sent") return { ok: true, message: "Le escribimos para ofrecerle otro horario." };
  if (aviso === "skipped") return { ok: false, error: "No se le escribió: pidió no recibir mensajes." };
  return {
    ok: false,
    error: "No se le pudo escribir: pasaron más de 24 h desde su último mensaje y falta la plantilla «cita_no_asistio». Quedó marcado en el inbox.",
  };
}

export async function createPromotion(formData: FormData) {
  const { supabase } = await requireAdmin();
  const input = z
    .object({
      branch_id: z.string(),
      titulo: z.string().trim().min(1),
      descripcion: z.string().trim().min(1),
      valid_from: z.string(),
      valid_to: z.string(),
    })
    .parse(Object.fromEntries(formData));

  // Los <input type="datetime-local"> llegan como hora de Lima ("YYYY-MM-DDTHH:mm").
  const from = parseLimaLocal(input.valid_from);
  const to = parseLimaLocal(input.valid_to);
  if (!from || !to || to <= from) throw new Error("Fechas de vigencia inválidas");

  const { error } = await supabase.from("promotions").insert({
    branch_id: input.branch_id === "all" ? null : input.branch_id,
    titulo: input.titulo,
    descripcion: input.descripcion,
    valid_from: from.toISOString(),
    valid_to: to.toISOString(),
  });
  if (error) throw error;
  revalidatePath("/promociones");
}

/** Corregir una promoción ya creada (antes había que desactivarla y volver a crearla). */
export async function updatePromotion(formData: FormData) {
  const { supabase } = await requireAdmin();
  const input = z
    .object({
      id: z.uuid(),
      branch_id: z.string(),
      titulo: z.string().trim().min(1),
      descripcion: z.string().trim().min(1),
      valid_from: z.string(),
      valid_to: z.string(),
    })
    .parse(Object.fromEntries(formData));

  const from = parseLimaLocal(input.valid_from);
  const to = parseLimaLocal(input.valid_to);
  if (!from || !to || to <= from) throw new Error("Fechas de vigencia inválidas");

  const { error } = await supabase
    .from("promotions")
    .update({
      branch_id: input.branch_id === "all" ? null : input.branch_id,
      titulo: input.titulo,
      descripcion: input.descripcion,
      valid_from: from.toISOString(),
      valid_to: to.toISOString(),
    })
    .eq("id", input.id);
  if (error) throw error;
  revalidatePath("/promociones");
}

export async function togglePromotion(formData: FormData) {
  const { supabase } = await requireAdmin();
  const { id, active } = z
    .object({ id: z.uuid(), active: z.enum(["true", "false"]) })
    .parse({ id: formData.get("id"), active: formData.get("active") });
  const { error } = await supabase.from("promotions").update({ active: active === "true" }).eq("id", id);
  if (error) throw error;
  revalidatePath("/promociones");
}

// ── Sucursales (solo admin). El agente lee nombre y dirección de aquí en cada conversación. ──

const branchFields = z.object({
  nombre: z.string().trim().min(2, "El nombre de la sucursal es obligatorio").max(80, "El nombre es demasiado largo"),
  direccion: z.string().trim().min(5, "La dirección es obligatoria (calle, número y referencia)").max(200, "La dirección es demasiado larga"),
  google_calendar_id: z.string().trim(),
  meta_campaign_ids: z.string(),
});

/** Sin tildes ni mayúsculas: evita "Pucallpa" y "pucallpa " como dos sucursales distintas (el agente las confundiría). */
const norm = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").trim().toLowerCase();

/** IDs de anuncio/campaña separados por coma, espacio o salto de línea. */
const parseIds = (raw: string) => [...new Set(raw.split(/[\s,]+/).filter(Boolean))];

/** Vuelve a /sucursales con un aviso (redirect lanza una excepción: no llamarla dentro de try/catch). */
function backToBranches(kind: "ok" | "error", message: string): never {
  redirect(`/sucursales?${kind}=${encodeURIComponent(message)}`);
}

export async function createBranch(formData: FormData) {
  const { supabase } = await requireAdmin();
  const parsed = branchFields.safeParse({
    nombre: formData.get("nombre") ?? "",
    direccion: formData.get("direccion") ?? "",
    google_calendar_id: formData.get("google_calendar_id") ?? "",
    meta_campaign_ids: formData.get("meta_campaign_ids") ?? "",
  });
  if (!parsed.success) backToBranches("error", parsed.error.issues[0].message);
  const input = parsed.data;

  const { data: existing } = await supabase.from("branches").select("nombre");
  if ((existing ?? []).some((b) => norm(b.nombre) === norm(input.nombre))) {
    backToBranches("error", `Ya existe una sucursal llamada «${input.nombre}»`);
  }

  const { error } = await supabase.from("branches").insert({
    nombre: input.nombre,
    direccion: input.direccion,
    google_calendar_id: input.google_calendar_id || null,
    meta_campaign_ids: parseIds(input.meta_campaign_ids),
    activa: formData.get("activa") === "on",
  });
  if (error) backToBranches("error", error.code === "23505" ? `Ya existe una sucursal llamada «${input.nombre}»` : `No se pudo registrar: ${error.message}`);

  revalidatePath("/sucursales");
  backToBranches("ok", `Sucursal «${input.nombre}» registrada. El agente ya la conoce.`);
}

export async function updateBranch(formData: FormData) {
  const { supabase } = await requireAdmin();
  const id = z.uuid().parse(formData.get("id"));
  const parsed = branchFields.safeParse({
    nombre: formData.get("nombre") ?? "",
    direccion: formData.get("direccion") ?? "",
    google_calendar_id: formData.get("google_calendar_id") ?? "",
    meta_campaign_ids: formData.get("meta_campaign_ids") ?? "",
  });
  if (!parsed.success) backToBranches("error", parsed.error.issues[0].message);
  const input = parsed.data;

  const { data: others } = await supabase.from("branches").select("nombre").neq("id", id);
  if ((others ?? []).some((b) => norm(b.nombre) === norm(input.nombre))) {
    backToBranches("error", `Ya existe otra sucursal llamada «${input.nombre}»`);
  }

  const { error } = await supabase
    .from("branches")
    .update({
      nombre: input.nombre,
      direccion: input.direccion,
      google_calendar_id: input.google_calendar_id || null,
      meta_campaign_ids: parseIds(input.meta_campaign_ids),
      activa: formData.get("activa") === "on",
    })
    .eq("id", id);
  if (error) backToBranches("error", `No se pudo guardar: ${error.message}`);

  revalidatePath("/sucursales");
  backToBranches("ok", `Sucursal «${input.nombre}» guardada.`);
}
