"use client";
import { useRouter } from "next/navigation";
import { useEffect, useState, type FormEvent } from "react";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";

export function LoginForm() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  // Hasta que React hidrata el formulario, el envío sería un GET nativo con la contraseña en la URL.
  const [ready, setReady] = useState(false);
  useEffect(() => setReady(true), []);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    const form = new FormData(e.currentTarget);
    const { error } = await createSupabaseBrowserClient().auth.signInWithPassword({
      email: String(form.get("email")),
      password: String(form.get("password")),
    });
    if (error) {
      setError("Correo o contraseña incorrectos");
      setLoading(false);
      return;
    }
    router.replace("/inbox");
    router.refresh();
  }

  return (
    <form onSubmit={onSubmit} method="post" className="stack">
      <label>
        Correo
        <input name="email" type="email" autoComplete="email" placeholder="tu@correo.com" required />
      </label>
      <label>
        Contraseña
        <input name="password" type="password" autoComplete="current-password" placeholder="••••••••" required />
      </label>
      {error && <p className="error">{error}</p>}
      <button type="submit" disabled={!ready || loading}>
        {loading ? "Ingresando…" : "Ingresar"}
      </button>
    </form>
  );
}
