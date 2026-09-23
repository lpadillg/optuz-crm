import { NextResponse } from "next/server";
import { parseLeadFilters, queryLeads } from "@/lib/leads-query";
import { csvCell } from "@/lib/phone";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { ARCHIVE_REASON_LABEL, LEAD_STAGE_LABEL, type ArchiveReason, type LeadStage } from "@/lib/types";

/** Exporta los contactos (con los filtros de la pantalla) a CSV. RLS limita a la sucursal del usuario. */
export async function GET(req: Request) {
  const supabase = await createSupabaseServerClient();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) return NextResponse.json({ error: "No autenticado" }, { status: 401 });

  const filters = parseLeadFilters(Object.fromEntries(new URL(req.url).searchParams));
  const { data, error } = await queryLeads(supabase, filters, 5000);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const rows = (data ?? []) as unknown as {
    nombre: string | null;
    phone: string | null;
    email: string | null;
    stage: LeadStage;
    archived_at: string | null;
    archive_reason: string | null;
    source: string;
    opt_out: boolean;
    promo_consent: boolean;
    tags: string[];
    created_at: string;
    branches: { nombre: string } | null;
  }[];

  const header = ["Nombre", "Teléfono", "Email", "Sucursal", "Etapa", "Origen", "Etiquetas", "Baja", "Acepta promociones", "Creado"];
  const lines = rows.map((r) =>
    [
      r.nombre,
      r.phone,
      r.email,
      r.branches?.nombre,
      r.archived_at ? `Archivado: ${ARCHIVE_REASON_LABEL[r.archive_reason as ArchiveReason] ?? ""}` : LEAD_STAGE_LABEL[r.stage],
      r.source === "ctwa" ? "Anuncio" : "Otro",
      r.tags.join("; "),
      r.opt_out ? "Sí" : "No",
      r.promo_consent ? "Sí" : "No",
      r.created_at,
    ]
      .map(csvCell)
      .join(","),
  );
  // BOM para que Excel abra bien las tildes.
  const body = "﻿" + [header.join(","), ...lines].join("\r\n");
  return new NextResponse(body, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="contactos-${new Date().toISOString().slice(0, 10)}.csv"`,
    },
  });
}
