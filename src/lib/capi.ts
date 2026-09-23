import "server-only";
import { env } from "@/lib/env";

/**
 * API de Conversiones de Meta para mensajería de negocios: le avisa a Meta qué anuncio (ctwa_clid) terminó en una cita, para
 * que optimice las campañas hacia ese resultado. Solo si META_DATASET_ID está configurado y el lead llegó por un anuncio.
 * OJO: el formato sigue la documentación de Meta a la fecha; no se ha probado contra Meta real (falta el ID del conjunto de datos).
 */
export async function sendConversionEvent(input: { eventName: string; ctwaClid: string; eventTime?: Date }): Promise<void> {
  const res = await fetch(`${env.graphBaseUrl}/${env.graphVersion}/${env.metaDatasetId}/events`, {
    method: "POST",
    headers: { Authorization: `Bearer ${env.whatsappAccessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      data: [
        {
          event_name: input.eventName,
          event_time: Math.floor((input.eventTime ?? new Date()).getTime() / 1000),
          action_source: "business_messaging",
          messaging_channel: "whatsapp",
          user_data: { whatsapp_business_account_id: env.whatsappBusinessAccountId, ctwa_clid: input.ctwaClid },
        },
      ],
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`Meta (conversiones) respondió ${res.status}: ${(await res.text().catch(() => "")).slice(0, 300)}`);
}
