import "server-only";
import { env } from "@/lib/env";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Aviso por correo a los administradores (Resend). Opcional: sin RESEND_API_KEY y ALERT_EMAIL_FROM no hace nada y devuelve
 * false (el aviso igual aparece en el panel). Nunca lanza: un aviso fallido no debe romper el proceso que lo pidió.
 */
export async function notifyAdmins(subject: string, text: string): Promise<boolean> {
  if (!env.resendApiKey || !env.alertEmailFrom) return false;
  try {
    const { data } = await createAdminClient().from("users").select("email").eq("role", "admin");
    const to = (data ?? []).map((u) => u.email as string).filter(Boolean);
    if (to.length === 0) return false;
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${env.resendApiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: env.alertEmailFrom, to, subject, text }),
    });
    if (!res.ok) console.error("[alerts] Resend respondió", res.status, await res.text().catch(() => ""));
    return res.ok;
  } catch (err) {
    console.error("[alerts] no se pudo enviar el correo", err);
    return false;
  }
}
