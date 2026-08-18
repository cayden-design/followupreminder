import { z } from "zod";

const ConfigSchema = z.object({
  port: z.coerce.number().int().positive().default(3000),
  databaseUrl: z.string().min(1, "DATABASE_URL is required (add the Railway Postgres plugin)"),

  slackWebhookUrl: z.string().default(""),
  slackBotToken: z.string().default(""),
  slackChannelId: z.string().default(""),
  slackChannel: z.string().default("#followups"),

  /** Basic-auth password for the web form. Username is anything. */
  appPassword: z.string().default(""),

  /** Default follow-up interval. Three months per the original ask. */
  followUpMonths: z.coerce.number().int().positive().default(3),

  /** Mondays 9am. Interpreted in `timezone`, not UTC. */
  cronWeeklyDigest: z.string().default("0 9 * * 1"),
  timezone: z.string().default("America/New_York"),

  /**
   * Off only for local poking. When false the process still serves the web
   * form but never sends a digest, so a laptop run can't double-notify
   * alongside the deployed instance.
   */
  enableWeeklyDigest: z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === "" ? true : ["1", "true", "yes", "on"].includes(v.toLowerCase()))),
});

export type Config = z.infer<typeof ConfigSchema>;

export const config: Config = ConfigSchema.parse({
  port: process.env.PORT,
  databaseUrl: process.env.DATABASE_URL,
  slackWebhookUrl: process.env.SLACK_WEBHOOK_URL,
  slackBotToken: process.env.SLACK_BOT_TOKEN,
  slackChannelId: process.env.SLACK_CHANNEL_ID,
  slackChannel: process.env.SLACK_CHANNEL,
  appPassword: process.env.APP_PASSWORD,
  followUpMonths: process.env.FOLLOW_UP_MONTHS,
  cronWeeklyDigest: process.env.CRON_WEEKLY_DIGEST,
  timezone: process.env.TIMEZONE,
  enableWeeklyDigest: process.env.ENABLE_WEEKLY_DIGEST,
});

export const publicBaseUrl =
  process.env.PUBLIC_BASE_URL ||
  (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : "");
