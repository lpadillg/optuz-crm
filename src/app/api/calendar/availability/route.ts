import { NextResponse } from "next/server";
import { z } from "zod";
import { isAuthorized } from "@/lib/auth";
import { BookingError, getAvailableSlots } from "@/lib/appointments";

export const runtime = "nodejs";

const querySchema = z.object({
  branch_id: z.uuid(),
  date: z.iso.date(), // YYYY-MM-DD, hora de Lima
  duration: z.coerce.number().int().min(15).max(240).default(30),
});

// GET /api/calendar/availability?branch_id=…&date=2026-09-21&duration=30
export async function GET(req: Request) {
  if (!(await isAuthorized(req))) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const parsed = querySchema.safeParse(Object.fromEntries(new URL(req.url).searchParams));
  if (!parsed.success) return NextResponse.json({ error: z.prettifyError(parsed.error) }, { status: 400 });

  try {
    const slots = await getAvailableSlots(parsed.data.branch_id, parsed.data.date, parsed.data.duration);
    return NextResponse.json({ slots });
  } catch (err) {
    if (err instanceof BookingError) {
      return NextResponse.json({ error: err.message, code: err.code }, { status: err.code === "branch_not_found" ? 404 : 422 });
    }
    console.error("[calendar/availability]", err);
    return NextResponse.json({ error: "calendar unavailable" }, { status: 502 });
  }
}
