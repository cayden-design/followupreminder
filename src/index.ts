import cron from "node-cron";
import { config } from "./config.js";
import { initSchema, pool } from "./db.js";
import { todayInTz } from "./dates.js";
import { runWeeklyDigest } from "./reminders.js";
import { createServer } from "./server.js";
import { slackConfigured } from "./slack.js";

const catchUpOnBoot = !["0", "false", "no", "off"].includes((process.env.CATCH_UP_ON_BOOT || "").toLowerCase());

function log(...args: unknown[]): void {
  console.log("[followupreminder]", ...args);
}

async function runDigestSafely(trigger: string): Promise<void> {
  try {
    const result = await runWeeklyDigest();
    if (result.sent) {
      log(`${trigger}: digest sent for week of ${result.weekOf} (${result.contactCount} contacts)`);
    } else {
      log(`${trigger}: no digest for week of ${result.weekOf} (${result.reason})`);
    }
  } catch (err) {
    console.error(`[followupreminder] ${trigger}: digest failed`, err);
  }
}

async function main(): Promise<void> {
  await initSchema();
  log("schema ready");

  if (!slackConfigured()) {
    log("WARNING: no SLACK_WEBHOOK_URL or SLACK_BOT_TOKEN set — digests will fail until one is.");
  }
  if (!config.appPassword) {
    log("WARNING: APP_PASSWORD is not set — the web form will refuse to serve until it is.");
  }

  if (config.enableWeeklyDigest) {
    if (!cron.validate(config.cronWeeklyDigest)) {
      throw new Error(`CRON_WEEKLY_DIGEST is not a valid cron expression: ${config.cronWeeklyDigest}`);
    }
    cron.schedule(config.cronWeeklyDigest, () => void runDigestSafely("cron"), { timezone: config.timezone });
    log(`weekly digest scheduled: "${config.cronWeeklyDigest}" ${config.timezone}`);

    if (catchUpOnBoot) {
      // A deploy or crash that spans Monday morning would otherwise skip the
      // week entirely. The digest_runs claim makes this a no-op if it already
      // went out, so booting mid-week never double-notifies.
      void runDigestSafely("boot catch-up");
    }
  } else {
    log("weekly digest DISABLED (ENABLE_WEEKLY_DIGEST=false)");
  }

  const app = createServer();
  const server = app.listen(config.port, () => {
    log(`listening on :${config.port} — today is ${todayInTz(config.timezone)} (${config.timezone})`);
  });

  const shutdown = (signal: string) => {
    log(`${signal} received, shutting down`);
    server.close(() => void pool.end().then(() => process.exit(0)));
    setTimeout(() => process.exit(0), 10_000).unref();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main().catch((err) => {
  console.error("[followupreminder] fatal startup error", err);
  process.exit(1);
});
