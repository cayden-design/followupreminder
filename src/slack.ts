import { config } from "./config.js";

export function slackConfigured(): boolean {
  return Boolean(config.slackBotToken || config.slackWebhookUrl);
}

export async function sendSlack(text: string, blocks?: unknown[]): Promise<void> {
  if (config.slackBotToken) {
    const channel = config.slackChannelId || config.slackChannel;
    if (!channel) {
      throw new Error("SLACK_CHANNEL_ID (or SLACK_CHANNEL) is required with SLACK_BOT_TOKEN");
    }
    const res = await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        Authorization: `Bearer ${config.slackBotToken}`,
      },
      body: JSON.stringify({ channel, text, blocks, unfurl_links: false }),
    });
    const body = (await res.json()) as { ok?: boolean; error?: string };
    if (!res.ok || !body.ok) {
      throw new Error(`Slack chat.postMessage failed: ${body.error ?? res.status}`);
    }
    return;
  }

  if (config.slackWebhookUrl) {
    const payload: Record<string, unknown> = {
      text,
      username: "Follow-Up Reminder",
      icon_emoji: ":calendar:",
    };
    if (blocks?.length) payload.blocks = blocks;
    const res = await fetch(config.slackWebhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      throw new Error(`Slack webhook failed (${res.status}): ${await res.text()}`);
    }
    return;
  }

  throw new Error("Slack is not configured. Set SLACK_WEBHOOK_URL or SLACK_BOT_TOKEN (+ SLACK_CHANNEL_ID).");
}
