import Link from "next/link";
import { createTeamMember, resetTeamMemberPassword, updateTeamMember } from "@/app/(panel)/crm-actions";
import { Avatar } from "@/components/avatar";
import { FormDialog } from "@/components/form-dialog";
import { Icon } from "@/components/icons";
import { PasswordField, TeamFields } from "@/components/team-fields";
import { requireAdmin } from "@/lib/session";

type Params = Record<string, string | string[] | undefined>;
const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

interface UserRow {
  id: string;
  nombre: string;
  email: string;
  role: "admin" | "vendedor";
  branch_id: string | null;
}

export default async function TeamPage({ searchParams }: { searchParams: Promise<Params> }) {
  const sp = await searchParams;
  const { supabase, profile } = await requireAdmin();
  const [{ data: usersData, error }, { data: branchesData }] = await Promise.all([
    supabase.from("users").select("id, nombre, email, role, branch_id").order("nombre"),
    supabase.from("branches").select("id, nombre, activa").order("nombre"),
  ]);
  if (error) throw error;

  const users = (usersData ?? []) as UserRow[];
  const branches = (branchesData ?? []) as { id: string; nombre: string; activa: boolean }[];
  const branchName = new Map(branches.map((b) => [b.id, b.nombre]));

  const err = first(sp.error) ?? null;
  const ok = first(sp.ok) ?? null;
  const preBranch = branches.some((b) => b.id === first(sp.sucursal)) ? (first(sp.sucursal) as string) : "";

  const admins = users.filter((u) => u.role === "admin");
  const asesores = users.filter((u) => u.role === "vendedor");
  // Sucursales activas que ningún asesor cubre (ni uno de esa sucursal ni uno que atienda todas): sus chats derivados solo los ven los administradores.
  const cubreTodas = asesores.some((u) => u.branch_id === null);
  const sinAsesor = cubreTodas ? [] : branches.filter((b) => b.activa && !asesores.some((u) => u.branch_id === b.id));

  return (
    <div className="page">
      <h1>Equipo</h1>
      <div className="page-head">
        <div className="stat-chips">
          <span className="stat-chip"><strong>{asesores.length}</strong> {asesores.length === 1 ? "asesor" : "asesores"}</span>
          <span className="stat-chip"><strong>{admins.length}</strong> {admins.length === 1 ? "administrador" : "administradores"}</span>
        </div>
        <span className="spacer" />
        <FormDialog
          trigger={
            <>
              <Icon name="mas" size={16} /> Nuevo usuario
            </>
          }
          triggerClassName="btn primary"
          title="Nuevo usuario"
          description="Podrá entrar al CRM con su correo y esta contraseña."
          defaultOpen={first(sp.nuevo) === "1"}
        >
          <form action={createTeamMember} className="stack" style={{ gap: 18 }}>
            <section className="form-section">
              <h3>Persona</h3>
              <div className="row">
                <label>
                  Nombre
                  <input name="nombre" required maxLength={80} placeholder="Ana Ramírez" />
                </label>
                <label>
                  Correo
                  <input name="email" type="email" required placeholder="ana@optuz.com" autoComplete="off" />
                </label>
              </div>
            </section>
            <section className="form-section">
              <h3>Acceso</h3>
              <TeamFields branches={branches.filter((b) => b.activa)} defaultBranch={preBranch} />
              <PasswordField label="Contraseña inicial" hint="Mínimo 8 caracteres. Compártesela por un medio seguro; podrá cambiarla luego." />
            </section>
            <div className="form-actions">
              <button type="submit">Crear usuario</button>
            </div>
          </form>
        </FormDialog>
      </div>
      <p className="page-intro">
        Este canal es de <strong>citas</strong>: normalmente bastan <strong>1 o 2 personas</strong> para todo el negocio. Un <strong>asesor</strong> responde los chats que el bot
        deriva y atiende las citas de <strong>todas las sucursales</strong> (puedes limitarlo a una si quieres). Los <strong>administradores</strong> además configuran el agente,
        las sucursales y el equipo.
      </p>

      {err && <p className="banner warn">{err}</p>}
      {ok && <p className="banner ok">{ok}</p>}
      {!err && !ok && asesores.length === 0 && (
        <div className="banner">
          <strong>Aún no hay asesores.</strong> Cuando el bot deriva un chat a una persona, solo lo ven los administradores.{" "}
          <Link href="/equipo?nuevo=1">Agregar un asesor para todas las sucursales</Link>
        </div>
      )}
      {!err && !ok && asesores.length > 0 && sinAsesor.length > 0 && (
        <div className="banner warn">
          <strong>Sin asesor en:</strong> {sinAsesor.map((b) => b.nombre).join(", ")}. Los chats derivados de esas sucursales solo los ven los administradores.{" "}
          <Link href="/equipo?nuevo=1">Agregar un asesor para todas las sucursales</Link>
        </div>
      )}

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Persona</th>
              <th>Rol</th>
              <th>Atiende</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id}>
                <td>
                  <div className="cell-person">
                    <Avatar name={u.nombre} />
                    <div>
                      <span className="cell-main">{u.nombre}</span>
                      {u.id === profile.id && <span className="tag ok me-tag">Tú</span>}
                      <div className="cell-sub">{u.email}</div>
                    </div>
                  </div>
                </td>
                <td>{u.role === "admin" ? <span className="tag role-tag-admin">Administrador</span> : <span className="tag">Asesor</span>}</td>
                <td>{u.role === "admin" || u.branch_id === null ? <span className="muted">Todas las sucursales</span> : (branchName.get(u.branch_id) ?? <span className="tag warn">Sucursal desconocida</span>)}</td>
                <td style={{ textAlign: "right" }}>
                  <FormDialog trigger="Editar" title={u.nombre} description={u.email}>
                    <form action={updateTeamMember} className="stack" style={{ gap: 18 }}>
                      <input type="hidden" name="id" value={u.id} />
                      <section className="form-section">
                        <h3>Datos</h3>
                        <label>
                          Nombre
                          <input name="nombre" defaultValue={u.nombre} required maxLength={80} />
                        </label>
                        <TeamFields branches={branches.filter((b) => b.activa || b.id === u.branch_id)} defaultRole={u.role} defaultBranch={u.branch_id ?? ""} lockRole={u.id === profile.id} />
                        {u.id === profile.id && <span className="hint">Es tu propia cuenta: el rol de administrador no se puede quitar desde aquí.</span>}
                      </section>
                      <div className="form-actions">
                        <button type="submit">Guardar cambios</button>
                      </div>
                    </form>

                    <form action={resetTeamMemberPassword} className="stack">
                      <input type="hidden" name="id" value={u.id} />
                      <section className="form-section">
                        <h3>Contraseña</h3>
                        <PasswordField label="Nueva contraseña" hint="Reemplaza la actual de inmediato." />
                        <div className="form-actions">
                          <button type="submit" className="ghost">
                            Cambiar contraseña
                          </button>
                        </div>
                      </section>
                    </form>
                  </FormDialog>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
