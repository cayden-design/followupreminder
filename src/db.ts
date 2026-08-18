import pg from "pg";
import { config } from "./config.js";
import type { IsoDate } from "./dates.js";

/**
 * node-pg hydrates DATE columns into JS Date objects at local midnight, which
 * shifts the calendar date backwards for any timezone west of UTC (a reminder
 * stored as Nov 18 reads back as Nov 17 in New York). Every read casts the
 * date columns with to_char so they come back as the plain calendar dates we
 * store. Doing it in SQL rather than via a global type parser keeps it true no
 * matter what else in the process touches pg.types.
 */
const CONTACT_COLUMNS = `
  id, name, email, company, notes, created_at,
  to_char(remind_at, 'YYYY-MM-DD')         AS remind_at,
  to_char(last_contacted_at, 'YYYY-MM-DD') AS last_contacted_at,
  last_reminded_at, archived
`;

export const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  ssl: config.databaseUrl.includes("localhost") ? undefined : { rejectUnauthorized: false },
  max: 5,
});

export interface Contact {
  id: number;
  name: string;
  email: string | null;
  company: string | null;
  notes: string | null;
  created_at: Date;
  remind_at: IsoDate;
  last_contacted_at: IsoDate | null;
  last_reminded_at: Date | null;
  archived: boolean;
}

export async function initSchema(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS contacts (
      id                SERIAL PRIMARY KEY,
      name              TEXT NOT NULL,
      email             TEXT,
      company           TEXT,
      notes             TEXT,
      created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
      remind_at         DATE NOT NULL,
      last_contacted_at DATE,
      last_reminded_at  TIMESTAMPTZ,
      archived          BOOLEAN NOT NULL DEFAULT FALSE
    );
    CREATE INDEX IF NOT EXISTS contacts_due_idx ON contacts (remind_at) WHERE archived = FALSE;

    -- One row per week the digest went out. The primary key is what makes the
    -- "notify once per week" guarantee hold across restarts and redeploys.
    CREATE TABLE IF NOT EXISTS digest_runs (
      week_of       DATE PRIMARY KEY,
      ran_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
      contact_count INTEGER NOT NULL DEFAULT 0
    );
  `);
}

export async function listContacts(includeArchived = false): Promise<Contact[]> {
  const { rows } = await pool.query<Contact>(
    `SELECT ${CONTACT_COLUMNS} FROM contacts
      WHERE ($1::boolean OR archived = FALSE)
      ORDER BY archived ASC, remind_at ASC, id ASC`,
    [includeArchived],
  );
  return rows;
}

export async function addContact(input: {
  name: string;
  email?: string | null;
  company?: string | null;
  notes?: string | null;
  remindAt: IsoDate;
  lastContactedAt?: IsoDate | null;
}): Promise<Contact> {
  const { rows } = await pool.query<Contact>(
    `INSERT INTO contacts (name, email, company, notes, remind_at, last_contacted_at)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING ${CONTACT_COLUMNS}`,
    [
      input.name,
      input.email || null,
      input.company || null,
      input.notes || null,
      input.remindAt,
      input.lastContactedAt || null,
    ],
  );
  return rows[0];
}

export async function dueContacts(asOf: IsoDate): Promise<Contact[]> {
  const { rows } = await pool.query<Contact>(
    `SELECT ${CONTACT_COLUMNS} FROM contacts
      WHERE archived = FALSE AND remind_at <= $1
      ORDER BY remind_at ASC, id ASC`,
    [asOf],
  );
  return rows;
}

/** Sets the next touch date and records that the outreach actually happened. */
export async function markContacted(id: number, today: IsoDate, nextRemindAt: IsoDate): Promise<void> {
  await pool.query(
    `UPDATE contacts SET last_contacted_at = $2, remind_at = $3 WHERE id = $1`,
    [id, today, nextRemindAt],
  );
}

export async function snooze(id: number, nextRemindAt: IsoDate): Promise<void> {
  await pool.query(`UPDATE contacts SET remind_at = $2 WHERE id = $1`, [id, nextRemindAt]);
}

export async function setArchived(id: number, archived: boolean): Promise<void> {
  await pool.query(`UPDATE contacts SET archived = $2 WHERE id = $1`, [id, archived]);
}

/**
 * Stamps the same set `dueContacts(asOf)` just returned. Re-using the predicate
 * rather than passing the ids back keeps the two in step and avoids marshalling
 * an array parameter.
 */
export async function markReminded(asOf: IsoDate): Promise<void> {
  await pool.query(
    `UPDATE contacts SET last_reminded_at = now() WHERE archived = FALSE AND remind_at <= $1`,
    [asOf],
  );
}

/**
 * Reserves this week's digest slot. Returns false if it was already taken, so
 * a redeploy, a manual trigger, or a second replica can't double-notify.
 */
export async function claimWeek(weekOf: IsoDate): Promise<boolean> {
  // RETURNING rather than rowCount: a row comes back only on a real insert,
  // which is unambiguous regardless of how the driver reports affected rows.
  const { rows } = await pool.query(
    `INSERT INTO digest_runs (week_of) VALUES ($1) ON CONFLICT (week_of) DO NOTHING RETURNING week_of`,
    [weekOf],
  );
  return rows.length === 1;
}

export async function releaseWeek(weekOf: IsoDate): Promise<void> {
  await pool.query(`DELETE FROM digest_runs WHERE week_of = $1`, [weekOf]);
}

export async function finishWeek(weekOf: IsoDate, contactCount: number): Promise<void> {
  await pool.query(
    `UPDATE digest_runs SET contact_count = $2, ran_at = now() WHERE week_of = $1`,
    [weekOf, contactCount],
  );
}
