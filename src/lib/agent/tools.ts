import "server-only";
import { z } from "zod";
import { BookingError, bookAppointment, findNextSlots, getAvailableSlots } from "@/lib/appointments";
import { cancelAppointment, listUpcomingAppointments } from "@/lib/appointment-ops";
import { attentionInfo } from "@/lib/attention";
import { grantPromotions, revokeAll } from "@/lib/consent";
import { sendBotOptions } from "@/lib/outbound";
import { createAdminClient } from "@/lib/supabase/admin";
import { addDays, formatLima, formatLimaTime, limaDateString, parseLimaLocal } from "@/lib/time";
import { humanPauseMs } from "@/lib/typing";

/**
 * Envía unos botones al cliente y da el turno por respondido. Se usa desde las propias herramientas cuando la
 * elección es siempre la misma (mañana/tarde, horarios): así los botones no dependen de que el modelo recuerde
 * llamar a send_options. Si WhatsApp los rechaza, devuelve false y el agente responde con texto normal.
 */
async function ofrecerBotones(ctx: ToolContext, texto: string, opciones: string[]): Promise<boolean> {
  try {
    const pausa = humanPauseMs(texto);
    if (pausa > 0) await new Promise((r) => setTimeout(r, pausa));
    await sendBotOptions(ctx.conversationId, texto, opciones, { kind: "options" });
    ctx.sentReply = true;
    return true;
  } catch (err) {
    console.error("[agente] no se pudieron enviar los botones; se responderá con texto", err);
    return false;
  }
}

/** Mañana o tarde, tal como se lo pregunta el agente al cliente. */
const FRANJA = z.enum(["mañana", "tarde"]);

export interface ToolContext {
  leadId: string;
  conversationId: string;
  /** Mutable: set_branch lo actualiza durante el turno. */
  branchId: string | null;
  handedOff: boolean;
  /** Mensaje del cliente que originó este turno: es la constancia (evidencia) de sus consentimientos. */
  messageId?: string;
  /** send_options ya envió la respuesta de este turno (botones/lista): no se manda además el texto final. */
  sentReply?: boolean;
}

export interface ToolResult {
  content: string;
  isError?: boolean;
}

/** Definición de una herramienta, independiente del proveedor de LLM (JSON Schema en `input_schema`). */
export interface ToolDef {
  name: string;
  description: string;
  input_schema: { type: "object"; properties: Record<string, unknown>; required?: string[] };
}

/**
 * Etiquetas que el agente puede poner solo. Lista CERRADA y de interés comercial: nunca datos de salud ni texto libre
 * (el modelo no puede inventar etiquetas ni anotar condiciones médicas del cliente).
 */
export const AUTO_TAGS = ["quiere lentes de contacto", "quiere monturas", "quiere lunas o micas", "consultó precios", "consultó promociones", "para un niño", "tiene receta"] as const;
const MAX_TAGS = 20;

