/**
 * Las etapas del tablero. Miden una sola cosa —llegar a la cita— y se deducen de hechos, no del criterio de
 * nadie: escribió · conversación viva · lleva 24 h sin contestar · tiene cita por delante · no vino a ella.
 */
export const LEAD_STAGES = ["nuevo", "seguimiento", "sin_respuesta", "cita_agendada", "no_asistio"] as const;
export type LeadStage = (typeof LEAD_STAGES)[number];

export const LEAD_STAGE_LABEL: Record<LeadStage, string> = {
  nuevo: "Nuevo",
  seguimiento: "En seguimiento",
  sin_respuesta: "Sin respuesta",
  cita_agendada: "Cita agendada",
  no_asistio: "No asistió",
};

export const LEAD_STAGE_HINT: Record<LeadStage, string> = {
  nuevo: "Escribió por primera vez y aún nadie le ha respondido. Con el agente apagado, aquí se acumula la gente por atender.",
  seguimiento: "Conversación viva: aún se puede cerrar la cita.",
  sin_respuesta: "Lleva 24 h sin contestar. Arriba, quien estuvo más cerca de agendar.",
  cita_agendada: "Objetivo cumplido: tiene su cita por delante.",
  no_asistio: "Tenía cita y no vino. Es la gente más fácil de recuperar: ya quiso venir y ya eligió sucursal. Escríbele desde aquí; si no contesta, pasa solo a «Sin respuesta».",
};

/**
 * De dónde salió el cliente. Un anuncio se detecta solo (Meta lo manda en el mensaje); el resto lo pone el
 * equipo desde la ficha, porque nadie más lo sabe.
 */
export const LEAD_ORIGINS = ["anuncio", "redes_organico", "cliente_antiguo", "recomendado", "otro"] as const;
export type LeadOrigin = (typeof LEAD_ORIGINS)[number];

export const LEAD_ORIGIN_LABEL: Record<LeadOrigin, string> = {
  anuncio: "Anuncio",
  redes_organico: "Redes (sin pagar)",
  cliente_antiguo: "Cliente antiguo",
  recomendado: "Recomendado",
  otro: "Otro",
};

/** Temas del conocimiento del agente: solo ordenan la pantalla, no cambian cómo responde. */
export const KNOWLEDGE_CATEGORIES = ["atencion", "productos", "compra", "tienda", "otros"] as const;
export type KnowledgeCategory = (typeof KNOWLEDGE_CATEGORIES)[number];

export const KNOWLEDGE_CATEGORY_LABEL: Record<KnowledgeCategory, string> = {
  atencion: "Atención y citas",
  productos: "Productos",
  compra: "Compra y entrega",
  tienda: "Tienda y contacto",
  otros: "Otros",
};

export const KNOWLEDGE_CATEGORY_HINT: Record<KnowledgeCategory, string> = {
  atencion: "La evaluación, qué traer, niños, recetas e historial.",
  productos: "Lunas, tratamientos, monturas y lentes de contacto. Nunca precios.",
  compra: "Pagos, plazos de entrega, garantía y seguros.",
  tienda: "Estacionamiento, envíos, campañas y redes sociales.",
  otros: "Lo que no entra en los temas anteriores.",
};

/** Por qué un contacto salió del tablero. Decide si vuelve solo cuando escribe de nuevo. */
export const ARCHIVE_REASONS = ["no_interesa", "no_es_cliente", "inactivo", "atendido"] as const;
export type ArchiveReason = (typeof ARCHIVE_REASONS)[number];

export const ARCHIVE_REASON_LABEL: Record<ArchiveReason, string> = {
  no_interesa: "No le interesa",
  no_es_cliente: "No es un cliente (proveedor, spam, equivocado)",
  inactivo: "Sin respuesta durante mucho tiempo",
  atendido: "Vino a su cita",
};

/** Motivos que el equipo puede elegir al archivar a mano. */
export const MANUAL_ARCHIVE_REASONS = ["no_interesa", "no_es_cliente"] as const;

export const APPOINTMENT_STATUSES = ["agendada", "confirmada", "atendida", "no_show", "cancelada"] as const;
export type AppointmentStatus = (typeof APPOINTMENT_STATUSES)[number];

export const APPOINTMENT_STATUS_LABEL: Record<AppointmentStatus, string> = {
  agendada: "Agendada",
  confirmada: "Confirmada",
  atendida: "Atendida",
  no_show: "No asistió",
  cancelada: "Cancelada",
};

export interface MessageRow {
  id: string;
  direction: "in" | "out";
  sender: "bot" | "humano" | "lead";
  content: string;
  attachments: unknown[];
  created_at: string;
  author_id: string | null;
  /** Solo mensajes salientes: null = enviado sin confirmación todavía. */
  delivery_status?: "sent" | "delivered" | "read" | "failed" | null;
  feedback?: 1 | -1 | null;
}

export interface NoteRow {
  id: string;
  body: string;
  created_at: string;
  author_name: string;
}

/** Los embeds 1:1 de PostgREST (p. ej. lead → conversación, con lead_id único) llegan como objeto; los 1:N, como lista. */
export const firstOf = <T,>(v: T | T[] | null | undefined): T | undefined => (Array.isArray(v) ? v[0] : (v ?? undefined));

/** Mensajes que se cargan de una vez en un chat (los más recientes); el resto, con «Ver mensajes anteriores». */
export const MESSAGE_PAGE = 100;

/** Un adjunto de un mensaje tal como se guarda en `messages.attachments`. */
export interface Attachment {
  type: "image" | "video" | "audio" | "document" | "sticker";
  id?: string;
  mime_type?: string;
  filename?: string;
  /** Ruta en el almacenamiento privado (se sirve con un enlace firmado de 60 s vía /api/media). */
  storage_path?: string;
  size?: number;
  /** Solo notas de voz: lo que dijo el cliente. */
  transcript?: string;
}
