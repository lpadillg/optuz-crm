import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Interruptor general del agente. Apagado, el bot deja de responder y no salen seguimientos ni recordatorios:
 * los mensajes del cliente siguen llegando al inbox y el equipo contesta a mano.
 *
 * Se lee de la base en cada mensaje, sin caché: la acción que lo cambia y el webhook que recibe los mensajes
 * corren en instancias distintas del servidor (también en Vercel), y una caché dejaba unos segundos en los que
 * el webhook creía que seguía apagado y ese mensaje se quedaba sin respuesta. Es una sola fila: no cuesta nada.
 * Y ante la duda el bot RESPONDE: un fallo de la base no debe dejar a los clientes sin contestación.
 */

export interface AgentSwitch {
  enabled: boolean;
  pausedAt: string | null;
  pausedBy: string | null;
  reason: string | null;
}

const ON: AgentSwitch = { enabled: true, pausedAt: null, pausedBy: null, reason: null };

/** Estado del interruptor, con los datos de quién lo apagó (para el aviso del panel). */
export async function getAgentSwitch(): Promise<AgentSwitch> {
  try {
    const { data, error } = await createAdminClient()
      .from("app_settings")
      .select("agent_enabled, agent_paused_at, agent_pause_reason, users:agent_paused_by(nombre)")
      .eq("id", 1)
      .maybeSingle();
    if (error) throw error;
    const who = data?.users as unknown as { nombre: string } | null;
    const value: AgentSwitch = {
      enabled: data?.agent_enabled ?? true,
      pausedAt: (data?.agent_paused_at as string | null) ?? null,
      pausedBy: who?.nombre ?? null,
      reason: (data?.agent_pause_reason as string | null) ?? null,
    };
    return value;
  } catch (err) {
    // Ante la duda, el bot sigue atendiendo: quedarse mudo es peor que responder de más.
    console.error("[ajustes] no se pudo leer el interruptor del agente; se asume encendido", err);
    return ON;
  }
}

/** ¿Puede el agente hablarle al cliente ahora mismo? */
export async function isAgentEnabled(): Promise<boolean> {
  return (await getAgentSwitch()).enabled;
}

/** Enciende o apaga el agente para todo el negocio. Queda registrado quién y por qué. */
export async function setAgentEnabled(enabled: boolean, userId: string, reason?: string | null): Promise<void> {
  const { error } = await createAdminClient()
    .from("app_settings")
    .update({
      agent_enabled: enabled,
      agent_paused_at: enabled ? null : new Date().toISOString(),
      agent_paused_by: enabled ? null : userId,
      agent_pause_reason: enabled ? null : (reason?.trim().slice(0, 200) || null),
      updated_at: new Date().toISOString(),
    })
    .eq("id", 1);
  if (error) throw error;
}
