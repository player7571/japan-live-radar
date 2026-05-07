import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  extractLawsonDetailRows,
  extractLawsonSearchRows,
  lawsonLogicalEventKey,
} from "../scripts/sync-lawson";

const now = new Date("2026-05-06T00:00:00+09:00");
const searchHtml = await readFile(new URL("./fixtures/lawson-search.html", import.meta.url), "utf8");
const detailHtml = await readFile(new URL("./fixtures/lawson-detail.html", import.meta.url), "utf8");

const searchRows = extractLawsonSearchRows(searchHtml, now);
assert.equal(searchRows.length, 1);
assert.equal(searchRows[0].source, "Lawson Ticket");
assert.equal(searchRows[0].title, "METROCK OSAKA 2026");
assert.equal(searchRows[0].city, "오사카");
assert.equal(searchRows[0].date, "2026-05-30");
assert.equal(searchRows[0].sale_type, "선착 판매");
assert.ok(searchRows[0].link?.startsWith("https://l-tike.com/order/?gLcode=56605"));

const detailRows = extractLawsonDetailRows(
  detailHtml,
  "https://l-tike.com/concert/mevent/?mid=583255",
  now,
);
assert.equal(detailRows.length, 1);
assert.equal(detailRows[0].artist, "Ado");
assert.equal(detailRows[0].city, "요코하마");
assert.equal(detailRows[0].sale_type, "추첨 접수");
assert.equal(detailRows[0].phone_required, true);
assert.ok(detailRows[0].sale_window?.includes("2026.04.13"));
assert.equal(
  lawsonLogicalEventKey(detailRows[0]),
  "ado|2026-07-04||日産スタジアム|요코하마",
);

console.log("Lawson parser fixture tests passed.");
