"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { clearReminderJobs } from "@/lib/appointment-ops";
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