export const AGENT_TOOLS: ToolDef[] = [
  {
    name: "set_branch",
    description:
      "Registra la sucursal del cliente cuando la elige o la confirma. Úsala antes de dar horarios o promociones si aún no hay sucursal. El nombre debe ser uno de la lista de sucursales.",
    input_schema: {
      type: "object",
      properties: { branch: { type: "string", description: "Nombre de la sucursal, tal como aparece en la lista" } },
      required: ["branch"],
    },
  },
  {
    name: "get_active_promotions",
    description:
      "Promociones vigentes hoy para la sucursal del cliente. Es la única fuente válida: nunca menciones una promoción que no salga de aquí.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "get_availability",
    description:
      "Horarios libres (hora de Lima) de la sucursal del cliente en un día concreto. Pregunta antes si prefiere mañana o tarde y pásalo en «franja»: así le ofreces pocas opciones y no un listado enorme.",
    input_schema: {
      type: "object",
      properties: {
        date: { type: "string", description: "Fecha YYYY-MM-DD" },
        franja: { type: "string", enum: ["mañana", "tarde"], description: "Opcional: acota a mañana (8:00-13:00) o tarde (14:00-20:00)" },
        hora: {
          type: "string",
          description:
            "Cuando el cliente pregunta por una hora concreta («¿a las 6 pm hay?»), pásala en formato 24 h (18:00): te respondo si ESA hora está libre y no le envío nada. Es la forma correcta de contestarle: no deduzcas la respuesta de una lista.",
        },
      },
      required: ["date"],
    },
  },
  {
    name: "next_available_slots",
    description:
      "Los próximos 3 horarios libres de la sucursal a partir de una fecha (por defecto hoy). Úsala cuando el cliente no fija día u hora, o cuando el día pedido no tiene cupo.",
    input_schema: {
      type: "object",
      properties: {
        from_date: { type: "string", description: "Fecha YYYY-MM-DD; opcional" },
        franja: { type: "string", enum: ["mañana", "tarde"], description: "Opcional: solo horarios de mañana o de tarde" },
      },
    },
  },
  {
    name: "book_appointment",
    description:
      "Agenda la cita de examen visual en el calendario de la sucursal. Solo con un horario que salió de get_availability o next_available_slots y con el nombre completo del cliente.",
    input_schema: {
      type: "object",
      properties: {
        full_name: { type: "string", description: "Nombre completo del cliente" },
        starts_at: { type: "string", description: "Inicio en hora de Lima, formato YYYY-MM-DDTHH:mm" },
        promotion_id: { type: "string", description: "id de una promoción vigente de get_active_promotions; opcional" },
        contact_phone: {
          type: "string",
          description: "Teléfono de contacto; solo si el contexto dice que no vemos el número del cliente",
        },
      },
      required: ["full_name", "starts_at"],
    },
  },
  {
    name: "handoff_to_human",
    description:
      "Deriva la conversación a un asesor de la sucursal y pausa el bot. Después de llamarla, escribe un último mensaje breve avisando al cliente.",
    input_schema: {
      type: "object",
      properties: { reason: { type: "string", description: "Motivo breve, para el asesor" } },
      required: ["reason"],
    },
  },
  {
    name: "opt_out",
    description: "Registra que el cliente no quiere recibir más mensajes (BAJA): revoca la atención y las promociones.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "my_appointments",
    description: "Lista las citas próximas del cliente (id, fecha y hora, sucursal). Úsala cuando quiera confirmar, cambiar o cancelar su cita, o si responde a un recordatorio.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "cancel_appointment",
    description:
      "Cancela una cita próxima del cliente (usa el appointment_id de my_appointments). Solo si el cliente lo pidió. Para REPROGRAMAR: primero agenda el horario nuevo con book_appointment y DESPUÉS cancela la anterior (así no pierde su lugar si el nuevo se ocupó).",
    input_schema: { type: "object", properties: { appointment_id: { type: "string", description: "Id de la cita, tal cual lo devolvió my_appointments" } }, required: ["appointment_id"] },
  },
  {
    name: "tag_lead",
    description: `Etiqueta al cliente según lo que le interesa, para que el equipo lo encuentre después. Máximo 3 por vez y solo si el cliente lo dijo claramente. Etiquetas permitidas: ${AUTO_TAGS.join(", ")}. Es silenciosa: no se lo menciones al cliente.`,
    input_schema: {
      type: "object",
      properties: { tags: { type: "array", items: { type: "string", enum: [...AUTO_TAGS] }, description: "Entre 1 y 3 etiquetas de la lista" } },
      required: ["tags"],
    },
  },
  {
    name: "send_options",
    description:
      "Envía UN mensaje de WhatsApp con botones (2–3 opciones) o lista (4–10) para que el cliente elija tocando en vez de escribir: la sucursal, o un horario de los que devolvió una herramienta. Es tu respuesta final de este turno: si funciona, no escribas más texto. Opciones MUY cortas (≤20 caracteres si son 2–3; ≤24 si son 4 o más).",
    input_schema: {
      type: "object",
      properties: {
        text: { type: "string", description: "La pregunta o el mensaje que acompaña a las opciones" },
        options: { type: "array", items: { type: "string" }, description: "Entre 2 y 10 opciones distintas y cortas" },
      },
      required: ["text", "options"],
    },
  },
  {
    name: "promotions_optin",
    description:
      "Registra que el cliente aceptó, de forma EXPLÍCITA y con sus propias palabras, recibir promociones. Úsala solo si él lo pide o lo acepta claramente; jamás la uses por tu cuenta, para preguntar ni si solo consulta por una promoción.",
    input_schema: { type: "object", properties: {} },
  },
];

