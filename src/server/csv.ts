/**
 * CSV export (PRD §7.8, §9).
 *
 * **CSV is a cost-leak surface in its own right.** §15 requires that no plain
 * MANAGER or STAFF response body — "on any endpoint including CSV exports and
 * error payloads" — contains a cost value. A JSON DTO gate does nothing here:
 * a CSV is built from whatever rows the caller hands over, so the protection
 * has to be that a manager's export is BUILT FROM a cost-free query, never a
 * costed one with columns dropped afterwards (§7.8: "cost columns removed at
 * the query level").
 *
 * That is why `toCsv` takes explicit columns and every export in
 * `reports-export.ts` chooses its column set from the same `canSeeCost` gate
 * the JSON path uses. There is no "strip these headers" helper on purpose —
 * that shape is what leaks.
 */

export interface CsvColumn<Row> {
  header: string;
  value: (row: Row) => string | number | null | undefined;
}

/**
 * Escape one field per RFC 4180.
 *
 * A customer name containing a comma, a quote or a newline would otherwise
 * shift every subsequent column — and these exports carry real names typed by
 * staff, so this is a routine case rather than a hostile one.
 */
function escapeField(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "";
  const s = String(value);
  if (/[",\r\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

export function toCsv<Row>(rows: Row[], columns: CsvColumn<Row>[]): string {
  const head = columns.map((c) => escapeField(c.header)).join(",");
  const body = rows.map((row) =>
    columns.map((c) => escapeField(c.value(row))).join(",")
  );
  // CRLF per RFC 4180 — Excel on Windows is the actual consumer here, and it
  // is the least surprising choice for a self-hosted shop on a Windows box.
  return [head, ...body].join("\r\n") + "\r\n";
}

/**
 * A downloadable CSV response.
 *
 * The UTF-8 BOM is deliberate: without it, Excel reads the file as the local
 * ANSI codepage and mangles Indonesian names with accented characters. Every
 * other consumer ignores it.
 */
export function csvResponse(filename: string, csv: string): Response {
  return new Response("﻿" + csv, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${sanitiseFilename(filename)}"`,
      // These contain customer names, phone numbers and takings. Never let a
      // shared tablet's browser or an intermediary hold a copy (§14 R-14).
      "Cache-Control": "no-store, private",
    },
  });
}

/**
 * Strip anything that could break out of the quoted filename or traverse a
 * path. The report name reaches this from the URL.
 */
function sanitiseFilename(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 120);
}
