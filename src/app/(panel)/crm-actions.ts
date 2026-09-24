"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { isRedirectError } from "next/dist/client/components/redirect-error";
import { z } from "zod";
import { grantAttention, revokeAll, subjectHash } from "@/lib/consent";
import { env } from "@/lib/env";
import { checkCalendarAccess, deleteCalendarEvent } from "@/lib/google/calendar";
import { normalizePhone, parseTags } from "@/lib/phone";
import { requireAdmin, requireUser, seesAllBranches } from "@/lib/session";
import { setAgentEnabled } from "@/lib/settings";
import { createAdminClient } from "@/lib/supabase/admin";
import { KNOWLEDGE_CATEGORIES, LEAD_ORIGINS, MANUAL_ARCHIVE_REASONS } from "@/lib/types";
import { createTemplate, syncTemplates, TEMPLATE_DEFS, updateTemplate } from "@/lib/whatsapp/templates";
import { MENSAJES } from "@/lib/agent/mensajes";
import { CATEGORIAS, revisarPlantilla, variablesDe } from "@/lib/whatsapp/plantilla-reglas";

// Escrituras con la sesión del usuario: RLS es la barrera (asesor = su sucursal o todas si no tiene una, admin = todo).
// Las de equipo usan la service role, solo después de comprobar que quien llama es admin.

/** Vuelve a una pantalla con un aviso (redirect lanza una excepción: no llamarla dentro de try/catch). */
function back(path: string, kind: "ok" | "error", message: string): never {
  redirect(`${path}?${kind}=${encodeURIComponent(message)}`);
}

// ── Contactos ────────────────────────────────────────────────────────────

export async function createContact(formData: FormData) {
  const { supabase, profile } = await requireUser();
  const parsed = z
    .object({
      nombre: z.string().trim().min(1, "El nombre es obligatorio").max(120),
      phone: z.string().trim().min(1, "El teléfono es obligatorio"),
      email: z.string().trim().max(160),
      branch_id: z.uuid("Elige una sucursal"),
      tags: z.string(),
    })
    .safeParse({
      nombre: formData.get("nombre") ?? "",
      phone: formData.get("phone") ?? "",
      email: formData.get("email") ?? "",
      branch_id: formData.get("branch_id") ?? "",
      tags: formData.get("tags") ?? "",
    });
  if (!parsed.success) back("/leads", "error", parsed.error.issues[0].message);
  const input = parsed.data;

  const phone = normalizePhone(input.phone);
  if (!phone) back("/leads", "error", "El teléfono no es válido (ej. 987654321 o +51987654321)");
  if (input.email && !z.email().safeParse(input.email).success) back("/leads", "error", "El email no es válido");
  if (!seesAllBranches(profile) && input.branch_id !== profile.branch_id) back("/leads", "error", "Solo puedes crear contactos de tu sucursal");

  const { data: lead, error } = await supabase
    .from("leads")
    .insert({
      nombre: input.nombre,
      phone,
      email: input.email || null,
      branch_id: input.branch_id,
      tags: parseTags(input.tags),
      source: "otro",
    })
    .select("id")
    .single();
  if (error) back("/leads", "error", error.code === "23505" ? `Ya existe un contacto con el teléfono ${phone}` : `No se pudo crear: ${error.message}`);

  // Con conversación propia, el asesor puede escribirle desde el inbox (pausando el bot) y sus mensajes futuros caen en el mismo hilo.
  await supabase.from("conversations").insert({ lead_id: lead.id });
  revalidatePath("/leads");
  redirect(`/leads/${lead.id}?ok=${encodeURIComponent("Contacto creado")}`);
}

export async function updateContact(formData: FormData) {
  const { supabase, profile } = await requireUser();
  const id = z.uuid().parse(formData.get("id"));
  const path = `/leads/${id}`;
  const parsed = z
    .object({
      nombre: z.string().trim().max(120),
      email: z.string().trim().max(160),
      tags: z.string(),
      notes: z.string().max(4000),
      origin: z.enum(LEAD_ORIGINS),
      branch_id: z.string(),
    })
    .safeParse({
      nombre: formData.get("nombre") ?? "",
      email: formData.get("email") ?? "",
      tags: formData.get("tags") ?? "",
      notes: formData.get("notes") ?? "",
      origin: formData.get("origin") ?? "otro",
      branch_id: formData.get("branch_id") ?? "",
    });
  if (!parsed.success) back(path, "error", "Datos inválidos");
  const input = parsed.data;
  if (input.email && !z.email().safeParse(input.email).success) back(path, "error", "El email no es válido");

  const patch: Record<string, unknown> = {
    nombre: input.nombre || null,
    email: input.email || null,
    tags: parseTags(input.tags),
    notes: input.notes.trim() || null,
    origin: input.origin,
  };
  // Solo el admin cambia la sucursal (un vendedor perdería el acceso al contacto por RLS).
  if (profile.role === "admin" && z.uuid().safeParse(input.branch_id).success) patch.branch_id = input.branch_id;

  const { data: before } = await supabase.from("leads").select("opt_out").eq("id", id).maybeSingle();
  const { error } = await supabase.from("leads").update(patch).eq("id", id);
  if (error) back(path, "error", `No se pudo guardar: ${error.message}`);

  // La baja/alta es un consentimiento: cambia por aquí solo con constancia de quién y cuándo.
  const wantsOptOut = formData.get("opt_out") === "on";
  if (before && before.opt_out !== wantsOptOut) {
    const entry = { leadId: id, channel: "panel" as const, actorId: profile.id, evidence: "Cambio manual desde la ficha del contacto" };
    if (wantsOptOut) await revokeAll(createAdminClient(), entry);
    else await grantAttention(createAdminClient(), entry);
  }
  revalidatePath("/leads");
  revalidatePath("/pipeline");
  back(path, "ok", "Contacto guardado");
}