/** Texto y id del mensaje del cliente que motiva un cambio de consentimiento (constancia). */
async function evidenceOf(db: ReturnType<typeof createAdminClient>, ctx: ToolContext): Promise<{ evidence: string | null; waMessageId: string | null }> {
  if (!ctx.messageId) return { evidence: null, waMessageId: null };
  const { data } = await db.from("messages").select("content, wa_message_id").eq("id", ctx.messageId).maybeSingle();
  return { evidence: (data?.content as string | undefined) ?? null, waMessageId: (data?.wa_message_id as string | undefined) ?? null };
}

/**
 * Falta saber la sucursal: se la pregunta el CÓDIGO con la lista tocable de tiendas, no el modelo (escribía los
 * cinco nombres en texto y el cliente tenía que teclear el suyo).
 */
async function pedirSucursal(ctx: ToolContext): Promise<ToolResult> {
  const { data } = await createAdminClient().from("branches").select("nombre").eq("activa", true).order("nombre");
  const nombres = (data ?? []).map((b) => b.nombre as string);
  if (nombres.length >= 2 && (await ofrecerBotones(ctx, "¿Cuál de nuestras tiendas te queda más cerca?", nombres))) {
    return json({ preguntado: true, siguiente_paso: "Ya le pregunté la sucursal con la lista de tiendas. NO escribas más en este turno; cuando elija una, usa set_branch." });
  }
  return { content: "Aún no hay sucursal. Pregúntale al cliente cuál le queda más cerca y usa set_branch.", isError: true };
}

const json = (value: unknown): ToolResult => ({ content: JSON.stringify(value) });
const fail = (message: string): ToolResult => ({ content: message, isError: true });

/** Instante UTC → "YYYY-MM-DDTHH:mm" en hora de Lima (formato de book_appointment). */
const toLimaLocal = (d: Date) => new Date(d.getTime() - 5 * 3_600_000).toISOString().slice(0, 16);

/** Sin tildes ni mayúsculas ni espacios de más: "  Huanuco " == "Huánuco". */
const norm = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").trim().toLowerCase();

/** Pasa la conversación a un asesor: pausa el bot y la marca "Requiere humano" para que aparezca en el inbox. */
async function handoff(ctx: ToolContext, reason: string): Promise<void> {
  const { error } = await createAdminClient()
    .from("conversations")
    .update({ bot_active: false, requires_human: true, handoff_reason: reason })
    .eq("id", ctx.conversationId);
  if (error) throw error;
  ctx.handedOff = true;
}

/**
 * Los fallos del calendario (sin calendario configurado, o Google caído) derivan a un asesor POR CÓDIGO:
 * no se deja a criterio del modelo, que puede prometer "un asesor te atenderá" sin avisarle a nadie.
 * Los demás (cupo ocupado, fuera de horario…) se le devuelven al modelo para que ofrezca otra opción.
 */
async function calendarError(err: unknown, ctx: ToolContext): Promise<ToolResult> {
  if (err instanceof BookingError) {
    // Tope diario: o es un malentendido o alguien está jugando con la agenda. Lo mira una persona.
    if (err.code === "daily_limit") {
      await handoff(ctx, "El cliente alcanzó el tope de citas por día. Revisa si necesita ayuda o si está ocupando la agenda sin motivo.");
      return fail("Se alcanzó el tope de citas por hoy. Ya derivé la conversación: escribe un mensaje breve avisando al cliente que un asesor lo ayudará con su cita.");
    }
    if (err.code === "too_many_active") {
      return fail(`${err.message} Usa my_appointments para ver sus citas, dile cuáles tiene y ofrécele mover o cancelar una.`);
    }
    if (err.code === "no_calendar") {
      await handoff(ctx, `${err.message}. Conéctalo en Sucursales; mientras tanto, agenda a mano.`);
      return fail("Esta sucursal aún no tiene calendario. Ya derivé la conversación a un asesor: escribe un mensaje breve avisando al cliente que un asesor lo atenderá para agendar su cita.");
    }
    return fail(err.message);
  }
  console.error("[agent tool] calendario", err);
  await handoff(ctx, "No se pudo consultar el calendario (Google Calendar). Agenda a mano y revisa la conexión.");
  return fail("No pude consultar el calendario. Ya derivé la conversación a un asesor: escribe un mensaje breve avisando al cliente que un asesor lo atenderá.");
}

