process.env.DATABASE_URL = "postgresql://localhost:5432/memdb";
process.env.APP_PASSWORD = "hunter2";
process.env.SLACK_WEBHOOK_URL = "https://hooks.slack.test/x";
process.env.TIMEZONE = "America/New_York";

import pg from "pg";
import { DataType, newDb } from "pg-mem";

const mem = newDb({ autoCreateForeignKeyIndices: true });

// pg-mem has no to_char; real Postgres does. Stand in a YYYY-MM-DD-only
// version so the production SQL runs unmodified against the fake DB.
mem.public.registerFunction({
  name: "to_char",
  args: [DataType.date, DataType.text],
  returns: DataType.text,
  implementation: (d: unknown) => {
    if (d === null || d === undefined) return null;
    if (d instanceof Date) {
      const p = (n: number) => String(n).padStart(2, "0");
      return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
    }
    return String(d).slice(0, 10);
  },
});

const adapter = mem.adapters.createPg();
(pg as any).Pool = adapter.Pool;

const sent: Array<{ text: string; blocks: any[] }> = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (url: any, init: any) => {
  if (String(url).includes("slack")) {
    sent.push(JSON.parse(init.body));
    return new Response("ok", { status: 200 });
  }
  return realFetch(url, init);
}) as typeof fetch;

const db = await import("../src/db.js");
const { createServer } = await import("../src/server.js");
const { runWeeklyDigest } = await import("../src/reminders.js");
const { todayInTz, addMonths, mondayOf, isValidIsoDate } = await import("../src/dates.js");

let fails = 0;
function check(label: string, cond: boolean, detail = "") {
  if (!cond) fails++;
  console.log(`${cond ? "PASS" : "FAIL"} ${label}${cond || !detail ? "" : ` -- ${detail}`}`);
}

// --- calendar arithmetic (no DB needed) ---
check("addMonths +3", addMonths("2026-08-18", 3) === "2026-11-18");
check("addMonths clamps Nov30 -> Feb28", addMonths("2025-11-30", 3) === "2026-02-28");
check("addMonths clamps into leap Feb29", addMonths("2027-11-30", 3) === "2028-02-29");
check("addMonths clamps Aug31 -> Nov30", addMonths("2026-08-31", 3) === "2026-11-30");
check("addMonths crosses the year", addMonths("2026-11-15", 3) === "2027-02-15");
check("mondayOf a Tuesday", mondayOf("2026-08-18") === "2026-08-17");
check("mondayOf a Monday is itself", mondayOf("2026-08-17") === "2026-08-17");
check("mondayOf a Sunday looks back", mondayOf("2026-08-23") === "2026-08-17");
check("mondayOf crosses the month", mondayOf("2026-03-01") === "2026-02-23");
check("Feb 29 rejected in a common year", isValidIsoDate("2026-02-29") === false);
check("Feb 29 accepted in a leap year", isValidIsoDate("2028-02-29") === true);
check("junk date rejected", isValidIsoDate("not-a-date") === false);

await db.initSchema();
console.log("-- schema created --");

const app = createServer();
const server = app.listen(0);
await new Promise((r) => server.once("listening", r));
const port = (server.address() as any).port;
const base = `http://127.0.0.1:${port}`;
const auth = "Basic " + Buffer.from("x:hunter2").toString("base64");

// --- health is public ---
const health = await realFetch(`${base}/health`);
check("GET /health is public and 200", health.status === 200);

// --- auth gate ---
const noAuth = await realFetch(`${base}/`);
check("GET / without auth is 401", noAuth.status === 401, `got ${noAuth.status}`);
const badAuth = await realFetch(`${base}/`, { headers: { Authorization: "Basic " + Buffer.from("x:wrong").toString("base64") } });
check("GET / with wrong password is 401", badAuth.status === 401, `got ${badAuth.status}`);