// ── Respuestas rápidas (admin) ───────────────────────────────────────────

/** Lo que vale para una respuesta rápida, al crearla y al corregirla. */
const quickReplyFields = z.object({
  atajo: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9_-]{1,30}$/, "El atajo solo admite letras, números, guion y guion bajo (máx. 30)"),
  titulo: z.string().trim().min(1, "El título es obligatorio").max(80),
  cuerpo: z.string().trim().min(1, "El mensaje es obligatorio").max(1500),
});

export async function createQuickReply(formData: FormData) {
  const { supabase } = await requireAdmin();
  const parsed = quickReplyFields
    .safeParse({
      atajo: (formData.get("atajo") ?? "").toString().replace(/^\//, ""),
      titulo: formData.get("titulo") ?? "",
      cuerpo: formData.get("cuerpo") ?? "",
    });
  if (!parsed.success) back("/respuestas", "error", parsed.error.issues[0].message);
  const { error } = await supabase.from("quick_replies").insert(parsed.data);
  if (error) back("/respuestas", "error", error.code === "23505" ? `Ya existe el atajo /${parsed.data.atajo}` : error.message);
  revalidatePath("/respuestas");
  back("/respuestas", "ok", `Respuesta /${parsed.data.atajo} creada`);
}

/**
 * Corrige una respuesta rápida. Antes solo se podía borrar y volver a crearla, lo que obliga a reescribirla
 * entera por cambiar una palabra —y a acordarse del atajo— con el riesgo de dejar al equipo sin ella.
 */
export async function updateQuickReply(formData: FormData) {
  const { supabase } = await requireAdmin();
  const id = z.uuid().safeParse(formData.get("id"));
  const parsed = quickReplyFields.safeParse({
    atajo: (formData.get("atajo") ?? "").toString().replace(/^\//, ""),
    titulo: formData.get("titulo") ?? "",
    cuerpo: formData.get("cuerpo") ?? "",
  });
  if (!id.success) back("/respuestas", "error", "Respuesta no encontrada");
  if (!parsed.success) back("/respuestas", "error", parsed.error.issues[0].message);

  const { data, error } = await supabase.from("quick_replies").update(parsed.data).eq("id", id.data).select("id");
  if (error) back("/respuestas", "error", error.code === "23505" ? `Ya existe el atajo /${parsed.data.atajo}` : error.message);
  // Un UPDATE que no alcanza ninguna fila no da error: se quedaría todo igual y nadie se enteraría.
  if (!data?.length) back("/respuestas", "error", "No se guardó: esa respuesta ya no existe o tu usuario no puede editarla.");
  revalidatePath("/respuestas");
  back("/respuestas", "ok", `Respuesta /${parsed.data.atajo} actualizada`);
}

export async function deleteQuickReply(formData: FormData) {
  const { supabase } = await requireAdmin();
  const id = z.uuid().parse(formData.get("id"));
  const { error } = await supabase.from("quick_replies").delete().eq("id", id);
  if (error) back("/respuestas", "error", error.message);
  revalidatePath("/respuestas");
  back("/respuestas", "ok", "Respuesta eliminada");
}

// ── Base de conocimiento del agente (admin) ──────────────────────────────

const knowledgeFields = z.object({
  titulo: z.string().trim().min(2, "El título es obligatorio").max(120),
  contenido: z.string().trim().min(5, "El contenido es obligatorio").max(4000, "El contenido es demasiado largo (máx. 4000 caracteres)"),
  // La categoría solo ordena la pantalla: si llega cualquier cosa, va a «otros» en vez de romper el guardado.
  categoria: z.enum(KNOWLEDGE_CATEGORIES).catch("otros"),
});

const knowledgeInput = (formData: FormData) => ({
  titulo: formData.get("titulo") ?? "",
  contenido: formData.get("contenido") ?? "",
  categoria: formData.get("categoria") ?? "otros",
});

export async function createKnowledge(formData: FormData) {
  const { supabase } = await requireAdmin();
  const parsed = knowledgeFields.safeParse(knowledgeInput(formData));
  if (!parsed.success) back("/conocimiento", "error", parsed.error.issues[0].message);
  const { error } = await supabase.from("knowledge_base").insert(parsed.data);
  if (error) back("/conocimiento", "error", error.message);
  revalidatePath("/conocimiento");
  back("/conocimiento", "ok", "Agregado. El agente lo usará desde la siguiente conversación.");
}

export async function updateKnowledge(formData: FormData) {
  const { supabase } = await requireAdmin();
  const id = z.uuid().parse(formData.get("id"));
  const parsed = knowledgeFields.safeParse(knowledgeInput(formData));
  if (!parsed.success) back("/conocimiento", "error", parsed.error.issues[0].message);
  const { error } = await supabase
    .from("knowledge_base")
    .update({ ...parsed.data, activa: formData.get("activa") === "on" })
    .eq("id", id);
  if (error) back("/conocimiento", "error", error.message);
  revalidatePath("/conocimiento");
  back("/conocimiento", "ok", "Guardado");
}

/** Enciende o apaga una ficha de un clic, sin pasar por el formulario de edición. */
export async function toggleKnowledge(formData: FormData) {
  const { supabase } = await requireAdmin();
  const id = z.uuid().parse(formData.get("id"));
  const activa = formData.get("activa") === "true";
  const { error } = await supabase.from("knowledge_base").update({ activa }).eq("id", id);
  if (error) back("/conocimiento", "error", error.message);
  revalidatePath("/conocimiento");
  back("/conocimiento", "ok", activa ? "Activada. El agente la usará desde la siguiente conversación." : "Desactivada. El agente deja de usarla.");
}

/** Activa de golpe todo lo que quedó apagado: tras revisar una carga completa, encenderlas de a una es absurdo. */
export async function activateAllKnowledge() {
  const { supabase } = await requireAdmin();
  const { data, error } = await supabase.from("knowledge_base").update({ activa: true }).eq("activa", false).select("id");
  if (error) back("/conocimiento", "error", error.message);
  revalidatePath("/conocimiento");
  const n = data?.length ?? 0;
  back("/conocimiento", "ok", n === 1 ? "1 ficha activada" : `${n} fichas activadas`);
}

export async function deleteKnowledge(formData: FormData) {
  const { supabase } = await requireAdmin();
  const id = z.uuid().parse(formData.get("id"));
  const { error } = await supabase.from("knowledge_base").delete().eq("id", id);
  if (error) back("/conocimiento", "error", error.message);
  revalidatePath("/conocimiento");
  back("/conocimiento", "ok", "Eliminado");
}

// ── Equipo (admin) ───────────────────────────────────────────────────────

/**
 * Sucursal de un usuario: el administrador no lleva (ve todas); un asesor puede llevar una (solo esa) o ninguna (atiende todas).
 * Este canal es de citas y lo atienden 1 o 2 personas, así que «todas» es lo normal. Valida que la sucursal exista.
 */
async function teamBranch(role: "admin" | "vendedor", raw: string): Promise<string | null> {
  if (role === "admin" || raw === "") return null;
  if (!z.uuid().safeParse(raw).success) back("/equipo", "error", "Sucursal inválida");
  const { data } = await createAdminClient().from("branches").select("id").eq("id", raw).maybeSingle();
  if (!data) back("/equipo", "error", "Esa sucursal no existe");
  return raw;
}

export async function createTeamMember(formData: FormData) {
  await requireAdmin();
  const parsed = z
    .object({
      nombre: z.string().trim().min(2, "El nombre es obligatorio").max(80),
      email: z.email("El email no es válido"),
      password: z.string().min(8, "La contraseña debe tener al menos 8 caracteres").max(72),
      role: z.enum(["admin", "vendedor"]),
      branch_id: z.string(),
    })
    .safeParse({
      nombre: formData.get("nombre") ?? "",
      email: (formData.get("email") ?? "").toString().trim().toLowerCase(),
      password: formData.get("password") ?? "",
      role: formData.get("role") ?? "",
      branch_id: formData.get("branch_id") ?? "",
    });
  if (!parsed.success) back("/equipo", "error", parsed.error.issues[0].message);
  const input = parsed.data;
  const branchId = await teamBranch(input.role, input.branch_id);

  const db = createAdminClient();
  const { data: created, error: authErr } = await db.auth.admin.createUser({ email: input.email, password: input.password, email_confirm: true });
  if (authErr) back("/equipo", "error", /already|registered/i.test(authErr.message) ? "Ya existe un usuario con ese email" : `No se pudo crear: ${authErr.message}`);

  const { error: profileErr } = await db.from("users").insert({
    id: created.user.id,
    nombre: input.nombre,
    email: input.email,
    role: input.role,
    branch_id: branchId,
  });
  if (profileErr) {
    await db.auth.admin.deleteUser(created.user.id); // sin perfil no podría entrar al panel
    back("/equipo", "error", `No se pudo crear el perfil: ${profileErr.message}`);
  }
  revalidatePath("/equipo");
  back("/equipo", "ok", `Usuario ${input.email} creado`);
}

export async function updateTeamMember(formData: FormData) {
  const { profile } = await requireAdmin();
  const id = z.uuid().parse(formData.get("id"));
  const parsed = z
    .object({ nombre: z.string().trim().min(2).max(80), role: z.enum(["admin", "vendedor"]), branch_id: z.string() })
    .safeParse({ nombre: formData.get("nombre") ?? "", role: formData.get("role") ?? "", branch_id: formData.get("branch_id") ?? "" });
  if (!parsed.success) back("/equipo", "error", "Datos inválidos");
  const input = parsed.data;
  if (id === profile.id && input.role !== "admin") back("/equipo", "error", "No puedes quitarte a ti mismo el rol de administrador");
  const branchId = await teamBranch(input.role, input.branch_id);

  const { error } = await createAdminClient()
    .from("users")
    .update({ nombre: input.nombre, role: input.role, branch_id: branchId })
    .eq("id", id);
  if (error) back("/equipo", "error", error.message);
  revalidatePath("/equipo");
  back("/equipo", "ok", "Guardado");
}

export async function resetTeamMemberPassword(formData: FormData) {
  await requireAdmin();
  const id = z.uuid().parse(formData.get("id"));
  const password = z.string().min(8, "La contraseña debe tener al menos 8 caracteres").max(72).safeParse(formData.get("password") ?? "");
  if (!password.success) back("/equipo", "error", password.error.issues[0].message);
  const { error } = await createAdminClient().auth.admin.updateUserById(id, { password: password.data });
  if (error) back("/equipo", "error", `No se pudo cambiar: ${error.message}`);
  back("/equipo", "ok", "Contraseña actualizada");
}

// ── Reactivar atención (cliente dado de baja) ────────────────────────────

/** Quita la baja del cliente y devuelve el chat al bot. Solo debe usarse si el cliente lo pidió; queda registrado quién lo hizo. */
export async function reactivateAttention(conversationId: string): Promise<{ ok: boolean; error?: string }> {
  const { supabase, profile } = await requireUser();
  const id = z.uuid().safeParse(conversationId);
  if (!id.success) return { ok: false, error: "Conversación inválida" };

  // Con la sesión del usuario: RLS decide si puede ver esta conversación (su sucursal).
  const { data: conv } = await supabase.from("conversations").select("id, lead_id").eq("id", id.data).maybeSingle();
  if (!conv) return { ok: false, error: "Conversación no encontrada" };

  const db = createAdminClient();
  await grantAttention(db, {
    leadId: conv.lead_id as string,
    channel: "panel",
    actorId: profile.id,
    evidence: "Reactivación manual desde el chat (el cliente lo pidió)",
  });
  const { error } = await db.from("conversations").update({ bot_active: true, requires_human: false, handoff_reason: null }).eq("id", id.data);
  if (error) return { ok: false, error: "Se quitó la baja, pero no se pudo reactivar el bot" };
  revalidatePath("/inbox");
  return { ok: true };
}

// ── Interruptor general del agente ───────────────────────────────────────

/**
 * Apaga o enciende el agente para todo el negocio. Apagado no sale nada automático hacia el cliente:
 * ni respuestas, ni seguimientos, ni recordatorios de cita. Los chats siguen llegando al inbox.
 */
export async function toggleAgent(formData: FormData) {
  const { profile } = await requireAdmin();
  const enabled = formData.get("enabled") === "true";
  const reason = (formData.get("reason") ?? "").toString();

  try {
    await setAgentEnabled(enabled, profile.id, reason);
  } catch (err) {
    console.error("[ajustes] no se pudo cambiar el interruptor del agente", err);
    back("/agente", "error", "No se pudo cambiar el estado del agente");
  }
  revalidatePath("/", "layout");
  back("/agente", "ok", enabled ? "El agente vuelve a atender" : "Agente apagado: no saldrá ningún mensaje automático");
}

// ── Sacar del tablero lo que no pertenece al embudo ──────────────────────

/**
 * Archiva un contacto: sale del tablero pero su chat sigue llegando al inbox. El motivo decide si vuelve solo
 * cuando escriba de nuevo: «no le interesa» vuelve (una campaña puede reactivarlo), «no es un cliente» no.
 */
export async function archiveLead(leadId: string, reason: string): Promise<{ ok: boolean; error?: string }> {
  const { supabase } = await requireUser();
  const id = z.uuid().safeParse(leadId);
  const motivo = z.enum(MANUAL_ARCHIVE_REASONS).safeParse(reason);
  if (!id.success || !motivo.success) return { ok: false, error: "Datos inválidos" };

  // Con la sesión del usuario: RLS decide si puede ver este contacto (su sucursal).
  const { data: lead } = await supabase.from("leads").select("id").eq("id", id.data).maybeSingle();
  if (!lead) return { ok: false, error: "Contacto no encontrado" };

  const { error } = await createAdminClient()
    .from("leads")
    .update({ archived_at: new Date().toISOString(), archive_reason: motivo.data })
    .eq("id", id.data);
  if (error) return { ok: false, error: "No se pudo archivar" };
  revalidatePath("/pipeline");
  revalidatePath("/leads");
  return { ok: true };
}

/** Devuelve un contacto archivado al tablero. */
export async function unarchiveLead(formData: FormData) {
  const { supabase } = await requireUser();
  const id = z.uuid().parse(formData.get("id"));
  const { data: lead } = await supabase.from("leads").select("id").eq("id", id).maybeSingle();
  if (!lead) back(`/leads/${id}`, "error", "Contacto no encontrado");

  const { error } = await createAdminClient().from("leads").update({ archived_at: null, archive_reason: null }).eq("id", id);
  if (error) back(`/leads/${id}`, "error", "No se pudo recuperar el contacto");
  revalidatePath("/pipeline");
  back(`/leads/${id}`, "ok", "El contacto vuelve al tablero");
}

// ── Opinión sobre una respuesta del bot (👍 / 👎) ────────────────────────

/** El equipo califica una respuesta del bot: sirve para ver dónde falla y afinar el conocimiento y las instrucciones. Repetir el mismo voto lo quita. */
export async function setMessageFeedback(messageId: string, value: 1 | -1 | null, note?: string): Promise<{ ok: boolean; error?: string }> {
  const { supabase } = await requireUser();
  const id = z.uuid().safeParse(messageId);
  if (!id.success || (value !== null && value !== 1 && value !== -1)) return { ok: false, error: "Datos inválidos" };
  // Con la sesión del usuario: RLS decide si puede ver este mensaje (su sucursal).
  const { data: msg } = await supabase.from("messages").select("id, sender").eq("id", id.data).maybeSingle();
  if (!msg) return { ok: false, error: "Mensaje no encontrado" };
  if (msg.sender !== "bot") return { ok: false, error: "Solo se califican las respuestas del bot" };
  const { error } = await createAdminClient()
    .from("messages")
    .update({ feedback: value, feedback_note: value === -1 ? (note?.trim().slice(0, 300) || null) : null })
    .eq("id", id.data);
  if (error) return { ok: false, error: "No se pudo guardar la opinión" };
  revalidatePath("/sistema");
  return { ok: true };
}

// ── Unir contactos duplicados ────────────────────────────────────────────

/**
 * Une dos contactos que son la misma persona (p. ej. escribió con dos números): pasa al contacto destino los mensajes, notas,
 * citas y consentimientos del otro y lo elimina. No se puede deshacer. Solo administradores.
 */
export async function mergeContacts(formData: FormData) {
  const { profile } = await requireAdmin();
  const target = z.uuid().parse(formData.get("target_id"));
  const path = `/leads/${target}`;
  const source = z.uuid().safeParse(formData.get("source_id"));
  if (!source.success) back(path, "error", "Elige el contacto que quieres unir");
  if (source.data === target) back(path, "error", "Elige otro contacto, no el mismo");
  if ((formData.get("confirmacion") ?? "").toString().trim().toUpperCase() !== "UNIR") back(path, "error", "Para unir escribe UNIR en la confirmación");

  const db = createAdminClient();
  const { data: src } = await db.from("leads").select("id, nombre, phone").eq("id", source.data).maybeSingle();
  if (!src) back(path, "error", "El contacto que elegiste ya no existe");
  const { data: srcConv } = await db.from("conversations").select("id").eq("lead_id", source.data).maybeSingle();

  const { error } = await db.rpc("merge_leads", { p_target: target, p_source: source.data });
  if (error) {
    console.error("[unir contactos]", error);
    back(path, "error", "No se pudo unir los contactos");
  }
  // Tareas pendientes de la conversación que ya no existe (respuesta del bot, seguimiento…): no tienen a quién responder.
  if (srcConv) await db.from("jobs").delete().eq("status", "pending").contains("payload", { conversationId: srcConv.id });

  // Constancia en las notas internas del chat resultante
  const { data: conv } = await db.from("conversations").select("id").eq("lead_id", target).maybeSingle();
  if (conv) {
    await db.from("conversation_notes").insert({
      conversation_id: conv.id,
      author_id: profile.id,
      body: `Contacto unido: ${src!.nombre ?? src!.phone ?? "otro contacto"} pasó a esta ficha (${profile.nombre}).`,
    });
  }
  revalidatePath("/leads");
  revalidatePath("/inbox");
  back(path, "ok", "Contactos unidos: mensajes, citas y consentimientos quedaron en esta ficha");
}

// ── Eliminar los datos de un contacto (derecho de cancelación) ───────────

/**
 * Borra TODO lo del contacto (chat, notas, citas, consentimientos y los eventos crudos de WhatsApp que contienen su
 * número) y deja solo una constancia sin datos: un hash del identificador, la fecha y quién lo hizo. Solo administradores.
 */
export async function deleteContactData(formData: FormData) {
  const { profile } = await requireAdmin();
  const id = z.uuid().parse(formData.get("id"));
  const back_ = `/leads/${id}`;
  if ((formData.get("confirmacion") ?? "").toString().trim().toUpperCase() !== "ELIMINAR") {
    back(back_, "error", "Para eliminar escribe ELIMINAR en la confirmación");
  }
  const motivo = (formData.get("motivo") ?? "").toString().trim().slice(0, 300) || null;

  const db = createAdminClient();
  const { data: lead } = await db.from("leads").select("id, phone, bsuid").eq("id", id).maybeSingle();
  if (!lead) back("/leads", "error", "El contacto ya no existe");

  // 1. Citas (su llave foránea no se borra sola) y sus eventos en Google Calendar
  const { data: appts } = await db.from("appointments").select("id, google_event_id, branches(google_calendar_id)").eq("lead_id", id);
  for (const a of appts ?? []) {
    const calendarId = (a.branches as unknown as { google_calendar_id: string | null } | null)?.google_calendar_id;
    if (a.google_event_id && calendarId) {
      await deleteCalendarEvent(calendarId, a.google_event_id as string).catch((err) => console.error("[eliminar] evento de Calendar", err));
    }
  }
  const { error: apptErr } = await db.from("appointments").delete().eq("lead_id", id);
  if (apptErr) back(back_, "error", `No se pudo eliminar: ${apptErr.message}`);

  // 2. Eventos crudos del webhook (guardan el número y el texto): se ubican por el id de cada mensaje
  const { data: convs } = await db.from("conversations").select("id").eq("lead_id", id);
  const convIds = (convs ?? []).map((c) => c.id as string);
  if (convIds.length) {
    // Archivos del chat (imágenes, notas de voz, documentos): también son datos personales.
    const { data: withFiles } = await db.from("messages").select("attachments").in("conversation_id", convIds);
    const files = (withFiles ?? []).flatMap((m) => ((m.attachments as { storage_path?: string }[]) ?? []).map((a) => a.storage_path).filter((p): p is string => !!p));
    if (files.length) await db.storage.from("chat-media").remove(files);
    const { data: msgs } = await db.from("messages").select("wa_message_id").in("conversation_id", convIds).not("wa_message_id", "is", null);
    const keys = (msgs ?? []).flatMap((m) => [`msg:${m.wa_message_id}`, ...(["failed", "sent", "delivered", "read"] as const).map((st) => `status:${m.wa_message_id}:${st}`)]);
    for (let i = 0; i < keys.length; i += 200) await db.from("webhook_events").delete().in("event_id", keys.slice(i, i + 200));
  }

  // 3. Constancia SIN datos, y luego el contacto (conversaciones, mensajes, notas y consentimientos caen en cascada)
  const { data: logged, error: logErr } = await db
    .from("deletion_log")
    .insert({ subject_hash: subjectHash(lead!.phone as string | null, lead!.bsuid as string | null), motivo, actor_id: profile.id })
    .select("id")
    .single();
  if (logErr) back(back_, "error", `No se pudo dejar constancia: ${logErr.message}`);
  const { error: delErr } = await db.from("leads").delete().eq("id", id);
  if (delErr) {
    await db.from("deletion_log").delete().eq("id", logged.id); // no quedó eliminado: no dejamos constancia de algo que no ocurrió
    back(back_, "error", `No se pudo eliminar: ${delErr.message}`);
  }

  revalidatePath("/leads");
  revalidatePath("/pipeline");
  revalidatePath("/inbox");
  back("/leads", "ok", "Contacto eliminado. Quedó constancia sin datos personales.");
}

// ── Google Calendar: probar la conexión de una sucursal (admin) ──────────

/** Lee la disponibilidad y crea y borra un evento de prueba en el calendario de la sucursal. */
export async function testBranchCalendar(formData: FormData) {
  const { supabase } = await requireAdmin();
  const id = z.uuid().parse(formData.get("id"));
  const { data: branch } = await supabase.from("branches").select("nombre, google_calendar_id").eq("id", id).maybeSingle();
  if (!branch) back("/sucursales", "error", "La sucursal no existe");
  if (!branch.google_calendar_id) back("/sucursales", "error", `${branch.nombre} no tiene un ID de Google Calendar: agrégalo en «Editar».`);
  if (!env.googleConfigured) {
    back("/sucursales", "error", "Google Calendar aún no está configurado: faltan las credenciales de la cuenta de servicio (README → «Conectar Google Calendar»).");
  }

  const result = await checkCalendarAccess(branch.google_calendar_id as string);
  if (result.ok) back("/sucursales", "ok", `${branch.nombre}: conexión correcta con Google Calendar (${result.message.toLowerCase()}). El agente ya puede agendar aquí.`);
  back("/sucursales", "error", `${branch.nombre}: ${result.message}`);
}

// ── Sistema: reintentar tareas fallidas (admin) ──────────────────────────

export async function retryFailedJob(formData: FormData) {
  await requireAdmin();
  const id = z.uuid().parse(formData.get("id"));
  const { error } = await createAdminClient()
    .from("jobs")
    .update({ status: "pending", attempts: 0, run_at: new Date().toISOString(), last_error: null, finished_at: null })
    .eq("id", id)
    .eq("status", "failed");
  if (error) back("/sistema", "error", `No se pudo reintentar: ${error.message}`);
  revalidatePath("/sistema");
  back("/sistema", "ok", "La tarea volvió a la cola; se ejecutará en unos segundos.");
}

// ── Plantillas de WhatsApp (admin) ───────────────────────────────────────

export async function syncTemplatesAction() {
  await requireAdmin();
  try {
    const n = await syncTemplates();
    revalidatePath("/plantillas");
    back("/plantillas", "ok", `Sincronizadas ${n} plantilla${n === 1 ? "" : "s"} desde Meta.`);
  } catch (err) {
    if (isRedirectError(err)) throw err;
    back("/plantillas", "error", err instanceof Error ? err.message : "No se pudo sincronizar");
  }
}

/** Envía a Meta una de las plantillas que el CRM sabe crear, para que la revise y la apruebe. */
export async function createReminderTemplate(formData?: FormData) {
  await requireAdmin();
  const pedida = formData?.get("name");
  const def = TEMPLATE_DEFS.find((t) => t.name === pedida) ?? TEMPLATE_DEFS[0];
  try {
    const r = await createTemplate(def);
    revalidatePath("/plantillas");
    back("/plantillas", "ok", `Plantilla «${def.name}» enviada a Meta (estado: ${r.status}). La revisión tarda de minutos a unas horas: luego pulsa «Sincronizar».`);
  } catch (err) {
    if (isRedirectError(err)) throw err;
    back("/plantillas", "error", err instanceof Error ? err.message : "No se pudo crear la plantilla");
  }
}

/**
 * Lleva a Meta los cambios de una de las plantillas que el CRM trae programadas: hoy, sus botones.
 *
 * Meta la vuelve a revisar y, mientras tanto, se sigue enviando la versión anterior, así que no se pierde
 * ningún recordatorio por hacer esto.
 */
export async function actualizarPlantilla(formData: FormData) {
  await requireAdmin();
  const nombre = String(formData.get("name") ?? "");
  const def = TEMPLATE_DEFS.find((t) => t.name === nombre);
  if (!def) back("/plantillas", "error", "Esa plantilla no la maneja el CRM");

  const { data: fila } = await createAdminClient().from("message_templates").select("meta_id").eq("name", nombre).maybeSingle();
  const metaId = fila?.meta_id as string | null;
  if (!metaId) back("/plantillas", "error", "Falta el identificador de Meta: pulsa «Sincronizar» primero");

  try {
    await updateTemplate(metaId, def);
    revalidatePath("/plantillas");
    back("/plantillas", "ok", `«${nombre}» se envió a Meta con sus botones. Vuelve a revisión: mientras tanto se sigue usando la versión anterior.`);
  } catch (err) {
    if (isRedirectError(err)) throw err;
    back("/plantillas", "error", err instanceof Error ? err.message : "No se pudo actualizar la plantilla");
  }
}

/**
 * Crea una plantilla escrita por el negocio y la manda a Meta para que la revise.
 *
 * Las reglas se comprueban aquí otra vez, aunque el formulario ya avise: un rechazo de Meta llega en inglés,
 * críptico y horas después, así que conviene no llegar a él.
 */
export async function crearPlantilla(formData: FormData) {
  await requireAdmin();
  const parsed = z
    .object({
      name: z.string().trim().toLowerCase(),
      category: z.enum(CATEGORIAS),
      language: z.string().trim().min(2),
      body: z.string().trim(),
      examples: z.string().default(""),
      buttons: z.string().default(""),
    })
    .safeParse(Object.fromEntries(formData));
  if (!parsed.success) back("/plantillas", "error", "Faltan datos de la plantilla");

  // Los ejemplos llegan uno por línea, en el orden de las variables; los botones, igual.
  const examples = parsed.data.examples.split(/\r?\n/).map((e) => e.trim());
  const buttons = parsed.data.buttons.split(/\r?\n/).map((b) => b.trim()).filter(Boolean);
  const propuesta = { ...parsed.data, examples, buttons };

  const problemas = revisarPlantilla(propuesta);
  if (problemas.length) back("/plantillas", "error", problemas[0]);

  try {
    const r = await createTemplate({
      name: propuesta.name,
      category: propuesta.category,
      language: propuesta.language,
      body: propuesta.body,
      // Solo los ejemplos de las variables que el texto usa de verdad.
      examples: variablesDe(propuesta.body).map((n) => examples[n - 1]),
      ...(buttons.length && { buttons }),
    });
    revalidatePath("/plantillas");
    back("/plantillas", "ok", `Plantilla «${propuesta.name}» enviada a Meta (estado: ${r.status}). La revisión tarda de minutos a unas horas: luego pulsa «Sincronizar».`);
  } catch (err) {
    if (isRedirectError(err)) throw err;
    back("/plantillas", "error", err instanceof Error ? err.message : "No se pudo crear la plantilla");
  }
}

/**
 * Cambia uno de los textos que el agente envía durante una cita.
 *
 * Que los pasos los mande el código garantiza que salgan siempre igual; el tono con el que se le habla al
 * cliente, en cambio, es del negocio. Dejarlo en el código obligaba a pedir un cambio y esperar.
 */
export async function guardarMensajeAgente(formData: FormData) {
  const { profile } = await requireAdmin();
  const parsed = z
    .object({ clave: z.string().trim().min(1), texto: z.string().trim().min(1).max(1000) })
    .safeParse(Object.fromEntries(formData));
  if (!parsed.success) back("/agente", "error", "El mensaje no puede quedar vacío");

  const def = MENSAJES.find((m) => m.clave === parsed.data.clave);
  if (!def) back("/agente", "error", "Ese mensaje no existe");

  // Los huecos que el texto use tienen que ser de los que este mensaje recibe: {{sucursal}} en un mensaje que
  // no sabe la sucursal saldría vacío y nadie entendería por qué.
  const usados = [...parsed.data.texto.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]);
  const invalido = usados.find((h) => !def.huecos.includes(h));
  if (invalido) back("/agente", "error", `«{{${invalido}}}» no se puede usar aquí. Disponibles: ${def.huecos.map((h) => `{{${h}}}`).join(", ") || "ninguno"}`);

  const { error } = await createAdminClient()
    .from("agent_messages")
    .upsert({ clave: parsed.data.clave, texto: parsed.data.texto, updated_by: profile.id }, { onConflict: "clave" });
  if (error) back("/agente", "error", `No se pudo guardar: ${error.message}`);
  revalidatePath("/agente");
  back("/agente", "ok", "Mensaje actualizado: el agente lo usa desde la próxima conversación");
}

/** Devuelve un mensaje a como venía de fábrica. */
export async function restaurarMensajeAgente(formData: FormData) {
  await requireAdmin();
  const clave = String(formData.get("clave") ?? "");
  const { error } = await createAdminClient().from("agent_messages").delete().eq("clave", clave);
  if (error) back("/agente", "error", `No se pudo restaurar: ${error.message}`);
  revalidatePath("/agente");
  back("/agente", "ok", "Mensaje restaurado al original");
}

// ── Anuncios: gasto por anuncio (admin) ──────────────────────────────────

export async function setAdSpend(formData: FormData) {
  const { supabase } = await requireAdmin();
  const parsed = z
    .object({ ad_id: z.string().trim().min(1).max(100), amount: z.coerce.number().min(0).max(100_000_000), note: z.string().trim().max(200) })
    .safeParse({ ad_id: formData.get("ad_id") ?? "", amount: formData.get("amount") ?? "", note: formData.get("note") ?? "" });
  if (!parsed.success) back("/anuncios", "error", "El gasto debe ser un número (0 o más)");
  const { error } = await supabase.from("ad_spend").upsert({ ad_id: parsed.data.ad_id, amount: parsed.data.amount, note: parsed.data.note || null, updated_at: new Date().toISOString() });
  if (error) back("/anuncios", "error", error.message);
  revalidatePath("/anuncios");
  back("/anuncios", "ok", "Gasto guardado");
}
