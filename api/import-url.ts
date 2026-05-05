import * as cheerio from "cheerio";

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

type ImportPayload = {
  url?: unknown;
  urls?: unknown;
};

type ImportedDraft = {
  artist: string;
  title: string;
  city: string;
  venue: string;
  date: string;
  time: string;
  genre: string;
  source: string;
  ticketAccess: "한국 구매 가능" | "일본 번호 필요" | "확인 필요";
  saleType: "추첨 접수" | "일반 판매" | "선착 판매" | "해외 판매" | "리세일";
  saleWindow: string;
  price: string;
  phoneRequired: boolean;
  foreignerNote: string;
  link: string;
  image: string;
};

const adminApiToken = process.env.ADMIN_API_TOKEN;
const fallbackDraft: ImportedDraft = {
  artist: "",
  title: "",
  city: "도쿄",
  venue: "",
  date: "",
  time: "",
  genre: "Music",
  source: "Imported URL",
  ticketAccess: "확인 필요",
  saleType: "일반 판매",
  saleWindow: "",
  price: "",
  phoneRequired: true,
  foreignerNote: "원본 티켓 페이지에서 해외 결제와 수령 조건을 확인하세요.",
  link: "",
  image: "",
};

function headerValue(req: VercelRequest, name: string) {
  const value = req.headers?.[name] ?? req.headers?.[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

function parseBody(body: unknown): ImportPayload {
  if (typeof body === "string") {
    return JSON.parse(body) as ImportPayload;
  }
  if (body && typeof body === "object") {
    return body as ImportPayload;
  }
  return {};
}

function normalizedHostname(value: string) {
  return value.toLowerCase().replace(/^\[(.*)]$/, "$1").replace(/\.$/, "");
}

function isPrivateIpv4(hostname: string) {
  const parts = hostname.split(".");
  if (parts.length !== 4) return false;
  const octets = parts.map((part) => Number(part));
  if (octets.some((octet, index) => !Number.isInteger(octet) || octet < 0 || octet > 255 || String(octet) !== parts[index])) {
    return false;
  }
  const [first, second] = octets;
  return first === 0 ||
    first === 10 ||
    first === 127 ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168);
}

function isPrivateHostname(hostname: string) {
  const normalized = normalizedHostname(hostname);
  return normalized === "localhost" ||
    normalized.endsWith(".localhost") ||
    normalized.endsWith(".local") ||
    normalized === "::1" ||
    (normalized.includes(":") && (normalized.startsWith("fc") || normalized.startsWith("fd"))) ||
    normalized.startsWith("fe80:") ||
    isPrivateIpv4(normalized);
}

export function safeUrl(value: unknown) {
  if (typeof value !== "string") {
    throw new Error("url is required");
  }

  const url = new URL(value);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("url must be http or https");
  }
  if (isPrivateHostname(url.hostname)) {
    throw new Error("private or local URLs are not allowed");
  }

  return url;
}

function requestedUrls(payload: ImportPayload) {
  if (Array.isArray(payload.urls)) {
    return payload.urls.slice(0, 10).map(safeUrl);
  }
  return [safeUrl(payload.url)];
}

function firstString(...values: Array<unknown>) {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return "";
}

