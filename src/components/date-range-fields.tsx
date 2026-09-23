"use client";
import { useState } from "react";

/** "2026-09-21T14:30" en hora de Lima, que es lo que espera <input type="datetime-local">. */
function limaLocal(d: Date): string {
  return new Date(d.getTime() - 5 * 3_600_000).toISOString().slice(0, 16);
}

const startOfToday = () => {
  const d = new Date(limaLocal(new Date()).slice(0, 10) + "T00:00:00-05:00");
  return d;
};

const atEndOf = (d: Date) => new Date(`${limaLocal(d).slice(0, 10)}T23:59:00-05:00`);

const presets: { label: string; from: () => Date; to: () => Date }[] = [
  {
    label: "Esta semana",
    from: () => startOfToday(),
    to: () => {
      // Hasta el sábado (el domingo está cerrado).
      const d = startOfToday();
      const day = new Date(d.getTime() - 5 * 3_600_000).getUTCDay();
      return atEndOf(new Date(d.getTime() + ((6 - day + 7) % 7) * 86_400_000));
    },
  },
  {
    label: "Hasta fin de mes",
    from: () => startOfToday(),
    to: () => {
      const now = new Date(limaLocal(new Date()));
      return atEndOf(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0, 12)));
    },
  },
  { label: "30 días", from: () => startOfToday(), to: () => atEndOf(new Date(Date.now() + 30 * 86_400_000)) },
];

/**
 * Vigencia de una promoción: atajos para lo habitual y las fechas exactas debajo, por si hay que afinarlas.
 * Antes había que teclear día, mes, año, hora y minuto en dos campos vacíos.
 */
export function DateRangeFields({
  fromName = "valid_from",
  toName = "valid_to",
  defaultFrom,
  defaultTo,
}: {
  fromName?: string;
  toName?: string;
  /** Al editar: la vigencia que ya tiene, en ISO. */
  defaultFrom?: string;
  defaultTo?: string;
}) {
  const [from, setFrom] = useState(() => (defaultFrom ? limaLocal(new Date(defaultFrom)) : limaLocal(startOfToday())));
  const [to, setTo] = useState(() => (defaultTo ? limaLocal(new Date(defaultTo)) : limaLocal(presets[1].to())));
  const [active, setActive] = useState(defaultFrom ? -1 : 1);

  function pick(i: number) {
    setFrom(limaLocal(presets[i].from()));
    setTo(limaLocal(presets[i].to()));
    setActive(i);
  }

  return (
    <div className="field">
      <span style={{ fontWeight: 500, fontSize: 13 }}>Vigencia</span>
      <div className="chips-row" role="group" aria-label="Vigencia">
        {presets.map((p, i) => (
          <button key={p.label} type="button" className={`chip-btn${active === i ? " on" : ""}`} aria-pressed={active === i} onClick={() => pick(i)}>
            {p.label}
          </button>
        ))}
      </div>
      <div className="row">
        <label>
          Desde <span className="hint">(hora de Lima)</span>
          <input name={fromName} type="datetime-local" required value={from} onChange={(e) => { setFrom(e.target.value); setActive(-1); }} />
        </label>
        <label>
          Hasta <span className="hint">(hora de Lima)</span>
          <input name={toName} type="datetime-local" required value={to} onChange={(e) => { setTo(e.target.value); setActive(-1); }} />
        </label>
      </div>
    </div>
  );
}
