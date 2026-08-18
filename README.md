# followupreminder

Manually log a contact, and get one Slack message every Monday listing everyone
due for a follow-up. Default cadence is three months.

- **Intake** — password-protected web form on the Railway URL.
- **Storage** — Railway Postgres.
- **Reminder** — one Slack digest, Mondays 9:00 AM `America/New_York`, covering
  every contact due that week. Never more than one message per week.

## How the reminder works

Each contact carries a `remind_at` calendar date. Adding someone today sets it
to today + 3 months. Every Monday the digest collects everyone with
`remind_at <= today` who isn't archived, and posts a single Slack message.

Contacts stay in the digest until you act on them — a contact you ignore shows
up again next Monday flagged *overdue*, rather than silently rolling forward
three months. Acting on one means:

| Action | Effect |
| --- | --- |
| **Contacted** | Records today as the last touch, sets the next reminder to today + 3 months |
| **+1wk** | Pushes the reminder out 7 days |
| **Archive** | Drops them from all future digests (restorable) |

### Only one message per week

A `digest_runs` table has one row per week, keyed by that week's Monday. The
digest claims the week before sending, so a redeploy, a restart, a crash-loop,
or a second replica cannot produce a second message. If the send fails, the
claim is released so the next attempt can still notify.

`CATCH_UP_ON_BOOT` (default on) runs the digest at startup, so a deploy or
outage spanning Monday morning still gets that week's message rather than
skipping it. The weekly claim makes it a no-op if the digest already went out.

Quiet weeks are silent by default — set `NOTIFY_WHEN_EMPTY=true` if you'd
rather get a "nothing due" message as a heartbeat.

## Deploying to Railway

1. Create the service from this repo, and attach the **Postgres** plugin.
   Railway injects `DATABASE_URL` automatically; the schema is created on boot.
2. Set variables (see `.env.example`):
   - `APP_PASSWORD` — the web form refuses to serve without it
   - `SLACK_WEBHOOK_URL` — or `SLACK_BOT_TOKEN` + `SLACK_CHANNEL_ID`
3. Generate a public domain for the service. The Slack digest links back to it
   via `RAILWAY_PUBLIC_DOMAIN`.

Health check is `GET /health` (unauthenticated).

## Endpoints

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/health` | Public. Reports timezone and whether Slack is configured. |
| `GET` | `/` | The form and contact list. |
| `POST` | `/contacts` | Add a contact. Accepts form-encoded or JSON. |
| `POST` | `/contacts/:id/contacted` | Mark contacted, reschedule +3 months. |
| `POST` | `/contacts/:id/snooze` | Body `days` (default 7). |
| `POST` | `/contacts/:id/archive` · `/unarchive` | |
| `POST` | `/digest/run` | Body `force=1` to bypass the weekly claim. |

Everything except `/health` is HTTP basic auth — any username, `APP_PASSWORD`
as the password.

Adding a contact by API:

```bash
curl -u x:$APP_PASSWORD -H 'Content-Type: application/json' \
  -d '{"name":"Dana Reed","email":"dana@acme.com","company":"Acme","notes":"Talked pricing"}' \
  https://YOUR-APP.up.railway.app/contacts
```

## Local development

```bash
npm install && npm test
```

`npm test` runs the suite against an in-memory Postgres — no database needed.

To run the app locally you need a real `DATABASE_URL`; set
`ENABLE_WEEKLY_DIGEST=false` so a local run can't post to Slack alongside the
deployed instance, then `npm run dev`.

`npm run digest:now -- --force` sends a digest immediately.

## Notes on correctness

- **Dates are calendar dates, not timestamps.** Reminders are stored as `DATE`
  and read back with `to_char(... ,'YYYY-MM-DD')`. node-pg otherwise hydrates a
  `DATE` into a JS `Date` at local midnight, which reads back one day early in
  any timezone west of UTC — a reminder saved as Nov 18 became Nov 17.
- **Month arithmetic clamps rather than overflowing.** Aug 31 + 3 months is
  Nov 30, and Nov 30 + 3 months is Feb 28 (or Feb 29 in a leap year).
  `Date.setMonth` would have rolled those into the following month.
- **One known test gap:** pg-mem reports a row from `ON CONFLICT DO NOTHING
  RETURNING` even when it skips the insert, so the local suite can't exercise
  the "already sent this week" branch — it asserts the `digest_runs` primary
  key holds instead. Worth confirming once against real Postgres by hitting
  `POST /digest/run` twice without `force`.