function compactWhitespace(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

function normalizeFullWidth(value: string) {
  return value.replace(/[！-～]/g, (char) => String.fromCharCode(char.charCodeAt(0) - 0xfee0));
}

function escapePattern(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function cleanTitle(value: string, hostname: string) {
  return compactWhitespace(value)
    .replace(/\s*[|｜]\s*(チケットぴあ|e\+|イープラス|ローチケ|ローソンチケット|LiveFans).*$/i, "")
    .replace(/\s*-\s*(チケットぴあ|e\+|イープラス|ローチケ|ローソンチケット|LiveFans).*$/i, "")
    .replace(new RegExp(`\\s*[|｜-]\\s*${hostname.replace(/^www\\./, "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}.*$`, "i"), "")
    .trim();
}

function normalizeDate(value: string) {
  const normalized = normalizeFullWidth(value);
  const isoDate = normalized.match(/\d{4}-\d{2}-\d{2}/)?.[0];
  if (isoDate) return isoDate;

  const jpDate = normalized.match(/(\d{4})[./年-]\s*(\d{1,2})[./月-]\s*(\d{1,2})/)?.slice(1);
  if (jpDate?.length === 3) {
    const [year, month, day] = jpDate;
    return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
  }

  return "";
}

function formatClockTime(hour: string, minute?: string) {
  return `${hour}:${minute ?? "00"}`;
}

function normalizeTime(value: string) {
  const normalized = normalizeFullWidth(value);
  const isoTime = normalized.match(/T([01]\d|2[0-3]):([0-5]\d)/);
  if (isoTime) return `${isoTime[1]}:${isoTime[2]}`;
  const showtime = normalized.match(
    /(?:開演|START)\s*[:：]?\s*([01]?\d|2[0-3])(?::([0-5]\d)|時\s*([0-5]\d)?\s*分?)/i,
  );
  if (showtime) return formatClockTime(showtime[1], showtime[2] ?? showtime[3]);
  const japaneseTime = normalized.match(/\b([01]?\d|2[0-3])時\s*([0-5]\d)?\s*分?/);
  if (japaneseTime) return formatClockTime(japaneseTime[1], japaneseTime[2]);
  return normalized.match(/\b([01]?\d|2[0-3]):([0-5]\d)\b/)?.[0] ?? "";
}

function labeledTextValue(text: string, labels: string[]) {
  const normalized = normalizeFullWidth(text);
  const labelPattern = labels.map(escapePattern).join("|");
  const lines = normalized
    .split(/\r?\n/)
    .map(compactWhitespace)
    .filter(Boolean);

  for (const line of lines) {
    const match = line.match(new RegExp(`^(?:${labelPattern})\\s*[:：]\\s*(.+)$`, "i"));
    if (match) return compactWhitespace(match[1]);
  }

  const inlineMatch = normalized.match(new RegExp(`(?:${labelPattern})\\s*[:：]\\s*([^\\n。]+)`, "i"));
  return inlineMatch ? compactWhitespace(inlineMatch[1]) : "";
}

function matchesLabel(text: string, labels: string[]) {
  const normalized = normalizeFullWidth(compactWhitespace(text)).replace(/[：:]+$/, "");
  return labels.some((label) => normalized === normalizeFullWidth(label));
}

function labeledElementValue($: cheerio.CheerioAPI, labels: string[]) {
  for (const row of $("tr").toArray()) {
    const cells = $(row).children("th,td");
    const label = cells.first().text();
    if (matchesLabel(label, labels)) {
      const value = compactWhitespace(cells.slice(1).text());
      if (value) return value;
    }
  }

  for (const term of $("dt").toArray()) {
    if (matchesLabel($(term).text(), labels)) {
      const value = compactWhitespace($(term).next("dd").text());
      if (value) return value;
    }
  }

  return "";
}

function labeledValue($: cheerio.CheerioAPI, text: string, labels: string[]) {
  return firstString(labeledElementValue($, labels), labeledTextValue(text, labels));
}

function normalizePriceText(value: string) {
  const normalized = normalizeFullWidth(value);
  const bareStructuredPrice = normalized.match(/^\s*([0-9,]{3,})\s*$/);
  if (bareStructuredPrice) {
    const amount = Number(bareStructuredPrice[1].replaceAll(",", ""));
    return Number.isFinite(amount) ? `¥${amount.toLocaleString("ja-JP")}` : "";
  }

  const price = normalized.match(/[¥￥]\s?([0-9,]{3,})(?:\s?[~〜-]\s?[¥￥]?\s?([0-9,]{3,}))?/) ??
    normalized.match(/([0-9,]{3,})\s?円(?:\s?[~〜-]\s?([0-9,]{3,})\s?円)?/);

  if (!price) return "";
  const first = Number(price[1].replaceAll(",", ""));
  const second = price[2] ? Number(price[2].replaceAll(",", "")) : null;
  if (!Number.isFinite(first)) return "";
  if (second && Number.isFinite(second)) {
    return `¥${first.toLocaleString("ja-JP")} - ¥${second.toLocaleString("ja-JP")}`;
  }
  return `¥${first.toLocaleString("ja-JP")}`;
}

function saleTypeFromText(text: string): ImportedDraft["saleType"] {
  if (/(リセール|再販売|公式トレード|チケットトレード|ticket\s*resale|resale)/i.test(text)) return "리세일";
  if (/(海外|international|overseas).{0,16}(受付|販売|ticket)/i.test(text)) return "해외 판매";
  if (/(抽選|プレリザーブ|先行受付|先行抽選|lottery|抽せん)/i.test(text)) return "추첨 접수";
  if (/(先着|先着順|first[- ]come|先行先着)/i.test(text)) return "선착 판매";
  if (/(一般発売|一般販売|general sale|発売日)/i.test(text)) return "일반 판매";
  return "일반 판매";
}

function residencyRestrictionNoteFromText(text: string) {
  const normalized = normalizeFullWidth(text);
  const residentOnlySignal =
    /(国内在住者|日本国内在住者|日本在住者|日本居住者).{0,18}(限定|のみ|対象|に限る|限ります|必要|必須)/i.test(
      normalized,
    ) ||
    /(日本国内|国内|日本).{0,18}(住所|在住|居住).{0,18}(限定|のみ|必要|必須|確認|登録)/i.test(normalized) ||
    /(海外在住|国外在住|日本国外|海外から).{0,24}(不可|対象外|申込不可|購入不可|申し込みできません|お申し込みいただけません|購入できません|ご利用いただけません)/i.test(
      normalized,
    );

  return residentOnlySignal
    ? "일본 국내 거주자/주소 한정 또는 해외 거주자 신청 불가 신호가 있어 한국 거주자는 예매가 어려울 수 있습니다."
    : "";
}

function accessFromText(text: string): Pick<ImportedDraft, "phoneRequired" | "ticketAccess" | "foreignerNote"> {
  const residencyRestrictionNote = residencyRestrictionNoteFromText(text);
  const overseasSignal = /(海外|international|overseas|foreign|外国|訪日|インバウンド).{0,28}(受付|販売|ticket|購入|カード)/i.test(text);
  const foreignPhoneSignal =
    /(海外|国外|外国).{0,24}(電話番号|携帯電話番号|SMS|ショートメッセージ).{0,24}(利用|登録|認証|可能|対応|使えます|受信)/i.test(
      text,
    ) ||
    /(電話番号|携帯電話番号|SMS|ショートメッセージ).{0,24}(国番号|country code|海外番号|国外番号|外国番号)/i.test(text);
  const noPhoneSignal =
    /(日本|国内|携帯|電話番号|SMS|SMS認証|認証).{0,18}(不要|なし|無し|必要ありません|必要なし|不要です)/i.test(text) ||
    /(不要|なし|無し|必要ありません|必要なし|不要です).{0,18}(日本|国内|携帯|電話番号|SMS|SMS認証|認証)/i.test(text);
  const japanPhoneOnlySignal =
    /(日本国内|国内|日本).{0,12}(携帯電話番号|電話番号|SMS|ショートメッセージ).{0,24}(のみ|限定|必要|必須|登録|認証|受信)/i.test(
      text,
    ) ||
    /(携帯電話番号|電話番号|SMS|ショートメッセージ).{0,24}(日本国内|国内|日本).{0,12}(のみ|限定|必要|必須|登録|認証|受信)/i.test(
      text,
    );
  const electronicTicketAppSignal =
    /(電子チケット|電子チケットアプリ|スマチケ|MOALA|MOALA Pocket|AnyPASS|チケプラ|Tixplus|Bitfan Pass|ticket board|チケットボード|ローチケ電子チケット|ローチケアプリ|EMTG|Plus member ID)/i.test(
      text,
    );
  const phoneSignal =
    japanPhoneOnlySignal ||
    electronicTicketAppSignal ||
    /(電話番号|携帯電話|SMS|SMS認証|電話番号認証|携帯認証)/i.test(
      text,
    );

  if (residencyRestrictionNote) {
    return {
      phoneRequired: true,
      ticketAccess: "확인 필요",
      foreignerNote: residencyRestrictionNote,
    };
  }

  if ((overseasSignal && !phoneSignal) || (overseasSignal && (noPhoneSignal || foreignPhoneSignal))) {
    return {
      phoneRequired: false,
      ticketAccess: "한국 구매 가능",
      foreignerNote: foreignPhoneSignal
        ? "해외 판매와 해외 전화번호/SMS 인증 가능 신호가 있어 한국에서 예매 가능성이 높습니다."
        : noPhoneSignal
        ? "해외 판매와 일본 전화번호/SMS 인증 불필요 신호가 있어 한국에서 예매 가능성이 높습니다."
        : "해외/외국인 판매 신호가 있어 한국에서 예매 가능성이 있습니다. 결제와 수령 조건은 원본에서 확인하세요.",
    };
  }

  if (phoneSignal) {
    return {
      phoneRequired: true,
      ticketAccess: "일본 번호 필요",
      foreignerNote: japanPhoneOnlySignal
        ? "일본 국내 휴대전화번호/SMS 한정 신호가 있어 한국 번호로 예매가 어려울 수 있습니다."
        : electronicTicketAppSignal
        ? "전자티켓 인증 앱 신호가 있어 일본 번호 또는 앱 계정 조건 확인이 필요합니다."
        : "전화번호/SMS/전자티켓 인증 신호가 있어 일본 번호 또는 앱 조건 확인이 필요합니다.",
    };
  }

  return {
    phoneRequired: true,
    ticketAccess: "확인 필요",
    foreignerNote: fallbackDraft.foreignerNote,
  };
}

function paymentPickupNoteFromText(text: string) {
  const notes: string[] = [];
  const creditCardOnly =
    /(クレジットカード|credit card|カード決済|クレカ).{0,20}(のみ|限定|only|必須|決済)/i.test(text) ||
    /(のみ|限定|only|必須).{0,20}(クレジットカード|credit card|カード決済|クレカ)/i.test(text);
  const creditCardAvailable = /(クレジットカード|credit card|カード決済|クレカ)/i.test(text);
  const convenienceStore =
    /(コンビニ|セブン-?イレブン|ファミリーマート|ローソン).{0,24}(支払|決済|入金|発券|受取|引取)/i.test(text) ||
    /(支払|決済|入金|発券|受取|引取).{0,24}(コンビニ|セブン-?イレブン|ファミリーマート|ローソン)/i.test(text);
  const paperTicket = /(紙チケット|店頭発券|配送|郵送|チケットぴあ店舗|Cloak)/i.test(text);

  if (creditCardOnly) {
    notes.push("신용카드 결제 전용 신호가 있습니다.");
  } else if (creditCardAvailable) {
    notes.push("신용카드 결제 가능 신호가 있습니다.");
  }
  if (convenienceStore) {
    notes.push("편의점 결제/발권 또는 현지 수령 조건을 확인하세요.");
  }
  if (paperTicket) {
    notes.push("종이 티켓/매장 발권/배송 조건을 확인하세요.");
  }

  return notes.join(" ");
}

function lotteryResultNoteFromText(text: string) {
  const normalized = normalizeFullWidth(text);
  const result = normalized.match(
    /(抽選結果発表日時|抽選結果発表|結果発表|当落発表|当選発表)\s*[:：]?\s*([^\n。]{1,60})/i,
  );
  if (!result) return "";

  return `추첨 결과 발표: ${compactWhitespace(result[2])}.`;
}

function identityVerificationNoteFromText(text: string) {
  const normalized = normalizeFullWidth(text);
  const notes: string[] = [];
  const identitySignal =
    /(本人確認|本人確認書類|身分証明書|身分証|公的身分証|顔写真|顔写真登録|顔写真付き|顔認証|入場時.{0,16}確認|名義確認|購入者確認)/i.test(
      normalized,
    ) ||
    /(パスポート|運転免許証|マイナンバーカード|健康保険証|在留カード).{0,24}(提示|確認|必要|持参|登録)/i.test(
      normalized,
    );
  const companionSignal =
    /(同行者|来場者).{0,24}(登録|情報|指定|変更|本人確認|分配|譲渡)/i.test(normalized) ||
    /(代表者|申込者|購入者).{0,24}(同行者|来場者|分配|譲渡)/i.test(normalized) ||
    /(チケット分配|分配|来場者登録|同行者登録|同行者情報)/i.test(normalized);

  if (identitySignal) {
    notes.push("입장 시 본인확인/신분증/얼굴사진 확인 신호가 있어 여권명과 예매자명 조건을 확인하세요.");
  }
  if (companionSignal) {
    notes.push("동행자 등록/티켓 분배/방문자 정보 입력 신호가 있어 동행자 변경 가능 여부와 계정 조건을 확인하세요.");
  }

  return notes.join(" ");
}

function membershipRequirementNoteFromText(text: string) {
  const normalized = normalizeFullWidth(text);
  const fanclubSignal =
    /(ファンクラブ|FC|fan\s*club|オフィシャル会員|公式会員|有料会員).{0,28}(限定|先行|受付|抽選|申込|申し込み|対象|入会|登録|認証)/i.test(
      normalized,
    ) ||
    /(限定|先行|受付|抽選|申込|申し込み|対象).{0,18}(ファンクラブ|FC|fan\s*club|オフィシャル会員|公式会員|有料会員)/i.test(
      normalized,
    );
  const companionMembershipSignal =
    /(同行者|来場者).{0,24}(会員|ファンクラブ|FC).{0,24}(登録|限定|必要|対象|認証)/i.test(normalized) ||
    /(会員|ファンクラブ|FC).{0,24}(同行者|来場者).{0,24}(登録|限定|必要|対象|認証)/i.test(normalized);

  return [
    fanclubSignal ? "팬클럽/유료 회원 한정 또는 선행 접수 신호가 있어 가입 가능 여부와 해외 거주자 신청 조건을 확인하세요." : "",
    companionMembershipSignal ? "동행자도 회원 등록/인증이 필요할 수 있어 동행자 계정 조건을 확인하세요." : "",
  ]
    .filter(Boolean)
    .join(" ");
}

function specialSaleNoteFromText(text: string) {
  const normalized = normalizeFullWidth(text);
  const notes: string[] = [];
  const upgradeLottery = /(アップグレード|upgrade).{0,24}(抽選|受付|申込|販売)|アップグレード抽選/i.test(normalized);
  const additionalSale = /(追加販売|追加発売|追加席|機材席開放|開放席|当日券|当日引換券|直前販売)/i.test(normalized);
  const restrictedView =
    /(注釈付き指定席|注釈付指定席|見切れ席|見えにくい席|ステージサイド席|サイドバック席|機材席|立見|立ち見)/i.test(
      normalized,
    );

  if (upgradeLottery) {
    notes.push("업그레이드 추첨/좌석 변경 접수 신호가 있어 기존 티켓 보유 조건과 신청 대상을 확인하세요.");
  }
  if (additionalSale) {
    notes.push("추가 판매/기재석 개방/당일권 신호가 있어 판매 시작 시각과 수량 제한을 확인하세요.");
  }
  if (restrictedView) {
    notes.push("주석付き/시야제한/스테이지사이드 좌석 신호가 있어 좌석 시야 조건을 원본에서 확인하세요.");
  }

  return notes.join(" ");
}

function importForeignerNote(description: string, accessNote: string, pageText: string) {
  return [
    description,
    accessNote,
    residencyRestrictionNoteFromText(pageText),
    lotteryResultNoteFromText(pageText),
    identityVerificationNoteFromText(pageText),
    membershipRequirementNoteFromText(pageText),
    specialSaleNoteFromText(pageText),
    paymentPickupNoteFromText(pageText),
  ]
    .map(compactWhitespace)
    .filter(Boolean)
    .filter((note, index, notes) => notes.indexOf(note) === index)
    .join(" ");
}

function saleWindowFromText(text: string, fallbackYear = "") {
  const normalized = normalizeFullWidth(text);
  const clockPattern = String.raw`(?:[01]?\d|2[0-3])(?::[0-5]\d|時\s*(?:[0-5]\d)?\s*分?)`;
  const fullDateTimePattern = String.raw`\d{4}[./年-]\s*\d{1,2}[./月-]\s*\d{1,2}(?:日)?(?:\([^)]*\))?\s*${clockPattern}`;
  const shortDateTimePattern = String.raw`(?:\d{4}[./年-]\s*)?\d{1,2}[./月-]\s*\d{1,2}(?:日)?(?:\([^)]*\))?\s*${clockPattern}`;
  const startDateTimePattern = fallbackYear ? shortDateTimePattern : fullDateTimePattern;
  const normalizeStartDate = (start: string) => {
    const trimmedStart = compactWhitespace(start);
    if (/^\d{4}/.test(trimmedStart) || !fallbackYear) return trimmedStart;
    return `${fallbackYear}/${trimmedStart}`;
  };
  const normalizeEndDate = (start: string, end: string) => {
    const trimmedEnd = compactWhitespace(end);
    if (/^\d{4}/.test(trimmedEnd)) return trimmedEnd;
    const startYear = compactWhitespace(start).match(/^\d{4}/)?.[0];
    return startYear ? `${startYear}/${trimmedEnd}` : trimmedEnd;
  };

  const separateStart = normalized.match(
    new RegExp(
      `(受付開始日時|受付開始|販売開始|発売開始|発売日時|申込開始|抽選受付開始|先行受付開始)[:：]?\\s*(${startDateTimePattern})`,
    ),
  );
  const separateEnd = normalized.match(
    new RegExp(
      `(受付終了日時|受付終了|販売終了|発売終了|申込締切|申込終了|抽選受付終了|先行受付終了)[:：]?\\s*(${shortDateTimePattern})`,
    ),
  );
  if (separateStart && separateEnd) {
    const start = normalizeStartDate(separateStart[2]);
    return `${start} - ${normalizeEndDate(start, separateEnd[2])}`;
  }

  const range = normalized.match(
    new RegExp(
      `(受付期間|販売期間|申込期間|発売期間|抽選受付|先行受付|一般発売|発売日)?[:：]?\\s*` +
        `(${startDateTimePattern})\\s*(?:[~〜～\\-]|から|より)\\s*` +
        `(${shortDateTimePattern}|予定枚数終了|売切|売り切れ)`,
    ),
  );
  if (range) {
    const start = normalizeStartDate(range[2]);
    const end = normalizeEndDate(start, range[3]);
    return `${start} - ${compactWhitespace(end)}`;
  }

  const singleStart = normalized.match(
    new RegExp(`(受付開始|販売開始|発売開始|発売日時|発売日|一般発売|抽選受付|先行受付)[:：]?\\s*(${startDateTimePattern})`),
  );
  if (singleStart) return normalizeStartDate(singleStart[2]);

  const availabilityCue = normalized.match(
    /(販売終了|受付終了|申込終了|募集終了|終了しました|予定枚数終了|売切|売り切れ|完売|販売中(?!止)|受付中|発売中|申込受付中|チケット発売中|販売予定|受付予定|発売予定|近日発売|準備中|sold\s*out|closed|ended|on\s*sale|available\s*now|now\s*on\s*sale|coming\s*soon)/i,
  );
  return availabilityCue ? compactWhitespace(availabilityCue[1]) : "";
}

function artistFromTitle(title: string) {
  const leadingLatinName = title.match(/^[A-Za-z0-9][A-Za-z0-9 ._'&+-]{1,40}(?=\s|　|全国|ライブ|コンサート|ツアー|公演|$)/)?.[0];
  if (leadingLatinName) return leadingLatinName.trim();

  return title
    .split(/[｜|]/)[0]
    .replace(/\s*(チケット|ライブ|コンサート|公演|ツアー).*$/i, "")
    .trim();
}

function flattenJsonLd(value: unknown): Array<Record<string, unknown>> {
  if (!value) return [];
  if (Array.isArray(value)) return value.flatMap(flattenJsonLd);
  if (typeof value === "object") {
    const objectValue = value as Record<string, unknown>;
    const graph = objectValue["@graph"];
    return [objectValue, ...flattenJsonLd(graph)];
  }
  return [];
}

function firstObject(value: unknown): Record<string, unknown> {
  if (Array.isArray(value)) return firstObject(value[0]);
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function objectList(value: unknown): Array<Record<string, unknown>> {
  if (!value) return [];
  if (Array.isArray(value)) return value.flatMap(objectList);
  return typeof value === "object" ? [value as Record<string, unknown>] : [];
}

function firstJsonString(value: unknown) {
  if (Array.isArray(value)) return firstString(...value);
  return firstString(value);
}

function normalizeSchemaPriceRange(lowPrice: unknown, highPrice: unknown) {
  const low = firstString(lowPrice);
  const high = firstString(highPrice);
  if (!low || !high || low === high) return "";
  const lowAmount = Number(low.replaceAll(",", ""));
  const highAmount = Number(high.replaceAll(",", ""));
  if (!Number.isFinite(lowAmount) || !Number.isFinite(highAmount)) return "";
  return `¥${lowAmount.toLocaleString("ja-JP")} - ¥${highAmount.toLocaleString("ja-JP")}`;
}

function schemaOfferPrice(offer: Record<string, unknown>) {
  return firstString(
    normalizeSchemaPriceRange(offer.lowPrice, offer.highPrice),
    normalizePriceText(firstString(offer.price)),
    normalizePriceText(firstString(offer.lowPrice, offer.highPrice)),
  );
}

function priceFromOffers(offers: Array<Record<string, unknown>>) {
  return firstString(...offers.map(schemaOfferPrice));
}

function schemaAvailabilityCue(value: unknown) {
  const availability = firstJsonString(value).toLowerCase();
  if (!availability) return "";
  if (/(soldout|outofstock)/.test(availability)) return "予定枚数終了";
  if (/discontinued/.test(availability)) return "販売終了";
  if (/(instock|limitedavailability|preorder|presale)/.test(availability)) return "販売中";
  return "";
}

function schemaOfferSaleWindow(offer: Record<string, unknown>) {
  const start = firstString(firstJsonString(offer.availabilityStarts), firstJsonString(offer.validFrom));
  const end = firstString(firstJsonString(offer.availabilityEnds), firstJsonString(offer.validThrough));
  if (start && end) return `${start} - ${end}`;
  return firstString(start, end);
}

function saleWindowFromOffers(offers: Array<Record<string, unknown>>) {
  return firstString(
    ...offers.map(schemaOfferSaleWindow),
    ...offers.map((offer) => schemaAvailabilityCue(offer.availability)),
  );
}

function sourceFromHostname(hostname: string) {
  if (hostname.includes("pia.jp")) return "Ticket Pia";
  if (hostname.includes("eplus.jp")) return "e+";
  if (hostname.includes("l-tike.com")) return "Lawson Ticket";
  if (hostname.includes("ticketmaster.")) return "Ticketmaster";
  if (hostname.includes("ticketboard.jp") || hostname.includes("tickebo.jp")) return "ticket board";
  if (hostname.includes("livefans.jp")) return "LiveFans";
  return hostname.replace(/^www\./, "");
}

function ticketLinkScore(url: URL, label: string) {
  const hostname = url.hostname.toLowerCase();
  const text = normalizeFullWidth(`${label} ${url.pathname} ${url.search}`);
  let score = 0;

  if (/(pia\.jp|eplus\.jp|l-tike\.com|ticketmaster\.|ticketboard\.jp|tickebo\.jp)/i.test(hostname)) {
    score += 50;
  }
  if (/(申込|申し込み|購入|受付|販売|発売|抽選|先行|一般発売|リセール|resale)/i.test(text)) {
    score += 20;
  }
  if (/(チケット|ticket|ローチケ|ローソンチケット|イープラス|チケットぴあ|ticketmaster|ticket board)/i.test(text)) {
    score += 15;
  }
  if (/(twitter|x\.com|instagram|youtube|line\.me|facebook|tiktok)/i.test(hostname)) {
    score -= 100;
  }

  return score;
}

function ticketLinkFromPage($: cheerio.CheerioAPI, sourceUrl: URL) {
  const candidates = $("a[href]")
    .toArray()
    .map((element) => {
      const href = firstString($(element).attr("href"));
      if (!href || href.startsWith("#") || /^mailto:|^tel:/i.test(href)) return null;
      try {
        const url = new URL(href, sourceUrl);
        if (url.protocol !== "https:" && url.protocol !== "http:") return null;
        const label = compactWhitespace($(element).text());
        return {
          url,
          score: ticketLinkScore(url, label),
        };
      } catch {
        return null;
      }
    })
    .filter((candidate): candidate is { url: URL; score: number } => Boolean(candidate))
    .filter((candidate) => candidate.score > 0)
    .sort((left, right) => right.score - left.score);

  return candidates[0]?.url ?? sourceUrl;
}

function cityFromText(text: string) {
  const citySignals: Array<[string, string]> = [
    ["東京", "도쿄"],
    ["Tokyo", "도쿄"],
    ["日本武道館", "도쿄"],
    ["有明アリーナ", "도쿄"],
    ["東京ドーム", "도쿄"],
    ["大阪", "오사카"],
    ["Osaka", "오사카"],
    ["大阪城ホール", "오사카"],
    ["横浜", "요코하마"],
    ["Yokohama", "요코하마"],
    ["K-Arena", "요코하마"],
    ["Kアリーナ", "요코하마"],
    ["ぴあアリーナMM", "요코하마"],
    ["日産スタジアム", "요코하마"],
    ["名古屋", "나고야"],
    ["Nagoya", "나고야"],
    ["Nippon Gaishi Hall", "나고야"],
    ["日本ガイシホール", "나고야"],
    ["福岡", "후쿠오카"],
    ["Fukuoka", "후쿠오카"],
    ["マリンメッセ", "후쿠오카"],
    ["PayPayドーム", "후쿠오카"],
    ["札幌", "삿포로"],
    ["Sapporo", "삿포로"],
    ["真駒内セキスイハイムアイスアリーナ", "삿포로"],
    ["仙台", "센다이"],
    ["Sendai", "센다이"],
    ["広島", "히로시마"],
    ["Hiroshima", "히로시마"],
    ["埼玉", "사이타마"],
    ["さいたま", "사이타마"],
    ["Saitama", "사이타마"],
    ["千葉", "치바"],
    ["Chiba", "치바"],
    ["幕張メッセ", "치바"],
    ["ZOZOマリンスタジアム", "치바"],
    ["京都", "교토"],
    ["Kyoto", "교토"],
    ["神戸", "고베"],
    ["Kobe", "고베"],
  ];
  return citySignals.find(([signal]) => text.includes(signal))?.[1] ?? "도쿄";
}

function propertyContent($: cheerio.CheerioAPI, selector: string) {
  return firstString($(selector).first().attr("content"));
}

export function extractDraft(html: string, sourceUrl: URL): ImportedDraft {
  const $ = cheerio.load(html);
  const pageText = compactWhitespace($("body").text());
  const jsonLdItems = $("script[type='application/ld+json']")
    .toArray()
    .flatMap((element) => {
      try {
        return flattenJsonLd(JSON.parse($(element).text()));
      } catch {
        return [];
      }
    });
  const eventJson = jsonLdItems.find((item) => {
    const type = item["@type"];
    return type === "Event" || (Array.isArray(type) && type.includes("Event"));
  });
  const location =
    eventJson?.location && typeof eventJson.location === "object"
      ? (eventJson.location as Record<string, unknown>)
      : {};
  const address =
    location.address && typeof location.address === "object" ? (location.address as Record<string, unknown>) : {};
  const offers = firstObject(eventJson?.offers);
  const offerList = objectList(eventJson?.offers);
  const performer = firstObject(eventJson?.performer);
  const rawTitle = firstString(
    eventJson?.name,
    propertyContent($, "meta[property='og:title']"),
    propertyContent($, "meta[name='twitter:title']"),
    $("h1").first().text(),
    $("title").first().text(),
  );
  const title = cleanTitle(rawTitle, sourceUrl.hostname);
  const description = firstString(
    eventJson?.description,
    propertyContent($, "meta[property='og:description']"),
    propertyContent($, "meta[name='description']"),
  );
  const rawBodyText = $("body").text();
  const dateSource = firstString(
    eventJson?.startDate,
    $("time[datetime]").first().attr("datetime"),
    labeledValue($, rawBodyText, ["公演日", "開催日", "開催日時", "日程", "日時", "公演日時", "公演期間"]),
    pageText,
  );
  const price = normalizePriceText(
    firstString(
      priceFromOffers(offerList),
      labeledValue($, rawBodyText, ["料金", "価格", "チケット料金", "席種・料金"]),
      pageText,
    ),
  );
  const imageValue = eventJson?.image;
  const image = firstJsonString(imageValue);
  const venue = firstString(
    location.name,
    labeledValue($, rawBodyText, ["会場", "会場名", "場所", "Venue", "公演会場"]),
  );
  const textForCity = [venue, address.addressLocality, address.addressRegion, firstString(location.address), pageText].join(" ");
  const access = accessFromText(`${description} ${pageText}`);
  const ticketLink = ticketLinkFromPage($, sourceUrl);
  const eventDate = normalizeDate(dateSource);
  const saleWindow = firstString(
    saleWindowFromOffers(offerList),
    saleWindowFromText(pageText, eventDate.slice(0, 4)),
    labeledValue($, rawBodyText, ["受付期間", "販売期間", "申込期間", "発売期間", "発売日時", "発売日", "一般発売"]),
  );

  return {
    ...fallbackDraft,
    artist: firstString(performer.name, artistFromTitle(title), title),
    title,
    city: cityFromText(textForCity),
    venue,
    date: eventDate,
    time: normalizeTime(dateSource),
    source: sourceFromHostname(ticketLink.hostname),
    ticketAccess: access.ticketAccess,
    saleType: saleTypeFromText(`${description} ${pageText}`),
    saleWindow,
    price,
    phoneRequired: access.phoneRequired,
    foreignerNote: importForeignerNote(description, access.foreignerNote, pageText),
    link: ticketLink.toString(),
    image: firstString(image, propertyContent($, "meta[property='og:image']")),
  };
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader("Cache-Control", "no-store");

  if (req.method && req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }
  if (!adminApiToken) {
    res.status(503).json({ error: "Import API is not configured" });
    return;
  }
  if (headerValue(req, "x-admin-token") !== adminApiToken) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  try {
    const payload = parseBody(req.body);
    const urls = requestedUrls(payload);
    const results = [];

    for (const url of urls) {
      try {
        const response = await fetch(url, {
          headers: {
            "user-agent": "JapanLiveRadarBot/0.1 (+https://japan-live-radar.vercel.app)",
            accept: "text/html,application/xhtml+xml",
          },
          signal: AbortSignal.timeout(12_000),
        });
        if (!response.ok) {
          throw new Error(`source returned ${response.status}`);
        }
        const contentType = response.headers.get("content-type") ?? "";
        if (!contentType.includes("text/html")) {
          throw new Error("source did not return HTML");
        }

        const html = await response.text();
        results.push({
          url: url.toString(),
          draft: extractDraft(html.slice(0, 2_000_000), url),
        });
      } catch (error) {
        results.push({
          url: url.toString(),
          error: error instanceof Error ? error.message : "Import failed",
        });
      }
    }

    if (!Array.isArray(payload.urls)) {
      const [result] = results;
      if (!result || "error" in result || !("draft" in result)) {
        throw new Error(result && "error" in result ? result.error : "Import failed");
      }
      res.status(200).json({ draft: result.draft });
      return;
    }

    res.status(200).json({ results });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "Import failed" });
  }
}
