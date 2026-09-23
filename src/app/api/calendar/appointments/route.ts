import { NextResponse } from "next/server";
import { z } from "zod";
import { isAuthorized } from "@/lib/auth";
import { BookingError, SERVICE_TYPES, bookAppointment } from "@/lib/appointments";

export const runtime = "nodejs";

const bodySchema = z.object({
  lead_id: z.uuid(),
  branch_id: z.uuid(),
  tipo_servicio: z.enum(SERVICE_TYPES).default("examen_visual"),
  promotion_id: z.uuid().optional(),
  starts_at: z.iso.datetime({ offset: true }),
  duration_minutes: z.number().int().min(15).max(240).default(30),
});

// POST /api/calendar/appointments → crea la cita en Postgres y el evento en el Google Calendar de la sucursal
export async function POST(req: Request) {
  if (!(await isAuthorized(req))) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: z.prettifyError(parsed.error) }, { status: 400 });
  const b = parsed.data;

  try {
    const result = await bookAppointment({
      leadId: b.lead_id,
      branchId: b.branch_id,
      tipoServicio: b.tipo_servicio,
      promotionId: b.promotion_id,
      startsAt: new Date(b.starts_at),
      durationMinutes: b.duration_minutes,
    });
    return NextResponse.json(
      { appointment_id: result.appointmentId, google_event_id: result.googleEventId },
      { status: 201 },
    );
  } catch (err) {
    if (err instanceof BookingError) {
      const status =
        err.code === "slot_taken" ? 409
        : err.code === "branch_not_found" || err.code === "lead_not_found" ? 404
        : 422; // no_calendar, outside_hours, invalid_promotion
      return NextResponse.json({ error: err.message, code: err.code }, { status });
    }
    console.error("[calendar/appointments]", err);
    return NextResponse.json({ error: "calendar unavailable" }, { status: 502 });
  }
}
