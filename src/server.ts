import crypto from "node:crypto";
import express, { type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import { config } from "./config.js";
import { addContact, listContacts, markContacted, setArchived, snooze, type Contact } from "./db.js";
import { addDays, addMonths, formatHuman, isValidIsoDate, todayInTz } from "./dates.js";
import { runWeeklyDigest } from "./reminders.js";
import { slackConfigured } from "./slack.js";

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (!config.appPassword) {
    res.status(500).send("APP_PASSWORD is not set. Refusing to serve the contact list unauthenticated.");
    return;
  }
  const header = req.headers.authorization || "";
  if (header.startsWith("Basic ")) {
    const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
    const password = decoded.slice(decoded.indexOf(":") + 1);
    if (safeEqual(password, config.appPassword)) {
      next();
      return;
    }
  }
  res.set("WWW-Authenticate", 'Basic realm="Follow-Up Reminder"').status(401).send("Authentication required.");
}

const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

const esc = (v: unknown): string => String(v ?? "").replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);

const ContactInput = z.object({
  name: z.string().trim().min(1, "Name is required").max(200),
  email: z.string().trim().max(320).optional().default(""),
  company: z.string().trim().max(200).optional().default(""),
  notes: z.string().trim().max(2000).optional().default(""),
  remind_at: z.string().trim().optional().default(""),
});

function renderRow(c: Contact, today: string): string {
  const overdue = !c.archived && c.remind_at <= today;
  const rowClass = c.archived ? "archived" : overdue ? "due" : "";
  const sub = c.company ? `<div class="sub">${esc(c.company)}</div>` : "";
  const notes = c.notes ? `<div class="notes">${esc(c.notes)}</div>` : "";
  const email = c.email ? `<a href="mailto:${esc(c.email)}">${esc(c.email)}</a>` : `<span class="sub">&mdash;</span>`;
  const lastTouch = c.last_contacted_at ? esc(formatHuman(c.last_contacted_at)) : `<span class="sub">never</span>`;
  const archiveAction = c.archived ? "unarchive" : "archive";
  const archiveLabel = c.archived ? "Restore" : "Archive";

  return `<tr class="${rowClass}">
  <td><div class="name">${esc(c.name)}</div>${sub}${notes}</td>
  <td>${email}</td>
  <td>${esc(formatHuman(c.remind_at))}${overdue ? ' <span class="tag">due</span>' : ""}</td>
  <td>${lastTouch}</td>
  <td class="actions">
    <form method="post" action="/contacts/${c.id}/contacted"><button title="Reached out today; next reminder in ${config.followUpMonths} months">Contacted</button></form>
    <form method="post" action="/contacts/${c.id}/snooze"><input type="hidden" name="days" value="7"><button>+1wk</button></form>
    <form method="post" action="/contacts/${c.id}/${archiveAction}"><button>${archiveLabel}</button></form>
  </td>
</tr>`;
}

