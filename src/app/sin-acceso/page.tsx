import { LogoutButton } from "@/components/logout-button";

export default function NoAccessPage() {
  return (
    <main className="login-page">
      <div className="login">
        <span className="logo" aria-hidden="true">
          O
        </span>
        <h1>Sin acceso</h1>
        <p className="muted">
          Tu cuenta existe pero aún no tiene un perfil en el CRM (rol y sucursal). Pídele a un administrador que te dé de
          alta desde <strong>Equipo</strong>.
        </p>
        <LogoutButton />
      </div>
    </main>
  );
}
