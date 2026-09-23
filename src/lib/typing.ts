import { env } from "@/lib/env";

/**
 * Cuánto esperar antes de enviar la respuesta, para que el «escribiendo…» dure lo que duraría escribirla.
 *
 * El aviso de WhatsApp no se puede acortar: se apaga solo cuando enviamos el mensaje (o a los 25 s). Así que lo
 * que se ajusta es CUÁNDO se envía. Un mensaje largo tarda un poco más en salir que uno de dos palabras.
 *
 * El tiempo que tardó el modelo ya lo pasó el cliente viendo «escribiendo…», así que se descuenta: si pensar la
 * respuesta llevó más de lo que costaría escribirla, se envía de inmediato.
 */
export function humanPauseMs(text: string, elapsedMs = 0): number {
  const speed = env.typingCharsPerSecond;
  if (speed <= 0) return 0; // desactivado

  // Leer lo que escribió el cliente y pensar: un instante fijo, más lo que cuesta teclear la respuesta.
  const typingMs = (text.length / speed) * 1000;
  const total = clamp(env.typingLeadMs + typingMs, env.typingMinMs, env.typingMaxMs);
  return Math.round(Math.max(0, total - elapsedMs));
}

const clamp = (n: number, min: number, max: number) => Math.min(Math.max(n, min), max);
