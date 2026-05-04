type EventSnapshot = {
  artist?: string;
  title?: string;
  city?: string;
  venue?: string;
  date?: string;
  time?: string;
  saleWindow?: string;
  link?: string;
};

type DueAlert = {
  id: string;
  event_key: string;
  event_snapshot: EventSnapshot;
  remind_at: string;
};

type DueAlertResponse = {
  configured?: boolean;
  alerts?: DueAlert[];
  error?: string;
};

const appBaseUrl = (process.env.APP_BASE_URL ?? "https://japan-live-radar.vercel.app").replace(/\/$/, "");
const adminApiToken = process.env.ADMIN_API_TOKEN;
const alertWebhookUrl = process.env.ALERT_WEBHOOK_URL;

function requireEnv(name: string, value: string | undefined): string {
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function eventLabel(event: EventSnapshot) {
  return [event.artist, event.title].filter(Boolean).join(" - ") || "일본 콘서트";
}

function buildMessage(alert: DueAlert) {
  const event = alert.event_snapshot ?? {};
  const lines = [
    `알림 시간: ${alert.remind_at}`,
    `공연: ${eventLabel(event)}`,
    event.city || event.venue ? `장소: ${[event.city, event.venue].filter(Boolean).join(" / ")}` : null,
    event.date ? `공연일: ${[event.date, event.time].filter(Boolean).join(" ")}` : null,
    event.saleWindow ? `판매 일정: ${event.saleWindow}` : null,
    event.link ? `티켓 링크: ${event.link}` : null,
  ].filter(Boolean);

  return lines.join("\n");
}

async function requestJson<T>(url: string, init: RequestInit) {
  const response = await fetch(url, init);
  const text = await response.text();
  const body = text ? (JSON.parse(text) as T) : ({} as T);

  if (!response.ok) {
    const message = body && typeof body === "object" && "error" in body ? String(body.error) : response.statusText;
    throw new Error(`${response.status} ${message}`);
  }

  return body;
}

async function patchAlert(id: string, status: "sent" | "error", error?: string) {
  return requestJson(`${appBaseUrl}/api/admin-alerts`, {
    method: "PATCH",
    headers: {
      "content-type": "application/json",
      "x-admin-token": requireEnv("ADMIN_API_TOKEN", adminApiToken),
    },
    body: JSON.stringify({ id, status, error }),
  });
}

async function sendWebhook(alert: DueAlert) {
  if (!alertWebhookUrl) {
    throw new Error("ALERT_WEBHOOK_URL is not configured");
  }

  const response = await fetch(alertWebhookUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      text: buildMessage(alert),
      alertId: alert.id,
      eventKey: alert.event_key,
      event: alert.event_snapshot,
      remindAt: alert.remind_at,
    }),
  });

  if (!response.ok) {
    throw new Error(`Webhook failed with ${response.status}`);
  }
}

async function main() {
  const token = requireEnv("ADMIN_API_TOKEN", adminApiToken);
  const queue = await requestJson<DueAlertResponse>(`${appBaseUrl}/api/admin-alerts`, {
    headers: {
      "x-admin-token": token,
    },
  });

  if (queue.configured === false) {
    throw new Error("Admin alert API is not configured");
  }

  const alerts = queue.alerts ?? [];
  if (alerts.length === 0) {
    console.log("No due alerts.");
    return;
  }

  console.log(`Dispatching ${alerts.length} due alert(s).`);
  for (const alert of alerts) {
    try {
      await sendWebhook(alert);
      await patchAlert(alert.id, "sent");
      console.log(`Sent alert ${alert.id}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown delivery error";
      await patchAlert(alert.id, "error", message);
      console.error(`Marked alert ${alert.id} as error: ${message}`);
    }
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});

export {};
