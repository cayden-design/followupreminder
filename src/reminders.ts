import { config, publicBaseUrl } from "./config.js";
import { claimWeek, dueContacts, finishWeek, markReminded, releaseWeek, type Contact } from "./db.js";
import { formatHuman, mondayOf, todayInTz } from "./dates.js";
import { sendSlack } from "./slack.js";

const notifyWhenEmpty = ["1", "true", "yes", "on"].includes((process.env.NOTIFY_WHEN_EMPTY || "").toLowerCase());

export interface DigestResult {
  weekOf: string;
  sent: boolean;
  reason?: "already-sent-this-week" | "nobody-due";
  contactCount: number;
}

function describe(c: Contact, today: string): string {
  const who = c.company ? `*${c.name}* (${c.company})` : `*${c.name}*`;
  const bits: string[] = [];
  if (c.email) bits.push(c.email);
  bits.push(c.remind_at < today ? `due ${formatHuman(c.remind_at)} — overdue` : `due ${formatHuman(c.remind_at)}`);
  if (c.last_contacted_at) bits.push(`last touch ${formatHuman(c.last_contacted_at)}`);
  const line = `• ${who} — ${bits.join(" · ")}`;
  return c.notes ? `${line}\n   _${c.notes.replace(/\n+/g, " ")}_` : line;
}

/**
 * `force` bypasses the once-per-week lock for manual triggers. The scheduled
 * run never passes it, so the cron firing twice is harmless.
 */
export async function runWeeklyDigest(options: { force?: boolean } = {}): Promise<DigestResult> {
  const today = todayInTz(config.timezone);
  const weekOf = mondayOf(today);

  if (!options.force) {
    const claimed = await claimWeek(weekOf);
    if (!claimed) {
      return { weekOf, sent: false, reason: "already-sent-this-week", contactCount: 0 };
    }
  }

  try {
    const due = await dueContacts(today);

    if (!due.length && !notifyWhenEmpty) {
      await finishWeek(weekOf, 0);
      return { weekOf, sent: false, reason: "nobody-due", contactCount: 0 };
    }

    const heading = due.length
      ? `:calendar: ${due.length} contact${due.length === 1 ? "" : "s"} to follow up with this week`
      : ":calendar: No follow-ups due this week";

    const blocks: unknown[] = [
      { type: "section", text: { type: "mrkdwn", text: `*${heading}*\n_Week of ${formatHuman(weekOf)}_` } },
    ];
    // Slack caps a section at 3000 chars, so pack the list into chunks rather
    // than one block per contact (max 50 blocks per message).
    for (const chunk of chunkLines(due.map((c) => describe(c, today)), 2800)) {
      blocks.push({ type: "section", text: { type: "mrkdwn", text: chunk } });
    }
    if (publicBaseUrl) {
      blocks.push({
        type: "context",
        elements: [{ type: "mrkdwn", text: `<${publicBaseUrl}|Open the follow-up list> to mark contacted or snooze.` }],
      });
    }

    await sendSlack(heading, blocks);
    await markReminded(today);
    await finishWeek(weekOf, due.length);

    return { weekOf, sent: true, contactCount: due.length };
  } catch (err) {
    // Give the week back so the next attempt (or a retry) can still notify.
    if (!options.force) await releaseWeek(weekOf).catch(() => {});
    throw err;
  }
}

function chunkLines(lines: string[], limit: number): string[] {
  const out: string[] = [];
  let current = "";
  for (const line of lines) {
    if (current && current.length + line.length + 1 > limit) {
      out.push(current);
      current = "";
    }
    current = current ? `${current}\n${line}` : line;
  }
  if (current) out.push(current);
  return out;
}
