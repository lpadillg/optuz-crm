import "server-only";
import { env } from "@/lib/env";
import { sendBotTemplate, sendBotText } from "@/lib/outbound";
import { createAdminClient } from "@/lib/supabase/admin";
import { formatLimaTime } from "@/lib/time";
import { getApprovedTemplate, renderTemplate } from "@/lib/whatsapp/templates";

const dateText = (d: Date) =>
  new Intl.DateTimeFormat("es-PE", { timeZone: "America/Lima", weekday: "long", day: "numeric", month: "long" }).format(d);

export type AvisoOutcome = "sent" | "skipped" | "needs_human";

/** La conversación del cliente; se crea si la cita se registró a mano y todavía no tiene hilo. */
async function conversacionDe(leadId: string): Promise<string> {
  const db = createAdminClient();
  const { data } = await db.from("conversations").select("id").eq("lead_id", leadId).maybeSingle();
  if (data) return data.id as string;
  const { data: creada, error } = await db.from("conversations").insert({ lead_id: leadId }).select("id").single();
  if (error) throw error;
  return creada.id as string;
}

/** ¿Podemos escribirle texto normal, o han pasado más de 24 h desde su último mensaje? */
async function ventanaAbierta(conversationId: string): Promise<boolean> {
  const { data } = await createAdminClient()
    .from("messages")
    .select("created_at")
    .eq("conversation_id", conversationId)
    .eq("direction", "in")
    .order("created_at", { ascending: false })
    .limit(1);
  return data?.[0] != null && Date.now() - new Date(data[0].created_at as string).getTime() < 23 * 3600_000;
}

async function flagHuman(conversationId: string, reason: string) {
  await createAdminClient()
    .from("conversations")
    .update({ requires_human: true, handoff_reason: reason })
    .eq("id", conversationId)
    .eq("requires_human", false);
}

/**
 * Envía un aviso al cliente por un cambio en su cita. Dentro de la ventana de 24 h va como texto; fuera solo
 * puede ir como plantilla aprobada, y si no la hay, la conversación queda marcada para que una persona avise.
 *
 * Nunca lanza: el cambio de la cita ya ocurrió y no debe deshacerse porque falle un mensaje. Quien llama
 * decide qué contarle al usuario del panel según lo que devuelva.
 */
async function avisar(
  leadId: string,
  texto: string,
  plantilla: { nombre: string; params: string[] },
  meta: Record<string, unknown>,
  motivoSiNoSePudo: string,
): Promise<AvisoOutcome> {
  try {
    const db = createAdminClient();
    const { data: lead } = await db.from("leads").select("opt_out").eq("id", leadId).maybeSingle();
    if (lead?.opt_out) return "skipped"; // pidió no recibir mensajes

    const conversationId = await conversacionDe(leadId);
    if (await ventanaAbierta(conversationId)) {
      await sendBotText(conversationId, texto, meta);
      return "sent";
    }
    const tpl = await getApprovedTemplate(plantilla.nombre);
    if (!tpl) {
      await flagHuman(conversationId, motivoSiNoSePudo);
      return "needs_human";
    }
    await sendBotTemplate(conversationId, tpl.name, tpl.language, plantilla.params, renderTemplate(tpl.body, plantilla.params), {
      ...meta,
      template: tpl.name,
    });
    return "sent";
  } catch (err) {
    console.error("[citas] no se pudo avisar al cliente", err);
    return "needs_human";
  }
}

/** Avisa al cliente de que su cita se movió. */
export async function notifyReschedule(input: {
  appointmentId: string;
  leadId: string;
  antes: Date;
  ahora: Date;
  branch: { nombre: string; direccion: string };
  cambioDeSede: boolean;
}): Promise<AvisoOutcome> {
  const db = createAdminClient();
  const { data: lead } = await db.from("leads").select("nombre").eq("id", input.leadId).maybeSingle();
  const nombre = (lead?.nombre as string | null)?.split(" ")[0] ?? "";
  const saludo = nombre ? ` ${nombre}` : "";
  const sede = input.cambioDeSede
    ? ` en nuestra sucursal ${input.branch.nombre} (${input.branch.direccion})`
    : ` en ${env.businessName} ${input.branch.nombre}`;

  const texto =
    `Hola${saludo} 👋 Movimos tu evaluación visual: la teníamos para el ${dateText(input.antes)} a las ${formatLimaTime(input.antes)} ` +
    `y ahora queda el *${dateText(input.ahora)} a las ${formatLimaTime(input.ahora)}*${sede}.\n\n` +
    `Si ese horario no te queda bien, dímelo y buscamos otro. 😊`;

  return avisar(
    input.leadId,
    texto,
    { nombre: "cita_reprogramada", params: [nombre, dateText(input.ahora), formatLimaTime(input.ahora), input.branch.nombre] },
    { kind: "reschedule", appointment_id: input.appointmentId },
    `Se movió su cita al ${dateText(input.ahora)} a las ${formatLimaTime(input.ahora)} y no se le pudo avisar: pasaron más de 24 h desde su último mensaje y no hay plantilla «cita_reprogramada» aprobada. Avísale tú.`,
  );
}

/** Escribe a quien no vino a su cita para intentar recuperarla. */
export async function notifyNoShow(input: { appointmentId: string; leadId: string; cuando: Date }): Promise<AvisoOutcome> {
  const db = createAdminClient();
  const { data: lead } = await db.from("leads").select("nombre").eq("id", input.leadId).maybeSingle();
  const nombre = (lead?.nombre as string | null)?.split(" ")[0] ?? "";
  const saludo = nombre ? ` ${nombre}` : "";

  const texto =
    `Hola${saludo} 👋 Te esperábamos el ${dateText(input.cuando)} a las ${formatLimaTime(input.cuando)} para tu evaluación visual gratuita ` +
    `y no pudiste venir. ¿Quieres que te busquemos un nuevo horario? Dime qué día te acomoda. 😊`;

  return avisar(
    input.leadId,
    texto,
    { nombre: "cita_no_asistio", params: [nombre, dateText(input.cuando)] },
    { kind: "no_show", appointment_id: input.appointmentId },
    `No vino a su cita del ${dateText(input.cuando)} y no se le pudo escribir: pasaron más de 24 h desde su último mensaje y no hay plantilla «cita_no_asistio» aprobada. Contáctalo tú.`,
  );
}
