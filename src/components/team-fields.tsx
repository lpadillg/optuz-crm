"use client";
import { useId, useState } from "react";

/**
 * Rol + sucursal juntos. Este canal es de citas y lo atienden 1 o 2 personas, así que lo normal es que el asesor atienda TODAS
 * las sucursales (sin sucursal); solo si se quiere se le limita a una. El administrador siempre ve todas (el selector se desactiva).
 */
export function TeamFields({
  branches,
  defaultRole = "vendedor",
  defaultBranch = "",
  lockRole = false,
}: {
  branches: { id: string; nombre: string }[];
  defaultRole?: "admin" | "vendedor";
  defaultBranch?: string;
  /** Para uno mismo: no puede quitarse el rol de administrador. */
  lockRole?: boolean;
}) {
  const [role, setRole] = useState<"admin" | "vendedor">(defaultRole);
  return (
    <div className="row">
      <label>
        Rol
        {lockRole && <input type="hidden" name="role" value={role} />}
        <select
          name={lockRole ? undefined : "role"}
          value={role}
          disabled={lockRole}
          onChange={(e) => setRole(e.target.value as "admin" | "vendedor")}
          style={{ width: "100%" }}
        >
          <option value="vendedor">Asesor</option>
          <option value="admin">Administrador</option>
        </select>
        <span className="hint">{role === "admin" ? "Atiende todo y además configura el agente, el equipo y las sucursales." : "Atiende los chats y las citas. No configura el sistema."}</span>
      </label>
      <label>
        Atiende
        <select name="branch_id" defaultValue={defaultBranch} disabled={role === "admin"} style={{ width: "100%" }}>
          <option value="">Todas las sucursales</option>
          {branches.map((b) => (
            <option key={b.id} value={b.id}>
              {b.nombre}
            </option>
          ))}
        </select>
        <span className="hint">{role === "admin" ? "El administrador siempre ve todas." : "Déjalo en «Todas» salvo que quieras limitarlo a una sola sucursal."}</span>
      </label>
    </div>
  );
}

// Sin 0/O ni 1/l/I para que se pueda dictar o copiar sin confundirse.
const CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";

/** Contraseña con «Mostrar» y «Generar» (12 caracteres aleatorios) para no inventar claves débiles. */
export function PasswordField({ label = "Contraseña", name = "password", hint }: { label?: string; name?: string; hint?: string }) {
  const id = useId();
  const [value, setValue] = useState("");
  const [show, setShow] = useState(false);
  const [copied, setCopied] = useState(false);

  function generate() {
    const bytes = new Uint32Array(12);
    crypto.getRandomValues(bytes);
    setValue(Array.from(bytes, (n) => CHARS[n % CHARS.length]).join(""));
    setShow(true);
    setCopied(false);
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      /* sin permiso de portapapeles: la contraseña queda visible para copiarla a mano */
    }
  }

  return (
    <div className="field">
      <label htmlFor={id} style={{ fontWeight: 500, fontSize: 13 }}>
        {label}
      </label>
      <div className="pw">
        <input
          id={id}
          name={name}
          type={show ? "text" : "password"}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          required
          minLength={8}
          autoComplete="new-password"
        />
        <button type="button" className="ghost btn-sm" onClick={() => setShow((s) => !s)}>
          {show ? "Ocultar" : "Mostrar"}
        </button>
        <button type="button" className="ghost btn-sm" onClick={generate}>
          Generar
        </button>
        {value && show && (
          <button type="button" className="ghost btn-sm" onClick={copy}>
            {copied ? "¡Copiada!" : "Copiar"}
          </button>
        )}
      </div>
      <span className="hint">{hint ?? "Mínimo 8 caracteres."}</span>
    </div>
  );
}
