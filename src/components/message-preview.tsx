"use client";
import { useId, useState } from "react";

/**
 * Campo de texto con vista previa en burbuja de WhatsApp. Antes se escribía a ciegas: no se veía cómo
 * quedarían los saltos de línea ni cuánto ocupaba el mensaje que recibe el cliente.
 */
export function MessagePreviewField({
  name,
  label,
  rows = 4,
  maxLength = 1500,
  placeholder,
  hint,
  defaultValue = "",
}: {
  name: string;
  label: string;
  rows?: number;
  maxLength?: number;
  placeholder?: string;
  hint?: string;
  defaultValue?: string;
}) {
  const id = useId();
  const [value, setValue] = useState(defaultValue);
  const left = maxLength - value.length;

  return (
    <div className="field">
      <label htmlFor={id} style={{ fontWeight: 500, fontSize: 13 }}>
        {label}
      </label>
      <textarea
        id={id}
        name={name}
        rows={rows}
        required
        maxLength={maxLength}
        placeholder={placeholder}
        value={value}
        onChange={(e) => setValue(e.target.value)}
      />
      <div className="preview-row">
        <span className="hint">{hint ?? "Así lo recibe el cliente:"}</span>
        <span className={`hint${left < 80 ? " warn-text" : ""}`}>{left} caracteres libres</span>
      </div>
      <div className="wa-preview" aria-live="polite">
        {value.trim() ? (
          <div className="wa-bubble">{value}</div>
        ) : (
          <div className="wa-bubble empty">Escribe el mensaje para verlo aquí.</div>
        )}
      </div>
    </div>
  );
}
