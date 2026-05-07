import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  extractLiveFansDetailUrls,
  extractLiveFansRows,
  liveFansLogicalEventKey,
} from "../scripts/sync-livefans";
import {
  extractLiveNationHipDetailUrls,
  extractLiveNationHipRows,
  liveNationHipLogicalEventKey,
} from "../scripts/sync-livenation-hip";

const now = new Date("2026-05-07T00:00:00+09:00");

const liveFansSearchHtml = await readFile(new URL("./fixtures/livefans-search.html", import.meta.url), "utf8");
const liveFansDetailHtml = await readFile(new URL("./fixtures/livefans-detail.html", import.meta.url), "utf8");
const liveNationHipIndexHtml = await readFile(new URL("./fixtures/livenation-hip-index.html", import.meta.url), "utf8");
const liveNationHipDetailHtml = await readFile(new URL("./fixtures/livenation-hip-detail.html", import.meta.url), "utf8");

const liveFansUrls = extractLiveFansDetailUrls(liveFansSearchHtml, "https://www.livefans.jp/search?option=3&keyword=J-POP");
assert.deepEqual(liveFansUrls, ["https://www.livefans.jp/events/1900001"]);

const liveFansRows = extractLiveFansRows(liveFansDetailHtml, "https://www.livefans.jp/events/1900001", now);
assert.equal(liveFansRows.length, 1);
assert.equal(liveFansRows[0].source, "LiveFans");
assert.equal(liveFansRows[0].artist, "LANY");
assert.equal(liveFansRows[0].title, "LANY Live in Tokyo");
assert.equal(liveFansRows[0].city, "도쿄");
assert.equal(liveFansRows[0].venue, "Zepp Haneda");
assert.equal(liveFansRows[0].date, "2026-08-15");
assert.equal(liveFansRows[0].time, "18:00");
assert.equal(liveFansRows[0].ticket_access, "일본 번호 필요");
assert.equal(liveFansRows[0].sale_type, "선착 판매");
assert.ok(liveFansRows[0].sale_window?.includes("2026/06/01"));
assert.equal(liveFansRows[0].link, "https://ticket.pia.jp/pia/event.ds?eventCd=2600001");
assert.equal(liveFansLogicalEventKey(liveFansRows[0]), "lany live in tokyo|2026-08-15|18:00|zepp haneda|도쿄");

const liveNationHipUrls = extractLiveNationHipDetailUrls(liveNationHipIndexHtml, "https://www.livenationhip.co.jp/");
assert.deepEqual(liveNationHipUrls, [
  "https://www.livenationhip.co.jp/all-events/charlie-puth-tickets-ae123456",
  "https://www.livenationhip.co.jp/all-events/lany-tickets-ae654321",
]);

const liveNationHipRows = extractLiveNationHipRows(
  liveNationHipDetailHtml,
  "https://www.livenationhip.co.jp/all-events/charlie-puth-tickets-ae123456",
  now,
);
assert.equal(liveNationHipRows.length, 1);
assert.equal(liveNationHipRows[0].source, "Live Nation H.I.P.");
assert.equal(liveNationHipRows[0].artist, "Charlie Puth");
assert.equal(liveNationHipRows[0].title, "Charlie Puth - Something New Tour");
assert.equal(liveNationHipRows[0].city, "요코하마");
assert.equal(liveNationHipRows[0].venue, "K-Arena Yokohama");
assert.equal(liveNationHipRows[0].date, "2026-10-21");
assert.equal(liveNationHipRows[0].time, "19:00");
assert.equal(liveNationHipRows[0].sale_type, "추첨 접수");
assert.equal(liveNationHipRows[0].sale_window, "受付期間: 6/1 12:00 ~ 6/9 23:59 チケット購入");
assert.equal(liveNationHipRows[0].price, "¥12,000");
assert.equal(liveNationHipRows[0].link, "https://w.pia.jp/t/charlieputh-jp/");
assert.equal(
  liveNationHipLogicalEventKey(liveNationHipRows[0]),
  "charlie puth - something new tour|2026-10-21|19:00|k-arena yokohama|요코하마",
);

const pastRows = extractLiveNationHipRows(
  liveNationHipDetailHtml.replace("2026年 10月 21日", "2026年 01月 21日"),
  "https://www.livenationhip.co.jp/all-events/charlie-puth-tickets-ae123456",
  now,
);
assert.equal(pastRows.length, 0);

console.log("Public source parser fixture tests passed.");
