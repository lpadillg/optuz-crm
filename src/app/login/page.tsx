import { LoginForm } from "./login-form";

export const metadata = { title: "Ingresar — Optuz CRM" };

export default function LoginPage() {
  return (
    <main className="login-page">
      <div className="login">
        <span className="logo" aria-hidden="true">
          O
        </span>
        <h1>Optuz CRM</h1>
        <p className="muted">Atención por WhatsApp y citas de las sucursales. Ingresa con tu correo del equipo.</p>
        <LoginForm />
      </div>
    </main>
  );
}
