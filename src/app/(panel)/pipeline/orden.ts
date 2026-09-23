import { firstOf, LEAD_STAGES, type LeadOrigin, type LeadStage } from "@/lib/types";

/** «Requiere humano» no es una etapa del embudo: puede pasar en cualquiera y manda sobre todas. */
export const HUMANO = "humano" as const;
export type Columna = LeadStage | typeof HUMANO;
export const COLUMNAS: Columna[] = [HUMANO, ...LEAD_STAGES];

/**
 * A qué columnas se puede mover una tarjeta a mano, y por qué no a las demás.
 *
 * Las etapas se deducen de hechos, así que ponerlas a mano solo tiene sentido donde el hecho es un juicio de
 * quien atiende. En las otras tres, mover la tarjeta miente o hace daño:
 *  - «Cita agendada» sale de tener una cita. Arrastrar ahí a alguien sin cita hace que el tablero diga una
 *    cosa y la agenda otra.
 *  - «Sin respuesta» envejece: a los ARCHIVE_AFTER_DAYS días el lead sale solo del tablero. Mover ahí a
 *    alguien vivo para quitárselo de encima acaba archivando a un cliente que estaba contestando.
 *  - «No asistió» sale de anotar en Citas que el cliente no vino.
 */
export const MOTIVO_NO_MOVIBLE: Partial<Record<Columna, string>> = {
  cita_agendada: "«Cita agendada» significa que el cliente tiene una cita. Agéndasela desde el chat o desde Citas y la tarjeta llega sola.",
  sin_respuesta: "«Sin respuesta» se pone solo cuando el cliente lleva sin contestar, y desde ahí se archiva a los 30 días. Si quieres quitarlo del tablero, archívalo con el botón de la tarjeta.",
  no_asistio: "«No asistió» se marca en Citas, al anotar si el cliente vino. Desde aquí no se puede poner.",
};

/** Cuántas tarjetas trae cada columna de entrada. El resto se pide con «ver más». */
export const POR_COLUMNA = 100;

/** Campos que necesita una tarjeta del tablero. */
export const CAMPOS_LEAD =
  "id, nombre, phone, stage, tags, branch_id, returned_at, origin, created_at, saw_slots_at, next_appointment_at, branches(nombre), conversations(id, last_message_at, last_message_sender, requires_human, assigned_to, assignee:users!assigned_to(nombre))";

export interface CriterioOrden {
  col: string;
  ascending: boolean;
  /** Los nulos al final: un lead sin ese dato nunca debe encabezar la columna. */
  nullsFirst?: boolean;
}

/**
 * Cómo se ordena cada columna. No es una preferencia estética: en una columna del embudo, arriba va lo que
 * hay que atender primero, y eso es distinto en cada una.
 */
export const ORDEN: Record<Columna, CriterioOrden[]> = {
  // Escribió y nadie le ha contestado: manda el tiempo que lleva esperando.
  humano: [{ col: "last_message_at", ascending: true }],
  nuevo: [{ col: "created_at", ascending: true }],
  // Conversación viva. Arriba la que lleva más tiempo quieta: es la que se está enfriando y aún se salva.
  seguimiento: [{ col: "updated_at", ascending: true }],
  // Ya no contesta. Primero quien llegó a ver horarios concretos, que estuvo a un paso de agendar; entre los
  // demás, los más recientes, que son los más fáciles de recuperar.
  sin_respuesta: [
    { col: "saw_slots_at", ascending: false, nullsFirst: false },
    { col: "updated_at", ascending: false },
  ],
  // Lo que importa es quién viene antes.
  cita_agendada: [{ col: "next_appointment_at", ascending: true, nullsFirst: false }],
  // La ausencia más reciente arriba: cuanto antes se le escriba, más fácil es recuperarlo.
  no_asistio: [{ col: "updated_at", ascending: false }],
};

/** Qué mide el tiempo que se muestra en la tarjeta, cuando la columna lo muestra. */
export const ESPERA_DESDE: Partial<Record<Columna, "creado" | "ultimo_mensaje">> = {
  nuevo: "creado",
  humano: "ultimo_mensaje",
};

/** Una tarjeta del tablero. */
export interface BoardLead {
  id: string;
  nombre: string | null;
  phone: string | null;
  stage: LeadStage;
  tags: string[];
  branchId: string | null;
  branch: string | null;
  conversationId: string | null;
  lastMessageAt: string | null;
  /** El último mensaje lo escribimos nosotros: está en visto. */
  waitingOnClient: boolean;
  /** Llegó a ver horarios concretos: estuvo a un paso de agendar. */
  sawSlots: boolean;
  /** Cuándo escribió por primera vez: mide lo que lleva esperando en «Nuevo». */
  createdAt: string;
  /** Su próxima cita, si tiene: ordena «Cita agendada» y se muestra en la tarjeta. */
  nextAppointmentAt: string | null;
  /** Volvió a escribir tras un silencio largo. */
  returnedAt: string | null;
  /** De dónde salió este cliente. */
  origin: LeadOrigin;
  requiresHuman: boolean;
  assignedTo: string | null;
  assigneeName: string | null;
}

type ConvEmbed = {
  id: string;
  last_message_at: string;
  last_message_sender: "bot" | "humano" | "lead" | null;
  requires_human: boolean;
  assigned_to: string | null;
  assignee: { nombre: string } | { nombre: string }[] | null;
};

export type LeadRow = {
  id: string;
  nombre: string | null;
  phone: string | null;
  stage: LeadStage;
  tags: string[];
  branch_id: string | null;
  returned_at: string | null;
  origin: LeadOrigin;
  created_at: string;
  saw_slots_at: string | null;
  next_appointment_at: string | null;
  branches: { nombre: string } | null;
  conversations: ConvEmbed | ConvEmbed[] | null;
};

/** Fila de la base → tarjeta. La usan el servidor al pintar y el cliente al pedir «ver más». */
export function toBoardLead(l: LeadRow): BoardLead {
  const conv = firstOf(l.conversations);
  return {
    id: l.id,
    nombre: l.nombre,
    phone: l.phone,
    stage: l.stage,
    tags: l.tags,
    branchId: l.branch_id,
    branch: l.branches?.nombre ?? null,
    conversationId: conv?.id ?? null,
    lastMessageAt: conv?.last_message_at ?? null,
    waitingOnClient: conv?.last_message_sender !== "lead",
    sawSlots: l.saw_slots_at != null,
    createdAt: l.created_at,
    nextAppointmentAt: l.next_appointment_at,
    returnedAt: l.returned_at,
    origin: l.origin,
    requiresHuman: conv?.requires_human ?? false,
    assignedTo: conv?.assigned_to ?? null,
    assigneeName: firstOf(conv?.assignee)?.nombre ?? null,
  };
}
