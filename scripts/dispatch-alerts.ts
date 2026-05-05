import { pathToFileURL } from "node:url";
import { createHmac } from "node:crypto";

type EventSnapshot = {
  id?: string;
  artist?: string;
  title?: string;
  city?: string;
  venue?: string;
  date?: string;
  time?: string;
  source?: string;
  ticketAccess?: string;
  saleType?: string;
  saleWindow?: string;
  price?: string;
  phoneRequired?: boolean;
  foreignerNote?: string;
  link?: string;
};

type DueAlert = {
  id: string;
  event_key: string;
  event_snapshot: EventSnapshot;
  channel?: "browser" | "email" | string | null;
  contact_email?: string | null;
  remind_at: string;
  remind_before_hours?: number | null;
};

type DueAlertResponse = {
  configured?: boolean;
  alerts?: DueAlert[];
  error?: string;
};

const appBaseUrl = (process.env.APP_BASE_URL ?? "https://japan-live-radar.vercel.app").replace(/\/$/, "");
const adminApiToken = process.env.ADMIN_API_TOKEN;
const alertWebhookUrl = process.env.ALERT_WEBHOOK_URL;
const alertWebhookSecret = process.env.ALERT_WEBHOOK_SECRET;
const defaultWebhookAttempts = normalizeWebhookAttempts(process.env.ALERT_WEBHOOK_ATTEMPTS);
const defaultWebhookTimeoutMs = normalizeWebhookTimeoutMs(process.env.ALERT_WEBHOOK_TIMEOUT_MS);

type WebhookFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

type WebhookSendOptions = {
  webhookUrl?: string;
  fetchImpl?: WebhookFetch;
  attempts?: number;
  retryDelayMs?: number;
  timeoutMs?: number;
  signatureSecret?: string;
  signatureTimestamp?: string;
};