function render(contacts: Contact[], today: string, flash: string, showArchived: boolean): string {
  const defaultRemind = addMonths(today, config.followUpMonths);
  const rows = contacts.length
    ? contacts.map((c) => renderRow(c, today)).join("\n")
    : `<tr><td colspan="5" class="sub">No contacts yet.</td></tr>`;
  const hour = config.cronWeeklyDigest.split(" ")[1] ?? "9";
  const slackNote = slackConfigured() ? "" : " &middot; <strong>Slack not configured</strong>";

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Follow-Up Reminder</title>
<style>
  :root { color-scheme: light dark; --bg:#fff; --fg:#16181d; --sub:#6b7280; --line:#e5e7eb; --accent:#b45309; --accentbg:#fef3c7; }
  @media (prefers-color-scheme: dark) { :root { --bg:#15171c; --fg:#e8eaed; --sub:#9aa0a6; --line:#2c2f36; --accent:#fbbf24; --accentbg:#3b2f14; } }
  * { box-sizing: border-box; }
  body { margin:0; padding:24px; background:var(--bg); color:var(--fg); font:15px/1.5 system-ui,-apple-system,Segoe UI,sans-serif; }
  .wrap { max-width:1000px; margin:0 auto; }
  h1 { font-size:20px; margin:0 0 4px; }
  .sub { color:var(--sub); font-size:13px; }
  .flash { background:var(--accentbg); color:var(--accent); padding:8px 12px; border-radius:6px; margin:16px 0; font-size:14px; }
  form.add { display:grid; grid-template-columns:repeat(auto-fit,minmax(180px,1fr)); gap:10px; margin:20px 0; padding:16px; border:1px solid var(--line); border-radius:8px; }
  form.add label { display:flex; flex-direction:column; gap:4px; font-size:12px; color:var(--sub); }
  input, textarea { padding:8px; border:1px solid var(--line); border-radius:6px; background:var(--bg); color:var(--fg); font:inherit; width:100%; }
  textarea { min-height:38px; resize:vertical; }
  button { padding:7px 12px; border:1px solid var(--line); border-radius:6px; background:var(--bg); color:var(--fg); font:inherit; cursor:pointer; }
  button:hover { border-color:var(--sub); }
  form.add .submit { grid-column:1/-1; }
  form.add .submit button { background:var(--fg); color:var(--bg); border-color:var(--fg); }
  .tablewrap { overflow-x:auto; }
  table { border-collapse:collapse; width:100%; min-width:720px; }
  th, td { text-align:left; padding:10px 8px; border-bottom:1px solid var(--line); vertical-align:top; }
  th { font-size:12px; text-transform:uppercase; letter-spacing:.04em; color:var(--sub); }
  .name { font-weight:600; }
  .notes { color:var(--sub); font-size:13px; margin-top:2px; }
  tr.due .name { color:var(--accent); }
  tr.archived { opacity:.5; }
  .tag { background:var(--accentbg); color:var(--accent); font-size:11px; padding:1px 6px; border-radius:10px; }
  td.actions { display:flex; gap:6px; flex-wrap:wrap; }
  td.actions form { margin:0; }
  .footer { margin-top:20px; display:flex; gap:12px; align-items:center; flex-wrap:wrap; }
  a { color:inherit; }
</style></head>
<body><div class="wrap">
<h1>Follow-Up Reminder</h1>
<div class="sub">Digest posts to Slack Mondays at ${esc(hour)}:00 ${esc(config.timezone)} &middot; today is ${esc(formatHuman(today))}${slackNote}</div>
${flash ? `<div class="flash">${esc(flash)}</div>` : ""}

<form class="add" method="post" action="/contacts">
  <label>Name *<input name="name" required autocomplete="off"></label>
  <label>Email<input name="email" type="email" autocomplete="off"></label>
  <label>Company<input name="company" autocomplete="off"></label>
  <label>Remind on<input name="remind_at" type="date" value="${esc(defaultRemind)}"></label>
  <label style="grid-column:1/-1">Notes<textarea name="notes" placeholder="What you talked about, what to pick up next time"></textarea></label>
  <div class="submit"><button type="submit">Add contact</button></div>
</form>

<div class="tablewrap"><table>
<thead><tr><th>Contact</th><th>Email</th><th>Next reminder</th><th>Last contacted</th><th>Actions</th></tr></thead>
<tbody>
${rows}
</tbody></table></div>

<div class="footer">
  <a href="/${showArchived ? "" : "?archived=1"}">${showArchived ? "Hide archived" : "Show archived"}</a>
  <form method="post" action="/digest/run"><input type="hidden" name="force" value="1"><button>Send digest now</button></form>
</div>
</div></body></html>`;
}

export function createServer() {
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  app.use(express.json());

  app.get("/health", (_req, res) => {
    res.json({ ok: true, timezone: config.timezone, slack: slackConfigured() });
  });

  app.use(requireAuth);

  app.get("/", async (req, res, next) => {
    try {
      const showArchived = req.query.archived === "1";
      const contacts = await listContacts(showArchived);
      const flash = typeof req.query.msg === "string" ? req.query.msg : "";
      res.type("html").send(render(contacts, todayInTz(config.timezone), flash, showArchived));
    } catch (err) {
      next(err);
    }
  });

  app.post("/contacts", async (req, res, next) => {
    try {
      const parsed = ContactInput.safeParse(req.body ?? {});
      if (!parsed.success) {
        const message = parsed.error.issues[0].message;
        if (req.is("application/json")) {
          res.status(400).json({ error: message });
          return;
        }
        res.redirect(`/?msg=${encodeURIComponent(message)}`);
        return;
      }
      const today = todayInTz(config.timezone);
      const input = parsed.data;
      const remindAt = isValidIsoDate(input.remind_at)
        ? input.remind_at
        : addMonths(today, config.followUpMonths);

      const contact = await addContact({
        name: input.name,
        email: input.email,
        company: input.company,
        notes: input.notes,
        remindAt,
      });

      if (req.is("application/json")) {
        res.status(201).json(contact);
        return;
      }
      res.redirect(`/?msg=${encodeURIComponent(`Added ${contact.name} - reminder set for ${formatHuman(remindAt)}`)}`);
    } catch (err) {
      next(err);
    }
  });

  const contactId = (req: Request): number | null => {
    const id = Number(req.params.id);
    return Number.isInteger(id) && id > 0 ? id : null;
  };

  app.post("/contacts/:id/contacted", async (req, res, next) => {
    try {
      const id = contactId(req);
      if (!id) {
        res.status(400).send("Bad id");
        return;
      }
      const today = todayInTz(config.timezone);
      await markContacted(id, today, addMonths(today, config.followUpMonths));
      res.redirect(`/?msg=${encodeURIComponent(`Marked contacted - next reminder in ${config.followUpMonths} months`)}`);
    } catch (err) {
      next(err);
    }
  });

  app.post("/contacts/:id/snooze", async (req, res, next) => {
    try {
      const id = contactId(req);
      if (!id) {
        res.status(400).send("Bad id");
        return;
      }
      const days = Number(req.body?.days) || 7;
      const today = todayInTz(config.timezone);
      await snooze(id, addDays(today, days));
      res.redirect(`/?msg=${encodeURIComponent(`Snoozed ${days} days`)}`);
    } catch (err) {
      next(err);
    }
  });

  const archiveRoutes: Array<[string, boolean]> = [
    ["archive", true],
    ["unarchive", false],
  ];
  for (const [path, archived] of archiveRoutes) {
    app.post(`/contacts/:id/${path}`, async (req, res, next) => {
      try {
        const id = contactId(req);
        if (!id) {
          res.status(400).send("Bad id");
          return;
        }
        await setArchived(id, archived);
        res.redirect(`/?msg=${encodeURIComponent(archived ? "Archived" : "Restored")}`);
      } catch (err) {
        next(err);
      }
    });
  }

  app.post("/digest/run", async (req, res, next) => {
    try {
      const force = req.body?.force === "1" || req.body?.force === true;
      const result = await runWeeklyDigest({ force });
      if (req.is("application/json")) {
        res.json(result);
        return;
      }
      const msg = result.sent
        ? `Digest sent - ${result.contactCount} contact(s)`
        : result.reason === "nobody-due"
          ? "Nobody is due; no digest sent"
          : "Digest already went out this week";
      res.redirect(`/?msg=${encodeURIComponent(msg)}`);
    } catch (err) {
      next(err);
    }
  });

  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    console.error("[followupreminder] request failed:", err);
    res.status(500).send(`Something broke: ${esc(err.message)}`);
  });

  return app;
}