// --- add a contact via the form, default 3-month reminder ---
const today = todayInTz("America/New_York");
const addRes = await realFetch(`${base}/contacts`, {
  method: "POST",
  redirect: "manual",
  headers: { Authorization: auth, "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ name: "Dana Reed", email: "dana@acme.com", company: "Acme", notes: "Talked pricing", remind_at: "" }),
});
check("POST /contacts redirects", addRes.status === 302, `got ${addRes.status}`);
let all = await db.listContacts(true);
check("contact was stored", all.length === 1, `count ${all.length}`);
check("default reminder is +3 months", all[0]?.remind_at === addMonths(today, 3), `got ${all[0]?.remind_at} want ${addMonths(today, 3)}`);
check("remind_at is a plain string not a Date", typeof all[0]?.remind_at === "string", `got ${typeof all[0]?.remind_at}`);

// --- a contact already due, plus one not due ---
const due1 = await db.addContact({ name: "Overdue Olga", email: "olga@x.com", company: "Xco", remindAt: "2026-01-05" });
await db.addContact({ name: "Future Fred", email: "fred@y.com", remindAt: "2099-01-01" });

const dueNow = await db.dueContacts(today);
check("dueContacts returns only past-due, unarchived", dueNow.length === 1 && dueNow[0].name === "Overdue Olga", JSON.stringify(dueNow.map((c) => c.name)));

// --- digest sends once ---
const r1 = await runWeeklyDigest();
check("first digest sends", r1.sent === true, JSON.stringify(r1));
check("digest counted 1 contact", r1.contactCount === 1, String(r1.contactCount));
check("slack received one message", sent.length === 1, String(sent.length));
check("slack text names the count", /1 contact to follow up/.test(sent[0]?.text || ""), sent[0]?.text);
const flat = JSON.stringify(sent[0]?.blocks || []);
check("digest lists the due contact", flat.includes("Overdue Olga"), flat.slice(0, 300));
check("digest excludes the not-due contact", !flat.includes("Future Fred"));
check("digest marks it overdue", flat.includes("overdue"));

// --- the once-per-week guarantee ---
// KNOWN pg-mem GAP: pg-mem reports a row from `ON CONFLICT DO NOTHING
// RETURNING` even when it skipped the insert, so the suppression branch itself
// cannot be exercised here (real Postgres returns zero rows). What pg-mem DOES
// enforce is the digest_runs primary key, which is the thing the guarantee
// rests on -- so assert that a second attempt cannot create a second week row.
const r2 = await runWeeklyDigest();
const weekRows = await db.pool.query(`SELECT week_of FROM digest_runs`);
check("only one digest_runs row exists for the week", weekRows.rows.length === 1, JSON.stringify(weekRows.rows));
console.log(`NOTE second-run suppression not verifiable under pg-mem (got sent=${r2.sent}); verify on real Postgres`);

const r3 = await runWeeklyDigest({ force: true });
check("force path sends", r3.sent === true, JSON.stringify(r3));

// --- last_reminded_at was stamped ---
all = await db.listContacts(true);
const olga = all.find((c) => c.name === "Overdue Olga")!;
check("last_reminded_at stamped on the due contact", olga.last_reminded_at !== null);

// --- mark contacted pushes the reminder out 3 months ---
const mc = await realFetch(`${base}/contacts/${due1.id}/contacted`, {
  method: "POST", redirect: "manual", headers: { Authorization: auth },
});
check("POST contacted redirects", mc.status === 302, `got ${mc.status}`);
all = await db.listContacts(true);
const olga2 = all.find((c) => c.id === due1.id)!;
check("contacted sets last_contacted_at to today", olga2.last_contacted_at === today, String(olga2.last_contacted_at));
check("contacted pushes remind_at +3 months", olga2.remind_at === addMonths(today, 3), String(olga2.remind_at));
check("contact is no longer due", (await db.dueContacts(today)).length === 0);

// --- snooze ---
await db.snooze(due1.id, "2026-01-05");
check("snoozed contact is due again", (await db.dueContacts(today)).length === 1);

// --- archive removes from the digest ---
await db.setArchived(due1.id, true);
check("archived contact is not due", (await db.dueContacts(today)).length === 0);
check("archived hidden by default", (await db.listContacts(false)).every((c) => c.id !== due1.id));
check("archived visible when asked", (await db.listContacts(true)).some((c) => c.id === due1.id));

// --- empty week stays quiet ---
const r4 = await runWeeklyDigest({ force: true });
check("no digest when nobody is due", r4.sent === false && r4.reason === "nobody-due", JSON.stringify(r4));

// --- validation ---
const bad = await realFetch(`${base}/contacts`, {
  method: "POST", redirect: "manual",
  headers: { Authorization: auth, "Content-Type": "application/json" },
  body: JSON.stringify({ name: "   " }),
});
check("blank name rejected", bad.status === 400, `got ${bad.status}`);

// --- HTML escaping ---
await db.addContact({ name: `<script>alert(1)</script>`, remindAt: "2099-01-01" });
const page = await realFetch(`${base}/`, { headers: { Authorization: auth } });
const html = await page.text();
check("page renders 200", page.status === 200);
check("script tag is escaped", !html.includes("<script>alert(1)"), "raw script tag leaked into HTML");
check("escaped form present", html.includes("&lt;script&gt;"));

server.close();
await db.pool.end();
console.log(fails ? `\n${fails} FAILURE(S)` : "\nall green");
process.exit(fails ? 1 : 0);
