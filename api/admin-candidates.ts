import { createClient } from "@supabase/supabase-js";
import type { AdminEventInput } from "../src/lib/adminEventRows";
import { toEventRow } from "../src/lib/adminEventRows";

type VercelRequest = {
  method?: string;
  headers?: Record<string, string | string[] | undefined>;
  body?: unknown;
};

type VercelResponse = {
  status: (code: number) => VercelResponse;
  json: (body: unknown) => void;
  setHeader: (name: string, value: string) => void;
};

type CandidateStatus = "pending" | "approved" | "rejected";

type CandidateInput = {
  source?: unknown;
  sourceUrl?: unknown;
  draft?: unknown;
};

type CandidateRow = {
  id: string;
  source: string;
  source_url: string | null;
  draft: AdminEventInput;
  status: CandidateStatus;
  rejection_reason: string | null;
  approved_event_id: string | null;
  created_at: string;
  updated_at: string;
};

type CandidateActionPayload = {
  id?: unknown;
  action?: unknown;
  draft?: unknown;
  reason?: unknown;
};

const supabaseUrl = process.env.VITE_SUPABASE_URL ?? process.env.SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const adminApiToken = process.env.ADMIN_API_TOKEN;

function headerValue(req: VercelRequest, name: string) {
  const value = req.headers?.[name] ?? req.headers?.[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

function parseBody<T>(body: unknown): T {
  if (typeof body === "string") {
    return JSON.parse(body) as T;
  }
  if (body && typeof body === "object") {
    return body as T;
  }
  return {} as T;
}

function missingCandidateTable(error: { code?: string; message?: string } | null) {
  return Boolean(error && (error.code === "42P01" || error.message?.includes("event_candidates")));
}

function optionalString(value: unknown) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function normalizeCandidateInput(value: CandidateInput) {
  if (!value.draft || typeof value.draft !== "object") {
    throw new Error("draft is required");
  }

  const draft = value.draft as AdminEventInput;
  return {
    source: optionalString(value.source) ?? optionalString(draft.source) ?? "Imported URL",
    source_url: optionalString(value.sourceUrl) ?? optionalString(draft.link),
    draft,
    status: "pending" as CandidateStatus,
  };
}

function toPublicCandidate(row: CandidateRow) {
  return {
    id: row.id,
    source: row.source,
    sourceUrl: row.source_url,
    draft: row.draft,
    status: row.status,
    rejectionReason: row.rejection_reason,
    approvedEventId: row.approved_event_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader("Cache-Control", "no-store");

  if (req.method && !["GET", "POST", "PATCH"].includes(req.method)) {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  if (!supabaseUrl || !serviceRoleKey || !adminApiToken) {
    res.status(503).json({ error: "Admin candidate API is not configured" });
    return;
  }

  if (headerValue(req, "x-admin-token") !== adminApiToken) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey);

  if (!req.method || req.method === "GET") {
    const { data, error } = await supabase
      .from("event_candidates")
      .select("id,source,source_url,draft,status,rejection_reason,approved_event_id,created_at,updated_at")
      .eq("status", "pending")
      .order("created_at", { ascending: false })
      .limit(50);

    if (missingCandidateTable(error)) {
      res.status(200).json({ configured: false, candidates: [] });
      return;
    }
    if (error) {
      res.status(500).json({ error: error.message });
      return;
    }

    res.status(200).json({
      configured: true,
      candidates: ((data ?? []) as CandidateRow[]).map(toPublicCandidate),
    });
    return;
  }

  if (req.method === "POST") {
    try {
      const body = parseBody<{ candidate?: CandidateInput; candidates?: CandidateInput[] }>(req.body);
      const inputs = Array.isArray(body.candidates) ? body.candidates : body.candidate ? [body.candidate] : [];
      if (inputs.length === 0) {
        throw new Error("candidate is required");
      }

      const rows = inputs.map(normalizeCandidateInput);
      const { data, error } = await supabase
        .from("event_candidates")
        .upsert(rows, { onConflict: "source_url" })
        .select("id,source,source_url,draft,status,rejection_reason,approved_event_id,created_at,updated_at");

      if (missingCandidateTable(error)) {
        res.status(503).json({ configured: false, error: "Candidate table is not ready" });
        return;
      }
      if (error) {
        res.status(500).json({ error: error.message });
        return;
      }

      res.status(200).json({
        ok: true,
        configured: true,
        candidates: ((data ?? []) as CandidateRow[]).map(toPublicCandidate),
      });
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : "Invalid request" });
    }
    return;
  }

  try {
    const body = parseBody<CandidateActionPayload>(req.body);
    const id = optionalString(body.id);
    if (!id) throw new Error("id is required");

    if (body.action === "reject") {
      const { data, error } = await supabase
        .from("event_candidates")
        .update({
          status: "rejected",
          rejection_reason: optionalString(body.reason),
        })
        .eq("id", id)
        .select("id,source,source_url,draft,status,rejection_reason,approved_event_id,created_at,updated_at")
        .single();

      if (missingCandidateTable(error)) {
        res.status(503).json({ configured: false, error: "Candidate table is not ready" });
        return;
      }
      if (error) {
        res.status(500).json({ error: error.message });
        return;
      }

      res.status(200).json({ ok: true, candidate: toPublicCandidate(data as CandidateRow) });
      return;
    }

    if (body.action !== "approve") {
      throw new Error("action must be approve or reject");
    }

    const { data: candidate, error: candidateError } = await supabase
      .from("event_candidates")
      .select("id,source,source_url,draft,status,rejection_reason,approved_event_id,created_at,updated_at")
      .eq("id", id)
      .single();

    if (missingCandidateTable(candidateError)) {
      res.status(503).json({ configured: false, error: "Candidate table is not ready" });
      return;
    }
    if (candidateError || !candidate) {
      res.status(404).json({ error: candidateError?.message ?? "Candidate not found" });
      return;
    }

    const candidateRow = candidate as CandidateRow;
    const draft =
      body.draft && typeof body.draft === "object" ? (body.draft as AdminEventInput) : candidateRow.draft;
    const eventRow = toEventRow(draft, { candidateId: id, candidateSourceUrl: candidateRow.source_url });
    const { data: eventData, error: eventError } = await supabase
      .from("events")
      .upsert(eventRow, { onConflict: "source,source_event_id" })
      .select("id,artist,title,city,venue,date,source,source_event_id")
      .single();

    if (eventError) {
      res.status(500).json({ error: eventError.message });
      return;
    }

    const { data: updatedCandidate, error: updateError } = await supabase
      .from("event_candidates")
      .update({
        status: "approved",
        approved_event_id: (eventData as { id: string }).id,
      })
      .eq("id", id)
      .select("id,source,source_url,draft,status,rejection_reason,approved_event_id,created_at,updated_at")
      .single();

    if (updateError) {
      res.status(500).json({ error: updateError.message });
      return;
    }

    res.status(200).json({
      ok: true,
      event: eventData,
      candidate: toPublicCandidate(updatedCandidate as CandidateRow),
    });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "Invalid request" });
  }
}
