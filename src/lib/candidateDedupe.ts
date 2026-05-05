export type CandidateStatus = "pending" | "approved" | "rejected";

export type CandidateUpsertRow = {
  source_url: string | null;
  status: CandidateStatus;
};

export type ExistingCandidateRow = {
  source_url: string | null;
  status: CandidateStatus;
};

export function splitCandidateRowsByExistingStatus<Row extends CandidateUpsertRow, Existing extends ExistingCandidateRow>(
  rows: Row[],
  existingRows: Existing[],
) {
  const existingBySourceUrl = new Map(
    existingRows
      .filter((row) => row.source_url)
      .map((row) => [row.source_url, row]),
  );
  const preservedTerminalRows = new Map<string, Existing>();
  const upsertRows: Row[] = [];

  for (const row of rows) {
    const existing = row.source_url ? existingBySourceUrl.get(row.source_url) : null;
    if (!existing || existing.status === "pending") {
      upsertRows.push(row);
      continue;
    }

    preservedTerminalRows.set(existing.source_url as string, existing);
  }

  return {
    upsertRows,
    skippedRows: Array.from(preservedTerminalRows.values()),
  };
}