function requireEnv(name: string, value: string | undefined): string {
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

export function normalizeWebhookAttempts(value: string | undefined) {
  const parsed = value ? Number(value) : Number.NaN;
  if (!Number.isFinite(parsed)) return 3;
  return Math.min(Math.max(Math.trunc(parsed), 1), 5);
}

export function normalizeWebhookTimeoutMs(value: string | undefined) {
  const parsed = value ? Number(value) : Number.NaN;
  if (!Number.isFinite(parsed)) return 10_000;
  return Math.min(Math.max(Math.trunc(parsed), 1_000), 30_000);
}

export function shouldRetryWebhookStatus(status: number) {
  return status === 408 || status === 429 || status >= 500;
}

function sleep(ms: number) {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
}

function eventLabel(event: EventSnapshot) {
  return [event.artist, event.title].filter(Boolean).join(" - ") || "일본 콘서트";
}

export function buildAlertSubject(alert: DueAlert) {
  const event = alert.event_snapshot ?? {};
  return `[Japan Live Radar] ${eventLabel(event)} 예매 알림`;
}

export function buildAppEventUrl(alert: DueAlert, baseUrl = appBaseUrl) {
  const eventId = alert.event_snapshot?.id;
  if (!eventId) return baseUrl;
  return `${baseUrl}/?event=${encodeURIComponent(eventId)}`;
}

export function buildAlertDeliveryKey(alert: DueAlert) {
  return [alert.id, alert.event_key, alert.remind_at].join(":");
}

export function buildAlertMessage(alert: DueAlert) {
  const event = alert.event_snapshot ?? {};
  const appEventUrl = buildAppEventUrl(alert);
  const lines = [
    `알림 시간: ${alert.remind_at}`,
    alert.remind_before_hours ? `알림 기준: 예매 시작 ${alert.remind_before_hours}시간 전` : null,
    alert.contact_email ? `수신처: ${alert.contact_email}` : null,
    `공연: ${eventLabel(event)}`,
    event.city || event.venue ? `장소: ${[event.city, event.venue].filter(Boolean).join(" / ")}` : null,
    event.date ? `공연일: ${[event.date, event.time].filter(Boolean).join(" ")}` : null,
    event.ticketAccess ? `구매 조건: ${event.ticketAccess}${event.phoneRequired ? " / 일본 번호 확인 필요" : ""}` : null,
    event.saleType || event.price ? `티켓: ${[event.saleType, event.price].filter(Boolean).join(" / ")}` : null,
    event.saleWindow ? `판매 일정: ${event.saleWindow}` : null,
    event.foreignerNote ? `확인 메모: ${event.foreignerNote}` : null,
    `앱에서 보기: ${appEventUrl}`,
    event.link ? `티켓 링크: ${event.link}` : null,
  ].filter(Boolean);

  return lines.join("\n");
}

export function buildAlertWebhookPayload(alert: DueAlert) {
  const appEventUrl = buildAppEventUrl(alert);
  return {
    subject: buildAlertSubject(alert),
    text: buildAlertMessage(alert),
    deliveryKey: buildAlertDeliveryKey(alert),
    alertId: alert.id,
    eventKey: alert.event_key,
    channel: alert.channel ?? null,
    contactEmail: alert.contact_email ?? null,
    appUrl: appEventUrl,
    eventUrl: appEventUrl,
    ticketUrl: alert.event_snapshot?.link ?? null,
    event: alert.event_snapshot,
    source: alert.event_snapshot?.source ?? null,
    ticketAccess: alert.event_snapshot?.ticketAccess ?? null,
    saleType: alert.event_snapshot?.saleType ?? null,
    phoneRequired: alert.event_snapshot?.phoneRequired ?? null,
    remindAt: alert.remind_at,
    remindBeforeHours: alert.remind_before_hours ?? null,
  };
}

export function buildAlertWebhookSignature(body: string, secret: string, timestamp: string) {
  return `sha256=${createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex")}`;
}

function signedWebhookHeaders(body: string, secret: string | undefined, timestamp: string): Record<string, string> {
  if (!secret) return {};
  return {
    "x-japan-live-radar-signature": buildAlertWebhookSignature(body, secret, timestamp),
    "x-japan-live-radar-signature-timestamp": timestamp,
  };
}

export function summarizeDispatchFailures(failures: string[]) {
  if (failures.length === 0) return null;
  const sample = failures.slice(0, 3).join("; ");
  const suffix = failures.length > 3 ? `; +${failures.length - 3} more` : "";
  return `Failed to dispatch ${failures.length} alert(s): ${sample}${suffix}`;
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

export async function sendWebhook(alert: DueAlert, options: WebhookSendOptions = {}) {
  const webhookUrl = options.webhookUrl ?? alertWebhookUrl;
  if (!webhookUrl) {
    throw new Error("ALERT_WEBHOOK_URL is not configured");
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  const attempts = options.attempts ?? defaultWebhookAttempts;
  const retryDelayMs = options.retryDelayMs ?? 1_000;
  const timeoutMs = options.timeoutMs ?? defaultWebhookTimeoutMs;
  const signatureSecret = options.signatureSecret ?? alertWebhookSecret;
  let lastStatus = 0;
  let lastError: string | null = null;
  let completedAttempts = 0;
  const deliveryKey = buildAlertDeliveryKey(alert);
  const body = JSON.stringify(buildAlertWebhookPayload(alert));
  const signatureTimestamp = options.signatureTimestamp ?? new Date().toISOString();

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    completedAttempts = attempt;
    let response: Response;
    try {
      response = await fetchImpl(webhookUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-japan-live-radar-alert-id": alert.id,
          "x-japan-live-radar-delivery-key": deliveryKey,
          "x-japan-live-radar-event-key": alert.event_key,
          ...signedWebhookHeaders(body, signatureSecret, signatureTimestamp),
        },
        body,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      lastError = error instanceof Error ? error.message : "Unknown webhook network error";
      if (attempt === attempts) {
        break;
      }
      await sleep(retryDelayMs * attempt);
      continue;
    }

    if (response.ok) {
      return;
    }

    lastStatus = response.status;
    lastError = null;
    if (!shouldRetryWebhookStatus(response.status) || attempt === attempts) {
      break;
    }
    await sleep(retryDelayMs * attempt);
  }

  if (lastError) {
    throw new Error(`Webhook network error after ${completedAttempts} attempt(s): ${lastError}`);
  }
  throw new Error(`Webhook failed with ${lastStatus} after ${completedAttempts} attempt(s)`);
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
  const failures: string[] = [];
  for (const alert of alerts) {
    try {
      await sendWebhook(alert);
      await patchAlert(alert.id, "sent");
      console.log(`Sent alert ${alert.id}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown delivery error";
      await patchAlert(alert.id, "error", message);
      failures.push(`${alert.id}: ${message}`);
      console.error(`Marked alert ${alert.id} as error: ${message}`);
    }
  }

  const failureSummary = summarizeDispatchFailures(failures);
  if (failureSummary) {
    throw new Error(failureSummary);
  }
}

function isDirectRun() {
  return Boolean(process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href);
}

if (isDirectRun()) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
