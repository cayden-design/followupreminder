/**
 * All scheduling is done on plain calendar dates ("YYYY-MM-DD") in the
 * configured timezone. Storing timestamps instead would make a reminder due at
 * a different local date depending on where the container happens to run.
 */
export type IsoDate = string;

export function todayInTz(timezone: string, now = new Date()): IsoDate {
  // en-CA formats as YYYY-MM-DD, which is exactly the shape we store.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

function parts(date: IsoDate): [number, number, number] {
  const [y, m, d] = date.split("-").map(Number);
  return [y, m, d];
}

function daysInMonth(year: number, month1: number): number {
  return new Date(Date.UTC(year, month1, 0)).getUTCDate();
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/**
 * Clamps rather than rolling over: Nov 30 + 3 months is Feb 28/29, not Mar 2.
 * Plain `Date.setMonth` would overflow into the following month.
 */
export function addMonths(date: IsoDate, months: number): IsoDate {
  const [y, m, d] = parts(date);
  const total = (y * 12 + (m - 1)) + months;
  const year = Math.floor(total / 12);
  const month1 = (total % 12) + 1;
  const day = Math.min(d, daysInMonth(year, month1));
  return `${year}-${pad(month1)}-${pad(day)}`;
}

export function addDays(date: IsoDate, days: number): IsoDate {
  const [y, m, d] = parts(date);
  const t = new Date(Date.UTC(y, m - 1, d + days));
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

/** Monday of the week containing `date`. Used as the once-per-week dedupe key. */
export function mondayOf(date: IsoDate): IsoDate {
  const [y, m, d] = parts(date);
  const t = new Date(Date.UTC(y, m - 1, d));
  const dow = t.getUTCDay(); // 0 = Sunday
  const offset = dow === 0 ? -6 : 1 - dow;
  return addDays(date, offset);
}

export function formatHuman(date: IsoDate): string {
  const [y, m, d] = parts(date);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-US", {
    timeZone: "UTC",
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export function isValidIsoDate(value: unknown): value is IsoDate {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [y, m, d] = parts(value);
  return m >= 1 && m <= 12 && d >= 1 && d <= daysInMonth(y, m);
}
