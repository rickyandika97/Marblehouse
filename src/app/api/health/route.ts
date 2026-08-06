import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

/**
 * Liveness + operational check (PRD §7.9).
 *
 * Grows over the phases: backup age and uncosted-batch count get added in
 * Phases 9 and 4. Keep it cheap — the Docker healthcheck calls it every 30s.
 */
export async function GET() {
  const startedAt = Date.now();

  try {
    await prisma.$queryRaw`SELECT 1`;

    return NextResponse.json({
      status: "ok",
      database: "connected",
      latencyMs: Date.now() - startedAt,
      timezone: process.env.TZ ?? "unset",
      timestamp: new Date().toISOString(),
    });
  } catch (e) {
    return NextResponse.json(
      {
        status: "error",
        database: "unreachable",
        message: e instanceof Error ? e.message : String(e),
        timestamp: new Date().toISOString(),
      },
      { status: 503 }
    );
  }
}