export async function executeTool(name: string, input: unknown, ctx: ToolContext): Promise<ToolResult> {
  const db = createAdminClient();

  switch (name) {
    case "set_branch": {
      const parsed = z.object({ branch: z.string().trim().min(1) }).safeParse(input);
      if (!parsed.success) return fail("Indica el nombre de la sucursal");
      // Las sucursales las registra el admin en el panel: se buscan en la base, no en una lista fija del código.
      const { data: branches, error } = await db.from("branches").select("id, nombre, direccion").eq("activa", true);
      if (error) throw error;
      const wanted = norm(parsed.data.branch);
      const data = (branches ?? []).find((b) => norm(b.nombre) === wanted);
      if (!data) return fail(`No existe esa sucursal. Las disponibles son: ${(branches ?? []).map((b) => b.nombre).join(", ")}.`);
      const { error: upErr } = await db.from("leads").update({ branch_id: data.id }).eq("id", ctx.leadId);
      if (upErr) throw upErr;
      ctx.branchId = data.id;
      return json({ sucursal: data.nombre, direccion: data.direccion });
    }

    case "get_active_promotions": {
      if (!ctx.branchId) return await pedirSucursal(ctx);
      const now = new Date().toISOString();
      const { data, error } = await db
        .from("promotions")
        .select("id, titulo, descripcion, valid_to")
        .eq("active", true)
        .lte("valid_from", now)
        .gte("valid_to", now)
        .or(`branch_id.is.null,branch_id.eq.${ctx.branchId}`);
      if (error) throw error;
      return json({
        promociones: (data ?? []).map((p) => ({
          id: p.id,
          titulo: p.titulo,
          descripcion: p.descripcion,
          vigente_hasta: formatLima(new Date(p.valid_to)),
        })),
      });
    }

    case "get_availability": {
      if (!ctx.branchId) return await pedirSucursal(ctx);
      const parsed = z.object({ date: z.iso.date(), franja: FRANJA.optional(), hora: z.string().regex(/^\d{1,2}:\d{2}$/).optional() }).safeParse(input);
      // El motivo exacto: un «fecha inválida» cuando lo que estaba mal era la hora manda al modelo por el camino equivocado.
      if (!parsed.success) {
        const campo = parsed.error.issues[0]?.path[0];
        return fail(campo === "hora" ? "Hora inválida; usa HH:mm en 24 h (18:00)" : "Fecha inválida; usa YYYY-MM-DD");
      }
      try {
        const slots = await getAvailableSlots(ctx.branchId, parsed.data.date, 30, parsed.data.franja);
        const libres = slots.map((s) => formatLimaTime(new Date(s)));

        // Preguntó por una hora concreta: la respuesta la decide el CÓDIGO, no el modelo. Mirando una lista se
        // equivocaba («no hay a las 6 pm» con las 6 pm libres) y eso le cuesta citas al negocio.
        if (parsed.data.hora) {
          const [hh, mm] = parsed.data.hora.split(":");
          const pedida = parseLimaLocal(`${parsed.data.date}T${hh.padStart(2, "0")}:${mm}`);
          const disponible = !!pedida && slots.some((s) => new Date(s).getTime() === pedida.getTime());
          return json({
            hora: parsed.data.hora,
            disponible,
            ...(disponible
              ? { siguiente_paso: "SÍ está libre: díselo y agenda esa hora con book_appointment." }
              : { alternativas: libres.slice(0, 3), siguiente_paso: "NO está libre: dilo y ofrécele las alternativas." }),
          });
        }

        // Los dos pasos de la elección salen con BOTONES desde aquí, no a criterio del modelo: pedírselo en el
        // prompt no funcionó (escribía las opciones como texto y el cliente no veía nada que tocar).
        if (!parsed.data.franja && slots.length > 4) {
          const enviado = await ofrecerBotones(ctx, "¿Prefieres tu cita en la mañana o en la tarde?", ["En la mañana", "En la tarde"]);
          return json(
            enviado
              ? { preguntado: true, siguiente_paso: "Ya le pregunté con botones si prefiere mañana o tarde. NO escribas más en este turno; cuando responda, vuelve a llamarme con «franja»." }
              : { fecha: parsed.data.date, requiere_franja: true, nota: "Pregúntale si prefiere «En la mañana» o «En la tarde» y vuelve a llamarme con «franja»." },
          );
        }

        const ofrecidos = slots.slice(0, 3).map((s) => formatLimaTime(new Date(s)));
        if (ofrecidos.length >= 2) {
          const cuando = parsed.data.franja ? `en la ${parsed.data.franja}` : "ese día";
          const enviado = await ofrecerBotones(ctx, `Estos son los horarios libres ${cuando}. ¿Cuál te acomoda?`, ofrecidos);
          if (enviado) {
            return json({
              enviados: ofrecidos,
              // La lista completa va igual: si pide una hora que no estaba entre los botones, puedes responderle sin volver a consultar.
              horarios_libres: libres,
              siguiente_paso: "Ya le envié los horarios con botones. NO escribas más en este turno; cuando elija uno, agéndalo con book_appointment.",
            });
          }
        }

        return json({
          fecha: parsed.data.date,
          ...(parsed.data.franja && { franja: parsed.data.franja }),
          horarios_libres: ofrecidos,
          ...(slots.length === 0 && {
            nota: parsed.data.franja
              ? `Sin cupo esa ${parsed.data.franja} (cerrado, lleno o ya pasó). Prueba la otra franja o con next_available_slots.`
              : "Sin cupo ese día (cerrado, lleno o ya pasó). Ofrece otras opciones con next_available_slots.",
          }),
        });
      } catch (err) {
        return await calendarError(err, ctx);
      }
    }

    case "next_available_slots": {
      if (!ctx.branchId) return await pedirSucursal(ctx);
      const parsed = z.object({ from_date: z.iso.date().optional(), franja: FRANJA.optional() }).safeParse(input);
      if (!parsed.success) return fail("Fecha inválida; usa YYYY-MM-DD");
      const today = limaDateString(new Date());
      const from = parsed.data.from_date && parsed.data.from_date >= today ? parsed.data.from_date : today;
      try {
        const slots = await findNextSlots(ctx.branchId, from, 3, 7, 30, parsed.data.franja);
        return json({
          opciones: slots.map((s) => ({ starts_at: toLimaLocal(new Date(s)), cuando: formatLima(new Date(s)) })),
          ...(slots.length === 0 && { nota: `Sin cupo entre ${from} y ${addDays(from, 6)}. Deriva a un asesor.` }),
        });
      } catch (err) {
        return await calendarError(err, ctx);
      }
    }

    case "book_appointment": {
      if (!ctx.branchId) return await pedirSucursal(ctx);
      const parsed = z
        .object({
          full_name: z.string().trim().min(3),
          starts_at: z.string(),
          promotion_id: z.uuid().optional(),
          contact_phone: z.string().optional(),
        })
        .safeParse(input);
      if (!parsed.success) return fail("Faltan datos: nombre completo y horario (YYYY-MM-DDTHH:mm)");
      const startsAt = parseLimaLocal(parsed.data.starts_at);
      if (!startsAt) return fail("Horario inválido; usa YYYY-MM-DDTHH:mm en hora de Lima");
      if (startsAt <= new Date()) return fail("Ese horario ya pasó; ofrece otro");

      await db.from("leads").update({ nombre: parsed.data.full_name }).eq("id", ctx.leadId);
      // Cliente sin número visible: guardar el teléfono que dio (solo si el lead no tiene uno y es válido).
      const digits = parsed.data.contact_phone?.replace(/\D/g, "") ?? "";
      if (/^\d{7,15}$/.test(digits)) {
        await db.from("leads").update({ phone: `+${digits}` }).eq("id", ctx.leadId).is("phone", null);
        // Si ese teléfono ya es de otro lead el update falla por unicidad: se ignora, la cita igual se agenda.
      }
      try {
        const result = await bookAppointment({
          leadId: ctx.leadId,
          branchId: ctx.branchId,
          startsAt,
          promotionId: parsed.data.promotion_id,
        });
        return json({
          agendada: true,
          cuando: formatLima(startsAt),
          sucursal: result.branch.nombre,
          direccion: result.branch.direccion,
        });
      } catch (err) {
        return await calendarError(err, ctx);
      }
    }

    case "handoff_to_human": {
      const parsed = z.object({ reason: z.string().trim().min(1) }).safeParse(input);
      await handoff(ctx, parsed.success ? parsed.data.reason : "Sin motivo indicado");
      const att = attentionInfo();
      return json({
        derivada: true,
        atencion: att.open ? "Hay asesores atendiendo ahora." : `Ahora NO hay asesores: ${att.message}.`,
        siguiente_paso: att.open
          ? "Escribe ahora un mensaje breve avisando que un asesor lo atenderá en breve."
          : `Escribe ahora un mensaje breve avisando que su caso quedó registrado y que ${att.message}. No digas «en breve» ni prometas una hora exacta.`,
      });
    }

    case "opt_out": {
      await revokeAll(db, { leadId: ctx.leadId, channel: "whatsapp", ...(await evidenceOf(db, ctx)) });
      return json({ registrado: true, siguiente_paso: "Confírmalo con amabilidad y dile que si quiere volver a recibir mensajes solo escriba ALTA." });
    }

    case "my_appointments": {
      const list = await listUpcomingAppointments(ctx.leadId);
      if (list.length === 0) return json({ citas: [], nota: "El cliente no tiene citas próximas." });
      return json({
        citas: list.map((a) => ({ appointment_id: a.id, cuando: formatLima(new Date(a.scheduled_at)), sucursal: a.branch?.nombre, direccion: a.branch?.direccion, estado: a.status })),
      });
    }

    case "cancel_appointment": {
      const parsed = z.object({ appointment_id: z.string().min(1) }).safeParse(input);
      if (!parsed.success) return fail("Falta el appointment_id (usa my_appointments).");
      // Solo puede cancelar SUS citas próximas: el id lo mandó el modelo y no es de fiar.
      const mine = (await listUpcomingAppointments(ctx.leadId)).find((a) => a.id === parsed.data.appointment_id);
      if (!mine) return fail("Esa cita no existe entre las citas próximas de este cliente. Usa my_appointments.");
      await cancelAppointment(mine.id);
      return json({ cancelada: true, cuando: formatLima(new Date(mine.scheduled_at)), siguiente_paso: "Confírmaselo y ofrécele reprogramar si no lo ha hecho." });
    }

    case "tag_lead": {
      const parsed = z.object({ tags: z.array(z.string()).min(1).max(3) }).safeParse(input);
      if (!parsed.success) return fail("Indica entre 1 y 3 etiquetas de la lista.");
      const allowed = parsed.data.tags.filter((t) => (AUTO_TAGS as readonly string[]).includes(t));
      if (allowed.length === 0) return fail(`Etiquetas no permitidas. Usa solo: ${AUTO_TAGS.join(", ")}.`);
      const { data: lead } = await db.from("leads").select("tags").eq("id", ctx.leadId).maybeSingle();
      const current = (lead?.tags as string[] | null) ?? [];
      const next = [...new Set([...current, ...allowed])].slice(0, MAX_TAGS);
      if (next.length !== current.length) {
        const { error } = await db.from("leads").update({ tags: next }).eq("id", ctx.leadId);
        if (error) throw error;
      }
      return json({ etiquetado: true, etiquetas: allowed, siguiente_paso: "Continúa con la conversación; no le menciones las etiquetas al cliente." });
    }

    case "send_options": {
      const parsed = z.object({ text: z.string().trim().min(1).max(1024), options: z.array(z.string()).min(2).max(10) }).safeParse(input);
      if (!parsed.success) return fail("Necesito un texto y entre 2 y 10 opciones.");
      // Al cliente le llegaban las mismas opciones dos veces: la herramienta de disponibilidad ya se las mandó.
      if (ctx.sentReply) return json({ enviado: false, siguiente_paso: "El cliente ya recibió las opciones en este turno. NO envíes nada más." });
      // Solo si nadie tomó el chat mientras se pensaba la respuesta.
      const { data: conv } = await db.from("conversations").select("bot_active").eq("id", ctx.conversationId).maybeSingle();
      if (!conv?.bot_active && !ctx.handedOff) return fail("Un asesor tomó el chat: no envíes nada.");
      try {
        // Mismo ritmo que una respuesta escrita: el cliente ve «escribiendo…» mientras tanto.
        const pause = humanPauseMs(parsed.data.text);
        if (pause > 0) await new Promise((r) => setTimeout(r, pause));
        await sendBotOptions(ctx.conversationId, parsed.data.text, parsed.data.options, { kind: "options" });
      } catch (err) {
        return fail(`No se pudo enviar las opciones (${err instanceof Error ? err.message : "error"}). Escríbelas como texto normal.`);
      }
      ctx.sentReply = true;
      return json({ enviado: true, siguiente_paso: "Listo: el cliente ya ve las opciones. NO escribas más texto en este turno." });
    }

    case "promotions_optin": {
      await grantPromotions(db, { leadId: ctx.leadId, channel: "whatsapp", ...(await evidenceOf(db, ctx)) });
      return json({ registrado: true, siguiente_paso: "Confírmaselo brevemente y recuérdale que puede escribir BAJA cuando quiera." });
    }

    default:
      return fail(`Herramienta desconocida: ${name}`);
  }
}
