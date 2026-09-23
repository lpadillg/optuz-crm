// Lectura perezosa: un secret ausente falla al usarse, no al importar el módulo (así `next build` no exige todo el entorno).
function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Falta la variable de entorno ${name}`);
  return value;
}

export const env = {
  get supabaseUrl() { return required("NEXT_PUBLIC_SUPABASE_URL"); },
  get supabaseAnonKey() { return required("NEXT_PUBLIC_SUPABASE_ANON_KEY"); },
  get supabaseServiceRoleKey() { return required("SUPABASE_SERVICE_ROLE_KEY"); },

  // WhatsApp Cloud API (Meta). Guía: README → "Conectar WhatsApp (API de Meta)".
  get metaAppSecret() { return required("META_APP_SECRET"); },
  get whatsappVerifyToken() { return required("WHATSAPP_VERIFY_TOKEN"); },
  get whatsappPhoneNumberId() { return required("WHATSAPP_PHONE_NUMBER_ID"); },
  get whatsappAccessToken() { return required("WHATSAPP_ACCESS_TOKEN"); },
  // Opcionales: `||` (no `??`) para que una variable en blanco (`NOMBRE=`) también use el valor por defecto.
  get graphBaseUrl() { return (process.env.META_GRAPH_BASE_URL || "https://graph.facebook.com").replace(/\/$/, ""); },
  get graphVersion() { return process.env.META_GRAPH_VERSION || "v25.0"; },

  get googleServiceAccountEmail() { return required("GOOGLE_SERVICE_ACCOUNT_EMAIL"); },
  // En Vercel la clave PEM se pega con "\n" literales.
  get googleServiceAccountPrivateKey() { return required("GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY").replace(/\\n/g, "\n"); },
  /** ¿Están cargadas las credenciales de Google? (sin ellas el agente deriva las citas a un asesor). */
  get googleConfigured() { return Boolean(process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL && process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY); },
  get googleCalendarTimezone() { return process.env.GOOGLE_CALENDAR_TIMEZONE || "America/Lima"; },

  // LLM del agente: OpenAI (API Responses). Modelos: gpt-5.6-luna (barato), gpt-5.6-terra (equilibrado), gpt-5.6-sol (mejor).
  get openaiApiKey() { return required("OPENAI_API_KEY"); },
  // Los ids de modelo van en minúscula: "GPT-4o-mini" (como suele escribirse) se normaliza a "gpt-4o-mini".
  get openaiModel() { return (process.env.OPENAI_MODEL || "gpt-5.6-terra").trim().toLowerCase(); },
  /** Cuánto "piensa" el modelo antes de responder: más = mejor criterio pero más lento y caro. */
  get openaiReasoningEffort() {
    const v = process.env.OPENAI_REASONING_EFFORT;
    return (["none", "minimal", "low", "medium", "high"] as const).find((e) => e === v) ?? "medium";
  },
  /** Solo para pruebas o proxies; el SDK usa https://api.openai.com/v1 si no se define. */
  /** Modelo que transcribe las notas de voz. */
  get openaiTranscribeModel() { return process.env.OPENAI_TRANSCRIBE_MODEL || "gpt-4o-mini-transcribe"; },
  get openaiBaseUrl() { return process.env.OPENAI_BASE_URL || undefined; },

  // Marca: el prompt del agente los usa (spec → decisión pendiente n.º 2).
  get businessName() { return process.env.BUSINESS_NAME || "Optuz"; },
  get brandTone() {
    return process.env.BRAND_TONE || "cercano y amable, con pocos emojis y mensajes cortos";
  },
  get internalApiSecret() { return required("INTERNAL_API_SECRET"); },

  // Operación (opcionales; los valores por defecto sirven).
  /** Espera antes de que el agente responda, para juntar los mensajes seguidos de un cliente en una sola respuesta. */
  get agentDebounceMs() { const n = Number(process.env.AGENT_DEBOUNCE_MS); return Number.isFinite(n) && process.env.AGENT_DEBOUNCE_MS ? Math.max(0, n) : 4000; },
  /** Minutos sin respuesta del cliente tras los que el bot le escribe UN seguimiento (0 = desactivado). Solo dentro de las 24 h. */
  get followupAfterMinutes() { const n = Number(process.env.FOLLOWUP_AFTER_MINUTES); return Number.isFinite(n) && process.env.FOLLOWUP_AFTER_MINUTES ? Math.max(0, n) : 180; },
  /** Protege /api/jobs/run (para un cron externo). Sin él, el endpoint responde 503. */
  get cronSecret() { return process.env.CRON_SECRET || ""; },
  /** Correo de avisos (Resend). Opcional: sin esto los escalamientos solo se ven en el panel. */
  get resendApiKey() { return process.env.RESEND_API_KEY || ""; },
  get alertEmailFrom() { return process.env.ALERT_EMAIL_FROM || ""; },
  /** Conjunto de datos de Meta para la API de Conversiones (opcional). */
  get metaDatasetId() { return process.env.META_DATASET_ID || ""; },
  /** Plantilla aprobada que se usa para recordar citas fuera de la ventana de 24 h. */
  get reminderTemplate() { return process.env.REMINDER_TEMPLATE || "cita_recordatorio"; },
  /** Nombre del evento que se envía a Meta cuando una cita queda agendada. */
  get capiEventSchedule() { return process.env.CAPI_EVENT_SCHEDULE || "Schedule"; },
  get whatsappBusinessAccountId() { return process.env.WHATSAPP_BUSINESS_ACCOUNT_ID || ""; },
  /** Horas sin que el cliente conteste antes de moverlo a «Sin respuesta» (24 h = la ventana de WhatsApp). */
  get noReplyHours() { const n = Number(process.env.NO_REPLY_HOURS); return Number.isFinite(n) && process.env.NO_REPLY_HOURS ? Math.max(1, n) : 24; },
  /** Días en «Sin respuesta» tras los que el contacto se archiva solo (0 lo desactiva). */
  get archiveAfterDays() { const n = Number(process.env.ARCHIVE_AFTER_DAYS); return Number.isFinite(n) && process.env.ARCHIVE_AFTER_DAYS ? Math.max(0, n) : 30; },

  // ── Ritmo humano al responder (el «escribiendo…» se apaga cuando sale el mensaje) ──
  /** Caracteres por segundo al «teclear». 0 desactiva la pausa: se responde en cuanto está lista. */
  get typingCharsPerSecond() { const n = Number(process.env.TYPING_CHARS_PER_SECOND); return Number.isFinite(n) && process.env.TYPING_CHARS_PER_SECOND ? Math.max(0, n) : 22; },
  /** Lo que tarda una persona en leer el mensaje y empezar a escribir. */
  get typingLeadMs() { const n = Number(process.env.TYPING_LEAD_MS); return Number.isFinite(n) && process.env.TYPING_LEAD_MS ? Math.max(0, n) : 700; },
  /** Nunca responder más rápido que esto: una respuesta instantánea delata al bot. */
  get typingMinMs() { const n = Number(process.env.TYPING_MIN_MS); return Number.isFinite(n) && process.env.TYPING_MIN_MS ? Math.max(0, n) : 1200; },
  /** Ni hacer esperar más que esto, por larga que sea la respuesta. */
  get typingMaxMs() { const n = Number(process.env.TYPING_MAX_MS); return Number.isFinite(n) && process.env.TYPING_MAX_MS ? Math.max(0, n) : 7000; },

  /** Cuántas citas próximas (agendadas o confirmadas) puede tener a la vez un mismo cliente. */
  get maxActiveAppointments() { const n = Number(process.env.MAX_ACTIVE_APPOINTMENTS); return Number.isFinite(n) && process.env.MAX_ACTIVE_APPOINTMENTS ? Math.max(1, n) : 3; },
  /** Cuántas citas puede crear un mismo cliente en un día (freno a agendar y cancelar en bucle). 0 = sin tope. */
  get maxAppointmentsPerDay() { const n = Number(process.env.MAX_APPOINTMENTS_PER_DAY); return Number.isFinite(n) && process.env.MAX_APPOINTMENTS_PER_DAY ? Math.max(0, n) : 3; },
  /** Cuántas citas caben a la misma hora en una sucursal: tantas como personas atiendan a la vez. */
  get slotCapacity() { const n = Number(process.env.APPOINTMENT_SLOT_CAPACITY); return Number.isFinite(n) && process.env.APPOINTMENT_SLOT_CAPACITY ? Math.max(1, n) : 3; },
};
