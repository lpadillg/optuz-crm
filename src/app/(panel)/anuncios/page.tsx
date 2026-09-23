import { setAdSpend } from "@/app/(panel)/crm-actions";
import { FormDialog } from "@/components/form-dialog";
import { Icon } from "@/components/icons";
import { PageHelp } from "@/components/page-help";
import { LEAD_ORIGINS, LEAD_ORIGIN_LABEL, type LeadOrigin } from "@/lib/types";
import { env } from "@/lib/env";
import { requireAdmin } from "@/lib/session";

const money = (n: number) => new Intl.NumberFormat("es-PE", { style: "currency", currency: "PEN", maximumFractionDigits: 2 }).format(n);

export default async function AdsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  const { supabase } = await requireAdmin();
  const [leadsQ, spendQ] = await Promise.all([
    supabase.from("leads").select("ad_id, last_ad_id, origin, status, branches(nombre), appointments(status)").limit(20000),
    supabase.from("ad_spend").select("ad_id, amount, note"),
  ]);
  if (leadsQ.error) throw leadsQ.error;

  type L = {
    ad_id: string | null;
    last_ad_id: string | null;
    origin: LeadOrigin;
    status: string;
    branches: { nombre: string } | null;
    appointments: { status: string }[];
  };
  const leads = (leadsQ.data ?? []) as unknown as L[];
  const spend = new Map((spendQ.data ?? []).map((r) => [r.ad_id as string, { amount: Number(r.amount), note: r.note as string | null }]));

  interface Row { ad: string; leads: number; citas: number; atendidos: number; branch: string }
  const byAd = new Map<string, Row & { branches: Map<string, number> }>();
  let organic = { leads: 0, citas: 0, atendidos: 0 };
  for (const l of leads) {
    const booked = l.appointments.some((a) => a.status !== "cancelada");
    const done = l.appointments.some((a) => a.status === "atendida");
    if (!l.ad_id) {
      organic = { leads: organic.leads + 1, citas: organic.citas + (booked ? 1 : 0), atendidos: organic.atendidos + (done ? 1 : 0) };
      continue;
    }
    const r = byAd.get(l.ad_id) ?? { ad: l.ad_id, leads: 0, citas: 0, atendidos: 0, branch: "", branches: new Map() };
    r.leads++;
    if (booked) r.citas++;
    if (done) r.atendidos++;
    const b = l.branches?.nombre ?? "Sin sucursal";
    r.branches.set(b, (r.branches.get(b) ?? 0) + 1);
    byAd.set(l.ad_id, r);
  }
  const rows = [...byAd.values()]
    .map((r) => ({ ...r, branch: [...r.branches.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "—" }))
    .sort((a, b) => b.leads - a.leads);

  // De dónde viene la gente, más allá de los anuncios: redes sin pagar, clientes antiguos, recomendados…
  const porOrigen = LEAD_ORIGINS.map((o) => {
    const suyos = leads.filter((l) => l.origin === o);
    const citas = suyos.filter((l) => l.appointments.some((a) => a.status !== "cancelada")).length;
    return { origin: o, leads: suyos.length, citas };
  }).filter((r) => r.leads > 0);
  const maxOrigen = Math.max(1, ...porOrigen.map((r) => r.leads));

  // Un cliente viejo que vuelve por una campaña nueva: el mérito es de la campaña que lo trajo de vuelta.
  const recuperados = leads.filter((l) => l.last_ad_id && l.ad_id && l.last_ad_id !== l.ad_id).length;

  const totalLeads = rows.reduce((n, r) => n + r.leads, 0);
  const totalCitas = rows.reduce((n, r) => n + r.citas, 0);
  const totalSpend = rows.reduce((n, r) => n + (spend.get(r.ad)?.amount ?? 0), 0);
  const err = typeof sp.error === "string" ? sp.error : null;
  const ok = typeof sp.ok === "string" ? sp.ok : null;

  return (
    <div className="page">
      <h1>Anuncios</h1>
      <div className="page-head">
        <div className="stat-chips">
          <span className="stat-chip"><strong>{totalLeads}</strong> leads por anuncio</span>
          <span className="stat-chip"><strong>{totalCitas}</strong> con cita</span>
          <span className="stat-chip">Costo por cita: <strong>{totalSpend > 0 && totalCitas > 0 ? money(totalSpend / totalCitas) : "—"}</strong></span>
          <span className={`stat-chip${env.metaDatasetId ? "" : " warn"}`}>Envío a Meta: <strong>{env.metaDatasetId ? "activo" : "sin configurar"}</strong></span>
        </div>
      </div>
      <PageHelp
        more={
          <>
            <p>
              Aquí llegan los clientes que escribieron desde un anuncio de Click-to-WhatsApp. Anota lo que gastaste en cada
              uno para ver el costo por cita, que es lo que de verdad importa.
            </p>
            <p>
              Con el envío a Meta activo, cada cita agendada se le informa a Meta para que optimice tus campañas hacia
              citas y no solo hacia mensajes. Se activa en <code>.env.local</code>; su estado se ve en Sistema.
            </p>
          </>
        }
      >
        Qué anuncios traen clientes y cuáles terminan en cita.
      </PageHelp>
      {err && <p className="banner warn">{err}</p>}
      {ok && <p className="banner ok">{ok}</p>}

      {porOrigen.length > 0 && (
        <section className="card wide" style={{ marginBottom: 18 }}>
          <div className="row-head" style={{ marginBottom: 6 }}>
            <h2>De dónde vienen</h2>
            <span className="spacer" />
            {recuperados > 0 && (
              <span className="muted">
                {recuperados} {recuperados === 1 ? "cliente volvió" : "clientes volvieron"} con otro anuncio
              </span>
            )}
          </div>
          <p className="muted" style={{ fontSize: 12, margin: "0 0 10px" }}>
            No todos llegan por un anuncio. Lo que no se detecta solo lo anotas en la ficha del contacto.
          </p>
          {porOrigen.map((r) => (
            <div key={r.origin} className="meter">
              <span>{LEAD_ORIGIN_LABEL[r.origin]}</span>
              <div className="track">
                <div className="fill" style={{ width: `${(r.leads / maxOrigen) * 100}%` }} />
              </div>
              <strong>
                {r.leads} <span className="muted" style={{ fontWeight: 400, fontSize: 12 }}>· {r.citas} con cita</span>
              </strong>
            </div>
          ))}
        </section>
      )}

      <div className="table-wrap">
        <table>
          <thead>
            <tr><th>Anuncio</th><th>Sucursal</th><th>Leads</th><th>Con cita</th><th className="hide-sm">Atendidos</th><th className="hide-sm">Conversión</th><th>Gasto</th><th>Costo / cita</th><th /></tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const s = spend.get(r.ad);
              return (
                <tr key={r.ad}>
                  <td><code>{r.ad}</code></td>
                  <td>{r.branch}</td>
                  <td>{r.leads}</td>
                  <td>{r.citas}</td>
                  <td className="hide-sm">{r.atendidos}</td>
                  <td className="hide-sm">{r.leads ? `${Math.round((r.citas / r.leads) * 100)}%` : "—"}</td>
                  <td>{s ? money(s.amount) : <span className="muted">sin dato</span>}</td>
                  <td>{s && r.citas ? money(s.amount / r.citas) : <span className="muted">—</span>}</td>
                  <td>
                    <FormDialog trigger="Gasto" title={`Gasto del anuncio ${r.ad}`} description="Total invertido en este anuncio (soles).">
                      <form action={setAdSpend} className="stack" style={{ gap: 14 }}>
                        <input type="hidden" name="ad_id" value={r.ad} />
                        <label>Monto gastado (S/)<input name="amount" type="number" min="0" step="0.01" required defaultValue={s?.amount ?? ""} /></label>
                        <label>Nota <span className="hint">(opcional)</span><input name="note" maxLength={200} defaultValue={s?.note ?? ""} placeholder="Campaña de septiembre" /></label>
                        <div className="form-actions"><button type="submit">Guardar</button></div>
                      </form>
                    </FormDialog>
                  </td>
                </tr>
              );
            })}
            {(organic.leads > 0 || rows.length > 0) && (
              <tr className="row-organic">
                <td>
                  <strong>Sin anuncio</strong>
                  <div className="cell-sub">Orgánico y directo</div>
                </td>
                <td className="muted">—</td>
                <td>{organic.leads}</td>
                <td>{organic.citas}</td>
                <td className="hide-sm">{organic.atendidos}</td>
                <td className="hide-sm">{organic.leads ? `${Math.round((organic.citas / organic.leads) * 100)}%` : "—"}</td>
                <td className="muted">sin costo</td>
                <td className="muted">—</td>
                <td />
              </tr>
            )}
            {rows.length === 0 && organic.leads === 0 && (
              <tr>
                <td colSpan={9} className="empty-row">
                  <div className="empty-state">
                    <span className="ico"><Icon name="tendencia" size={22} /></span>
                    <strong>Aún no hay leads que vengan de un anuncio</strong>
                    <p className="muted">Aparecen cuando alguien escribe desde un anuncio de Click-to-WhatsApp y Meta envía el identificador (requiere «Ads attribution» activado en tu cuenta).</p>
                  </div>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

    </div>
  );
}
