import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  Bell,
  BarChart3,
  CalendarDays,
  Check,
  ChevronRight,
  Clock3,
  Database,
  ExternalLink,
  Filter,
  Heart,
  Lock,
  Mail,
  MapPin,
  Plane,
  Plus,
  Search,
  ShieldCheck,
  SlidersHorizontal,
  Smartphone,
  Ticket,
  Wand2,
  X,
} from "lucide-react";
import { seedEvents } from "./data/seedEvents";
import type { Event, EventApiResponse, TicketAccess } from "./types/events";
import "./styles.css";

type DateWindow = "전체" | "60일 이내" | "90일 이내" | "여름 원정";
type SaleStatus = "전체" | "오픈 예정" | "판매 중" | "판매 종료" | "확인 필요";
type Route = "app" | "admin";
type AdminEventDraft = {
  artist: string;
  title: string;
  city: string;
  venue: string;
  date: string;
  time: string;
  genre: string;
  source: string;
  ticketAccess: TicketAccess;
  saleType: "추첨 접수" | "일반 판매" | "선착 판매" | "해외 판매";
  saleWindow: string;
  price: string;
  phoneRequired: boolean;
  foreignerNote: string;
  link: string;
  image: string;
};
type AdminEventSummary = {
  id: string;
  artist: string;
  title: string;
  city: string;
  venue: string;
  date: string;
  source: string;
  updated_at: string;
};
type ImportedEventDraft = Partial<Omit<AdminEventDraft, "ticketAccess" | "saleType" | "phoneRequired">>;
type ImportCandidate = {
  id: string;
  url: string;
  draft: ImportedEventDraft;
  createdAt: string;
  storage: "local" | "db";
  source?: string;
};
type CandidateApiItem = {
  id: string;
  source: string;
  sourceUrl: string | null;
  draft: ImportedEventDraft;
  status: "pending" | "approved" | "rejected";
  createdAt: string;
};
type AdminStats = {
  totalEvents: number;
  pendingCandidates: number | null;
  candidateTableReady: boolean;
  alertQueue: {
    activeDue: number;
    activeScheduled: number;
    error: number;
    sent: number;
    lastErrorAt: string | null;
  } | null;
  quality: {
    missingLink: number;
    missingSaleWindow: number;
    missingPrice: number;
    needsAccessReview: number;
    phoneRequired: number;
    koreaFriendly: number;
  };
  bySource: Array<{ label: string; count: number }>;
  byCity: Array<{ label: string; count: number }>;
  generatedAt: string;
};

const accessOptions: Array<TicketAccess | "전체"> = [
  "전체",
  "한국 구매 가능",
  "일본 번호 필요",
  "확인 필요",
];
const dateWindowOptions: DateWindow[] = ["전체", "60일 이내", "90일 이내", "여름 원정"];
const saleStatusOptions: SaleStatus[] = ["전체", "오픈 예정", "판매 중", "판매 종료", "확인 필요"];
const today = new Date("2026-05-04T00:00:00+09:00");
const useSeedData = import.meta.env.VITE_USE_SEED_DATA === "true";
const savedEventsStorageKey = "japan-live-radar.saved-events";
const alertClientStorageKey = "japan-live-radar.alert-client";
const alertEmailStorageKey = "japan-live-radar.alert-email";
const adminTokenStorageKey = "japan-live-radar.admin-token";
const importCandidatesStorageKey = "japan-live-radar.import-candidates";
const blankAdminEvent: AdminEventDraft = {
  artist: "",
  title: "",
  city: "도쿄",
  venue: "",
  date: "",
  time: "",
  genre: "Music",
  source: "Manual",
  ticketAccess: "확인 필요",
  saleType: "일반 판매",
  saleWindow: "",
  price: "",
  phoneRequired: true,
  foreignerNote: "",
  link: "",
  image: "",
};
const koreanSearchAliases: Array<[string, string[]]> = [
  ["yoasobi", ["요아소비", "요아소비라이브", "요아소비콘서트"]],
  ["one ok rock", ["원오크락", "원오크록", "원오크", "원오케이락", "원오케이록"]],
  ["ado", ["아도", "아도콘서트"]],
  ["newjeans", ["뉴진스", "뉴진스콘서트"]],
  ["radwimps", ["래드윔프스", "라드윔프스"]],
  ["king gnu", ["킹누", "킹그누"]],
  ["米津玄師", ["요네즈켄시", "요네즈 켄시"]],
  ["宇多田ヒカル", ["우타다히카루", "우타다 히카루"]],
  ["tokyo dome", ["도쿄돔", "도쿄 돔"]],
  ["osaka-jō hall", ["오사카성홀", "오사카 성 홀", "오사카조홀"]],
  ["k-arena yokohama", ["케이아레나요코하마", "케이 아레나 요코하마"]],
  ["marine messe fukuoka", ["마린멧세후쿠오카", "마린 멧세 후쿠오카"]],
  ["nippon gaishi hall", ["니폰가이시홀", "일본가이시홀"]],
  ["ticket pia", ["티켓피아", "피아"]],
  ["e+", ["이플러스", "이 플러스", "eplus"]],
  ["lawson ticket", ["로치케", "로손티켓", "로손 티켓"]],
  ["ticketmaster", ["티켓마스터"]],
];

function currentRoute(): Route {
  return window.location.hash === "#admin" ? "admin" : "app";
}

function loadSavedEventIds() {
  try {
    const savedValue = window.localStorage.getItem(savedEventsStorageKey);
    const parsedValue = savedValue ? (JSON.parse(savedValue) as unknown) : null;
    if (Array.isArray(parsedValue) && parsedValue.every((value) => typeof value === "string")) {
      return parsedValue;
    }
  } catch {
    // Local storage can be blocked in private or embedded browsing contexts.
  }

  return [seedEvents[3].id];
}

function loadAlertClientId() {
  try {
    const savedValue = window.localStorage.getItem(alertClientStorageKey);
    if (savedValue) return savedValue;
    const nextValue = crypto.randomUUID();
    window.localStorage.setItem(alertClientStorageKey, nextValue);
    return nextValue;
  } catch {
    return "local-alert-client";
  }
}

function loadAlertEmail() {
  try {
    return window.localStorage.getItem(alertEmailStorageKey) ?? "";
  } catch {
    return "";
  }
}

function loadImportCandidates() {
  try {
    const savedValue = window.localStorage.getItem(importCandidatesStorageKey);
    const parsedValue = savedValue ? (JSON.parse(savedValue) as unknown) : null;
    if (Array.isArray(parsedValue)) {
      return parsedValue.filter((value): value is ImportCandidate => {
        return Boolean(
          value &&
            typeof value === "object" &&
            typeof (value as ImportCandidate).id === "string" &&
            typeof (value as ImportCandidate).url === "string" &&
            typeof (value as ImportCandidate).createdAt === "string",
        );
      }).map((candidate) => ({ ...candidate, storage: "local" as const }));
    }
  } catch {
    // Ignore invalid local candidate cache.
  }

  return [];
}

function toCandidate(apiItem: CandidateApiItem): ImportCandidate {
  return {
    id: apiItem.id,
    url: apiItem.sourceUrl ?? String(apiItem.draft.link ?? ""),
    draft: apiItem.draft,
    createdAt: apiItem.createdAt,
    storage: "db",
    source: apiItem.source,
  };
}

function urlsFromText(value: string) {
  return value
    .split(/[\n,]+/)
    .map((url) => url.trim())
    .filter(Boolean)
    .slice(0, 10);
}

function normalizeSearchValue(value: string) {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}+]+/gu, "");
}

function searchVariants(value: string) {
  const normalized = normalizeSearchValue(value);
  const variants = new Set([normalized]);
  for (const [canonical, aliases] of koreanSearchAliases) {
    const canonicalNormalized = normalizeSearchValue(canonical);
    const aliasValues = aliases.map(normalizeSearchValue);
    if (normalized === canonicalNormalized || aliasValues.includes(normalized)) {
      variants.add(canonicalNormalized);
      for (const alias of aliasValues) variants.add(alias);
    }
  }
  return Array.from(variants).filter(Boolean);
}

function eventSearchText(event: Event) {
  const baseValues = [
    event.artist,
    event.title,
    event.city,
    event.venue,
    event.genre,
    event.source,
    event.ticketAccess,
    event.saleType,
  ];
  const aliases = koreanSearchAliases.flatMap(([canonical, values]) => {
    const eventValues = baseValues.map(normalizeSearchValue);
    return eventValues.some((value) => value.includes(normalizeSearchValue(canonical)))
      ? values
      : [];
  });
  return [...baseValues, ...aliases].map(normalizeSearchValue).join(" ");
}

function isInDateWindow(date: string, dateWindow: DateWindow) {
  if (dateWindow === "전체") return true;

  const eventDate = new Date(`${date}T00:00:00+09:00`);
  if (dateWindow === "여름 원정") {
    return eventDate >= new Date("2026-06-01T00:00:00+09:00") &&
      eventDate <= new Date("2026-08-31T23:59:59+09:00");
  }

  const limitDays = dateWindow === "60일 이내" ? 60 : 90;
  const limit = new Date(today);
  limit.setDate(today.getDate() + limitDays);
  return eventDate >= today && eventDate <= limit;
}

function parseSaleWindowDateParts(year: number, month: string, day: string, hour?: string, minute?: string) {
  return new Date(
    `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}T${(hour ?? "00").padStart(2, "0")}:${minute ?? "00"}:00+09:00`,
  );
}

function getSaleWindowDates(saleWindow: string, eventDate: string) {
  const eventYear = Number(eventDate.slice(0, 4)) || today.getFullYear();
  const explicitYearMatches = Array.from(
    saleWindow.matchAll(/(\d{4})\s*[年/.-]\s*(\d{1,2})\s*[月/.-]\s*(\d{1,2})(?:日)?(?:\([^)]*\))?\s*(?:(\d{1,2}):(\d{2}))?/g),
  );

  if (explicitYearMatches.length > 0) {
    return explicitYearMatches.map((match) =>
      parseSaleWindowDateParts(Number(match[1]), match[2], match[3], match[4], match[5]),
    );
  }

  return Array.from(
    saleWindow.matchAll(/(^|[^\d])(\d{1,2})[./月]\s*(\d{1,2})(?:日)?(?:\([^)]*\))?\s*(?:(\d{1,2}):(\d{2}))?/g),
  ).map((match) => parseSaleWindowDateParts(eventYear, match[2], match[3], match[4], match[5]));
}

function getSaleStatus(event: Event): Exclude<SaleStatus, "전체"> {
  if (!event.saleWindow.trim()) return "확인 필요";

  const [startDate, endDate] = getSaleWindowDates(event.saleWindow, event.date);
  if (!startDate) return "확인 필요";
  if (today < startDate) return "오픈 예정";
  if (endDate && today > endDate) return "판매 종료";
  return "판매 중";
}

function App() {
  const [route, setRoute] = useState<Route>(currentRoute);
  const [events, setEvents] = useState<Event[]>(seedEvents);
  const [dataSource, setDataSource] = useState<EventApiResponse["source"]>("seed");
  const [lastSyncLabel, setLastSyncLabel] = useState("샘플 데이터");
  const [query, setQuery] = useState("");
  const [city, setCity] = useState<Event["city"] | "전체">("전체");
  const [access, setAccess] = useState<TicketAccess | "전체">("전체");
  const [dateWindow, setDateWindow] = useState<DateWindow>("전체");
  const [saleStatus, setSaleStatus] = useState<SaleStatus>("전체");
  const [koreaFriendlyOnly, setKoreaFriendlyOnly] = useState(false);
  const [selectedId, setSelectedId] = useState(seedEvents[0].id);
  const [saved, setSaved] = useState<string[]>(loadSavedEventIds);
  const [alertClientId] = useState(loadAlertClientId);
  const [alertEmail, setAlertEmail] = useState(loadAlertEmail);
  const [alertsOpen, setAlertsOpen] = useState(false);

  const cityOptions = useMemo(
    () => ["전체", ...Array.from(new Set(events.map((event) => event.city))).sort((a, b) => a.localeCompare(b, "ko"))],
    [events],
  );

  useEffect(() => {
    const handleHashChange = () => setRoute(currentRoute());
    window.addEventListener("hashchange", handleHashChange);
    return () => window.removeEventListener("hashchange", handleHashChange);
  }, []);

  useEffect(() => {
    if (useSeedData) return;

    let ignore = false;

    async function loadEvents() {
      try {
        const response = await fetch("/api/events");
        if (!response.ok) return;
        const data = (await response.json()) as EventApiResponse;
        if (!ignore && data.events.length > 0) {
          setEvents(data.events);
          setDataSource(data.source);
          setLastSyncLabel(
            data.meta?.lastSync
              ? `${data.meta.lastSync.source} ${data.meta.lastSync.upsertedCount}건 동기화`
              : data.source === "supabase"
                ? "DB 데이터"
                : "샘플 데이터",
          );
          setSelectedId((current) =>
            data.events.some((event) => event.id === current) ? current : data.events[0].id,
          );
        }
      } catch {
        // Vite's local dev server does not serve Vercel API routes, so the seed data remains active.
      }
    }

    void loadEvents();
    return () => {
      ignore = true;
    };
  }, []);

  useEffect(() => {
    if (city !== "전체" && !events.some((event) => event.city === city)) {
      setCity("전체");
    }
  }, [city, events]);

  useEffect(() => {
    window.localStorage.setItem(savedEventsStorageKey, JSON.stringify(saved));
  }, [saved]);

  useEffect(() => {
    window.localStorage.setItem(alertEmailStorageKey, alertEmail.trim());
  }, [alertEmail]);

  const filteredEvents = useMemo(() => {
    const queryVariants = searchVariants(query);
    return events.filter((event) => {
      const text = eventSearchText(event);
      const queryMatch = queryVariants.length === 0 || queryVariants.some((variant) => text.includes(variant));
      const cityMatch = city === "전체" || event.city === city;
      const accessMatch = access === "전체" || event.ticketAccess === access;
      const dateMatch = isInDateWindow(event.date, dateWindow);
      const saleStatusMatch = saleStatus === "전체" || getSaleStatus(event) === saleStatus;
      const koreaFriendlyMatch =
        !koreaFriendlyOnly || (event.ticketAccess === "한국 구매 가능" && !event.phoneRequired);
      return queryMatch && cityMatch && accessMatch && dateMatch && saleStatusMatch && koreaFriendlyMatch;
    });
  }, [access, city, dateWindow, events, koreaFriendlyOnly, query, saleStatus]);

  const savedEventItems = useMemo(
    () => saved
      .map((id) => events.find((event) => event.id === id))
      .filter((event): event is Event => Boolean(event)),
    [events, saved],
  );

  const selectedEvent = filteredEvents.find((event) => event.id === selectedId) ?? filteredEvents[0];
  const heroEvent = selectedEvent ?? events[0];

  const syncAlertSubscription = async (event: Event, active: boolean) => {
    if (useSeedData) return;
    try {
      await fetch("/api/alerts", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          clientId: alertClientId,
          active,
          contactEmail: alertEmail.trim(),
          event: {
            id: event.id,
            artist: event.artist,
            title: event.title,
            date: event.date,
            saleWindow: event.saleWindow,
            link: event.link,
          },
        }),
      });
    } catch {
      // The local reminder state remains useful if the backend is unavailable.
    }
  };

  const toggleSaved = (id: string) => {
    const event = events.find((item) => item.id === id);
    const nextActive = !saved.includes(id);
    setSaved((current) =>
      current.includes(id) ? current.filter((savedId) => savedId !== id) : [...current, id],
    );
    if (event) {
      void syncAlertSubscription(event, nextActive);
    }
  };

  const saveAlertEmail = () => {
    for (const event of savedEventItems) {
      void syncAlertSubscription(event, true);
    }
  };

  if (route === "admin") {
    return <AdminPage />;
  }

  return (
    <main className="app-shell">
      <section className="workspace">
        <header className="topbar">
          <div>
            <div className="brand-row">
              <Plane size={20} />
              <span>Japan Live Radar</span>
            </div>
            <h1>일본 콘서트 원정 캘린더</h1>
          </div>
          <button
            className="icon-button"
            aria-controls="saved-alerts-panel"
            aria-expanded={alertsOpen}
            aria-label={`알림 ${savedEventItems.length}개`}
            onClick={() => setAlertsOpen((current) => !current)}
            type="button"
          >
            <Bell size={20} />
            {savedEventItems.length > 0 && <span className="alert-count">{savedEventItems.length}</span>}
          </button>
        </header>

        {alertsOpen && (
          <SavedAlertsPanel
            events={savedEventItems}
            email={alertEmail}
            onClose={() => setAlertsOpen(false)}
            onEmailChange={setAlertEmail}
            onSaveEmail={saveAlertEmail}
            onRemove={toggleSaved}
            onSelect={(id) => {
              setSelectedId(id);
              setAlertsOpen(false);
            }}
          />
        )}

        <section className="hero-strip" aria-label="추천 공연">
          <img src={heroEvent.image} alt="" />
          <div className="hero-copy">
            <span>{heroEvent.city} · {heroEvent.genre}</span>
            <strong>{heroEvent.artist}</strong>
            <p>{heroEvent.date.replaceAll("-", ".")} · {heroEvent.venue}</p>
          </div>
        </section>

        <section className="filters" aria-label="공연 필터">
          <label className="search-field">
            <Search size={18} />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="아티스트, 공연명, 회장 검색"
            />
            {query && (
              <button aria-label="검색어 지우기" onClick={() => setQuery("")}>
                <X size={16} />
              </button>
            )}
          </label>

          <div className="filter-grid">
            <label>
              <Filter size={15} />
              <select
                value={city}
                onChange={(event) => setCity(event.target.value as Event["city"] | "전체")}
              >
                {cityOptions.map((option) => (
                  <option key={option}>{option}</option>
                ))}
              </select>
            </label>
            <label>
              <Ticket size={15} />
              <select
                value={access}
                onChange={(event) => setAccess(event.target.value as TicketAccess | "전체")}
              >
                {accessOptions.map((option) => (
                  <option key={option}>{option}</option>
                ))}
              </select>
            </label>
            <label>
              <CalendarDays size={15} />
              <select
                value={dateWindow}
                onChange={(event) => setDateWindow(event.target.value as DateWindow)}
              >
                {dateWindowOptions.map((option) => (
                  <option key={option}>{option}</option>
                ))}
              </select>
            </label>
            <label>
              <Clock3 size={15} />
              <select
                value={saleStatus}
                onChange={(event) => setSaleStatus(event.target.value as SaleStatus)}
                aria-label="판매 상태"
              >
                {saleStatusOptions.map((option) => (
                  <option key={option}>{option}</option>
                ))}
              </select>
            </label>
          </div>
        </section>

        <section className="quick-filters" aria-label="원정 조건">
          <button
            className={koreaFriendlyOnly ? "active" : ""}
            type="button"
            onClick={() => setKoreaFriendlyOnly((current) => !current)}
          >
            <ShieldCheck size={16} />
            한국에서 예매 쉬운 공연
          </button>
          <button type="button" onClick={() => setDateWindow("여름 원정")}>
            <Plane size={16} />
            여름 원정
          </button>
          <button
            type="button"
            onClick={() => {
              setQuery("");
              setCity("전체");
              setAccess("전체");
              setDateWindow("전체");
              setSaleStatus("전체");
              setKoreaFriendlyOnly(false);
            }}
          >
            <SlidersHorizontal size={16} />
            초기화
          </button>
        </section>

        <section className="content-grid">
          <div className="event-list" aria-label="공연 목록">
            <div className="list-summary">
              <strong>{filteredEvents.length}개 공연</strong>
              <span>{koreaFriendlyOnly ? "예매 쉬운 공연" : "한국 출발 기준"}</span>
            </div>
            <div className={`data-source ${dataSource}`}>
              <span>{dataSource === "supabase" ? "실시간 DB" : "샘플 데이터"}</span>
              <strong>{lastSyncLabel}</strong>
            </div>
            {filteredEvents.length === 0 && (
              <div className="empty-state">
                <strong>조건에 맞는 공연이 없어요</strong>
                <span>기간이나 티켓 조건을 넓혀 다시 찾아보세요.</span>
              </div>
            )}
            {filteredEvents.map((event) => (
              <button
                className={`event-card ${selectedEvent && event.id === selectedEvent.id ? "active" : ""}`}
                key={event.id}
                onClick={() => setSelectedId(event.id)}
              >
                <img src={event.image} alt="" />
                <div className="event-card-body">
                  <div className="event-card-title">
                    <strong>{event.artist}</strong>
                    <span>{event.title}</span>
                  </div>
                  <div className="meta-row">
                    <CalendarDays size={14} />
                    {event.date.replaceAll("-", ".")} · {event.time}
                  </div>
                  <div className="meta-row">
                    <MapPin size={14} />
                    {event.city} · {event.venue}
                  </div>
                  <div className="tag-row">
                    <StatusPill status={event.ticketAccess} />
                    <span className="mini-pill">{event.saleType}</span>
                    <SaleStatusPill status={getSaleStatus(event)} />
                  </div>
                </div>
                <ChevronRight className="card-arrow" size={18} />
              </button>
            ))}
          </div>

          {selectedEvent ? (
            <EventDetail
              event={selectedEvent}
              saved={saved.includes(selectedEvent.id)}
              onSave={toggleSaved}
            />
          ) : (
            <aside className="detail-panel empty-detail" aria-label="공연 상세">
              <ShieldCheck size={28} />
              <strong>원정 조건을 조금 넓혀볼까요?</strong>
              <span>한국 구매 가능 여부, 일본 전화번호 필요 여부, 날짜 조건을 조합해 찾을 수 있어요.</span>
            </aside>
          )}
        </section>
      </section>
    </main>
  );
}

function SavedAlertsPanel({
  events,
  email,
  onClose,
  onEmailChange,
  onSaveEmail,
  onRemove,
  onSelect,
}: {
  events: Event[];
  email: string;
  onClose: () => void;
  onEmailChange: (email: string) => void;
  onSaveEmail: () => void;
  onRemove: (id: string) => void;
  onSelect: (id: string) => void;
}) {
  return (
    <section className="saved-alerts-panel" id="saved-alerts-panel" aria-label="저장한 알림">
      <div className="list-summary">
        <strong>저장한 알림</strong>
        <button className="icon-button" aria-label="알림 패널 닫기" onClick={onClose} type="button">
          <X size={17} />
        </button>
      </div>
      {events.length === 0 ? (
        <div className="empty-state">
          <strong>저장한 공연이 없어요</strong>
          <span>관심 공연에서 일정 알림을 누르면 여기에서 다시 확인할 수 있어요.</span>
        </div>
      ) : (
        <>
          <label className="alert-email-field">
            <Mail size={16} />
            <input
              value={email}
              onChange={(event) => onEmailChange(event.target.value)}
              onBlur={onSaveEmail}
              placeholder="알림 받을 이메일"
              type="email"
            />
            <button className="secondary-button" onClick={onSaveEmail} type="button">
              저장
            </button>
          </label>
          <div className="saved-alert-list">
            {events.map((event) => (
              <article className="saved-alert-item" key={event.id}>
                <button
                  type="button"
                  aria-label={`${event.artist} 알림 공연 열기`}
                  onClick={() => onSelect(event.id)}
                >
                  <span>{event.date.replaceAll("-", ".")} · {event.city}</span>
                  <strong>{event.artist}</strong>
                  <small>{event.saleWindow}</small>
                </button>
                <button
                  className="icon-button"
                  aria-label={`${event.artist} 알림 해제`}
                  onClick={() => onRemove(event.id)}
                  type="button"
                >
                  <X size={17} />
                </button>
              </article>
            ))}
          </div>
        </>
      )}
    </section>
  );
}

function AdminPage() {
  const [token, setToken] = useState(() => window.localStorage.getItem(adminTokenStorageKey) ?? "");
  const [draft, setDraft] = useState<AdminEventDraft>(blankAdminEvent);
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [message, setMessage] = useState("");
  const [recentEvents, setRecentEvents] = useState<AdminEventSummary[]>([]);
  const [recentStatus, setRecentStatus] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [importUrl, setImportUrl] = useState("");
  const [importStatus, setImportStatus] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [importMessage, setImportMessage] = useState("");
  const [searchKeyword, setSearchKeyword] = useState("");
  const [searchStatus, setSearchStatus] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [searchMessage, setSearchMessage] = useState("");
  const [importCandidates, setImportCandidates] = useState<ImportCandidate[]>(loadImportCandidates);
  const [candidateStatus, setCandidateStatus] = useState<"idle" | "loading" | "ready" | "local" | "error">("idle");
  const [adminStats, setAdminStats] = useState<AdminStats | null>(null);
  const [statsStatus, setStatsStatus] = useState<"idle" | "loading" | "ready" | "error">("idle");

  const updateDraft = <Key extends keyof AdminEventDraft>(key: Key, value: AdminEventDraft[Key]) => {
    setDraft((current) => ({ ...current, [key]: value }));
  };

  const fetchRecentEvents = async (activeToken = token) => {
    if (!activeToken) return;
    setRecentStatus("loading");
    try {
      const response = await fetch("/api/admin-events", {
        headers: {
          "x-admin-token": activeToken,
        },
      });
      const payload = (await response.json()) as { events?: AdminEventSummary[]; error?: string };
      if (!response.ok) {
        throw new Error(payload.error ?? "목록 조회 실패");
      }
      setRecentEvents(payload.events ?? []);
      setRecentStatus("ready");
    } catch {
      setRecentStatus("error");
    }
  };

  const fetchCandidates = async (activeToken = token) => {
    if (!activeToken) return;
    setCandidateStatus("loading");
    try {
      const response = await fetch("/api/admin-candidates", {
        headers: {
          "x-admin-token": activeToken,
        },
      });
      const payload = (await response.json()) as {
        configured?: boolean;
        candidates?: CandidateApiItem[];
        error?: string;
      };
      if (!response.ok) {
        throw new Error(payload.error ?? "후보 조회 실패");
      }
      if (payload.configured === false) {
        setCandidateStatus("local");
        return;
      }
      setImportCandidates((current) => {
        const localCandidates = current.filter((candidate) => candidate.storage === "local");
        return [...(payload.candidates ?? []).map(toCandidate), ...localCandidates].slice(0, 50);
      });
      setCandidateStatus("ready");
    } catch {
      setCandidateStatus("error");
    }
  };

  const fetchStats = async (activeToken = token) => {
    if (!activeToken) return;
    setStatsStatus("loading");
    try {
      const response = await fetch("/api/admin-stats", {
        headers: {
          "x-admin-token": activeToken,
        },
      });
      const payload = (await response.json()) as AdminStats & { error?: string };
      if (!response.ok) {
        throw new Error(payload.error ?? "품질 지표 조회 실패");
      }
      setAdminStats(payload);
      setStatsStatus("ready");
    } catch {
      setStatsStatus("error");
    }
  };

  const submitEvent = async (event: React.FormEvent) => {
    event.preventDefault();
    setStatus("saving");
    setMessage("");
    window.localStorage.setItem(adminTokenStorageKey, token);

    try {
      const response = await fetch("/api/admin-events", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-admin-token": token,
        },
        body: JSON.stringify(draft),
      });
      const payload = (await response.json()) as { error?: string };
      if (!response.ok) {
        throw new Error(payload.error ?? "저장 실패");
      }
      setStatus("saved");
      setMessage("공연 정보가 저장됐어요.");
      setDraft(blankAdminEvent);
      await Promise.all([fetchRecentEvents(token), fetchStats(token)]);
    } catch (error) {
      setStatus("error");
      setMessage(error instanceof Error ? error.message : "저장 실패");
    }
  };

  const importFromUrl = async () => {
    if (!importUrl.trim()) return;
    setImportStatus("loading");
    setImportMessage("");
    window.localStorage.setItem(adminTokenStorageKey, token);

    try {
      const response = await fetch("/api/import-url", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-admin-token": token,
        },
        body: JSON.stringify({ urls: urlsFromText(importUrl) }),
      });
      const payload = (await response.json()) as {
        results?: Array<{ url: string; draft?: ImportedEventDraft; error?: string }>;
        error?: string;
      };
      if (!response.ok || !payload.results) {
        throw new Error(payload.error ?? "URL 가져오기 실패");
      }
      const importedCandidates = payload.results
        .filter((result): result is { url: string; draft: ImportedEventDraft } => Boolean(result.draft))
        .map((result): ImportCandidate => ({
          id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
          url: result.url,
          draft: result.draft,
          createdAt: new Date().toISOString(),
          storage: "local",
        }));
      if (importedCandidates.length === 0) {
        throw new Error(payload.results.find((result) => result.error)?.error ?? "가져올 수 있는 초안이 없어요");
      }

      let finalCandidates = importedCandidates;
      try {
        const candidateResponse = await fetch("/api/admin-candidates", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-admin-token": token,
          },
          body: JSON.stringify({
            candidates: importedCandidates.map((candidate) => ({
              source: candidate.draft.source,
              sourceUrl: candidate.url,
              draft: candidate.draft,
            })),
          }),
        });
        const candidatePayload = (await candidateResponse.json()) as {
          candidates?: CandidateApiItem[];
          configured?: boolean;
        };
        if (candidateResponse.ok && candidatePayload.configured !== false && candidatePayload.candidates) {
          finalCandidates = candidatePayload.candidates.map(toCandidate);
          setCandidateStatus("ready");
        } else {
          setCandidateStatus("local");
        }
      } catch {
        setCandidateStatus("local");
      }

      setImportCandidates((current) => {
        const existingIds = new Set(finalCandidates.map((candidate) => candidate.id));
        return [...finalCandidates, ...current.filter((candidate) => !existingIds.has(candidate.id))].slice(0, 50);
      });
      applyCandidate(finalCandidates[0]);
      setImportStatus("ready");
      setImportMessage(`${finalCandidates.length}개 URL 초안을 후보에 추가했어요.`);
    } catch (error) {
      setImportStatus("error");
      setImportMessage(error instanceof Error ? error.message : "URL 가져오기 실패");
    }
  };

  const applyCandidate = (candidate: ImportCandidate) => {
    setDraft((current) => ({
      ...current,
      ...Object.fromEntries(
        Object.entries(candidate.draft).filter(([, value]) => typeof value === "string" && value.trim().length > 0),
      ),
    }));
  };

  const candidateReadyForApproval = (candidate: ImportCandidate) => {
    const appliedDraft = { ...blankAdminEvent, ...candidate.draft };
    return Boolean(
      appliedDraft.artist.trim() &&
        appliedDraft.title.trim() &&
        appliedDraft.city.trim() &&
        appliedDraft.venue.trim() &&
        appliedDraft.date.trim(),
    );
  };

  const removeCandidate = (id: string) => {
    setImportCandidates((current) => current.filter((candidate) => candidate.id !== id));
  };

  const approveCandidate = async (candidate: ImportCandidate) => {
    applyCandidate(candidate);
    if (candidate.storage === "local" || !candidateReadyForApproval(candidate)) {
      removeCandidate(candidate.id);
      setMessage("후보를 입력폼에 적용했어요. 빈 항목을 채운 뒤 공연 저장을 누르세요.");
      setStatus("idle");
      return;
    }

    setStatus("saving");
    setMessage("");
    try {
      const response = await fetch("/api/admin-candidates", {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          "x-admin-token": token,
        },
        body: JSON.stringify({
          id: candidate.id,
          action: "approve",
          draft: { ...blankAdminEvent, ...candidate.draft },
        }),
      });
      const payload = (await response.json()) as { error?: string };
      if (!response.ok) {
        throw new Error(payload.error ?? "후보 승인 실패");
      }
      removeCandidate(candidate.id);
      setStatus("saved");
      setMessage("후보를 승인하고 공연으로 저장했어요.");
      await Promise.all([fetchRecentEvents(token), fetchCandidates(token), fetchStats(token)]);
    } catch (error) {
      setStatus("error");
      setMessage(error instanceof Error ? error.message : "후보 승인 실패");
    }
  };

  const collectKeywordCandidates = async () => {
    if (!searchKeyword.trim()) return;
    setSearchStatus("loading");
    setSearchMessage("");
    window.localStorage.setItem(adminTokenStorageKey, token);

    try {
      const response = await fetch("/api/search-candidates", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-admin-token": token,
        },
        body: JSON.stringify({ keyword: searchKeyword }),
      });
      const payload = (await response.json()) as {
        configured?: boolean;
        candidates?: CandidateApiItem[];
        error?: string;
      };
      if (!response.ok || !payload.candidates) {
        throw new Error(payload.error ?? "검색 후보 생성 실패");
      }

      const nextCandidates = payload.candidates.map((candidate) => ({
        ...toCandidate(candidate),
        storage: payload.configured === false ? "local" as const : "db" as const,
      }));
      setImportCandidates((current) => {
        const existingIds = new Set(nextCandidates.map((candidate) => candidate.id));
        return [...nextCandidates, ...current.filter((candidate) => !existingIds.has(candidate.id))].slice(0, 50);
      });
      setCandidateStatus(payload.configured === false ? "local" : "ready");
      setSearchStatus("ready");
      setSearchMessage(`${nextCandidates.length}개 검색 후보를 만들었어요.`);
    } catch (error) {
      setSearchStatus("error");
      setSearchMessage(error instanceof Error ? error.message : "검색 후보 생성 실패");
    }
  };

  const rejectCandidate = async (candidate: ImportCandidate) => {
    if (candidate.storage === "local") {
      removeCandidate(candidate.id);
      return;
    }

    setCandidateStatus("loading");
    try {
      const response = await fetch("/api/admin-candidates", {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          "x-admin-token": token,
        },
        body: JSON.stringify({ id: candidate.id, action: "reject", reason: "관리자 화면에서 제외" }),
      });
      if (!response.ok) {
        throw new Error("후보 제외 실패");
      }
      removeCandidate(candidate.id);
      setCandidateStatus("ready");
    } catch {
      setCandidateStatus("error");
    }
  };

  useEffect(() => {
    if (token) {
      void fetchRecentEvents(token);
      void fetchCandidates(token);
      void fetchStats(token);
    }
  }, []);

  useEffect(() => {
    window.localStorage.setItem(
      importCandidatesStorageKey,
      JSON.stringify(importCandidates.filter((candidate) => candidate.storage === "local")),
    );
  }, [importCandidates]);

  return (
    <main className="app-shell admin-shell">
      <section className="workspace">
        <header className="topbar">
          <div>
            <div className="brand-row">
              <Database size={20} />
              <span>Japan Live Radar Admin</span>
            </div>
            <h1>공연 정보 입력</h1>
          </div>
          <a className="icon-button" aria-label="앱으로 돌아가기" href="#">
            <ChevronRight size={20} />
          </a>
        </header>

        <section className="admin-stats" aria-label="데이터 품질">
          <div className="list-summary">
            <strong><BarChart3 size={18} /> 데이터 품질</strong>
            <button className="secondary-button" type="button" onClick={() => fetchStats()}>
              {statsStatus === "loading" ? "확인 중" : "새로고침"}
            </button>
          </div>
          {statsStatus === "error" && <div className="empty-state">품질 지표를 불러오지 못했어요.</div>}
          {adminStats ? (
            <>
              <div className="stat-grid">
                <AdminStat label="공연" value={`${adminStats.totalEvents}개`} />
                <AdminStat
                  label="후보"
                  value={adminStats.pendingCandidates === null ? "테이블 준비 전" : `${adminStats.pendingCandidates}개`}
                />
                <AdminStat label="링크 누락" value={`${adminStats.quality.missingLink}개`} />
                <AdminStat label="예매 확인 필요" value={`${adminStats.quality.needsAccessReview}개`} />
                <AdminStat label="일본 번호 필요" value={`${adminStats.quality.phoneRequired}개`} />
                <AdminStat label="한국 구매 가능" value={`${adminStats.quality.koreaFriendly}개`} />
                <AdminStat
                  label="알림 대기"
                  value={adminStats.alertQueue === null ? "테이블 준비 전" : `${adminStats.alertQueue.activeDue}개`}
                />
                <AdminStat
                  label="알림 오류"
                  value={adminStats.alertQueue === null ? "테이블 준비 전" : `${adminStats.alertQueue.error}개`}
                />
              </div>
              <div className="quality-breakdown">
                <div>
                  <strong>출처</strong>
                  {(adminStats.bySource.length ? adminStats.bySource : [{ label: "데이터 없음", count: 0 }]).map((item) => (
                    <span key={item.label}>{item.label} · {item.count}</span>
                  ))}
                </div>
                <div>
                  <strong>도시</strong>
                  {(adminStats.byCity.length ? adminStats.byCity : [{ label: "데이터 없음", count: 0 }]).map((item) => (
                    <span key={item.label}>{item.label} · {item.count}</span>
                  ))}
                </div>
              </div>
            </>
          ) : (
            <div className="empty-state">관리자 토큰을 입력하고 품질 지표를 새로고침하세요.</div>
          )}
        </section>

        <section className="admin-import" aria-label="URL로 가져오기">
          <label className="admin-field">
            <span><Wand2 size={15} /> URL로 초안 가져오기</span>
            <input
              value={importUrl}
              onChange={(event) => setImportUrl(event.target.value)}
              placeholder="티켓/공연 페이지 URL, 여러 개는 줄바꿈"
            />
          </label>
          <button className="secondary-button" disabled={importStatus === "loading"} type="button" onClick={importFromUrl}>
            <Wand2 size={17} />
            {importStatus === "loading" ? "가져오는 중" : "가져오기"}
          </button>
          {importMessage && (
            <span className={importStatus === "error" ? "admin-error" : "admin-success"}>{importMessage}</span>
          )}
        </section>

        <section className="admin-import" aria-label="검색어 후보 만들기">
          <label className="admin-field">
            <span><Search size={15} /> 검색어 후보 수집</span>
            <input
              value={searchKeyword}
              onChange={(event) => setSearchKeyword(event.target.value)}
              placeholder="예: YOASOBI, Ado, Mrs. GREEN APPLE"
            />
          </label>
          <button
            className="secondary-button"
            disabled={searchStatus === "loading"}
            type="button"
            onClick={collectKeywordCandidates}
          >
            <Search size={17} />
            {searchStatus === "loading" ? "수집 중" : "후보 만들기"}
          </button>
          {searchMessage && (
            <span className={searchStatus === "error" ? "admin-error" : "admin-success"}>{searchMessage}</span>
          )}
        </section>

        <section className="import-candidates" aria-label="URL 후보">
          <div className="list-summary">
            <strong>URL 후보</strong>
            <span>
              {candidateStatus === "loading"
                ? "동기화 중"
                : candidateStatus === "local"
                  ? `${importCandidates.length}개 · 로컬`
                  : `${importCandidates.length}개`}
            </span>
          </div>
          {importCandidates.length === 0 && <div className="empty-state">가져온 URL 초안이 여기에 쌓여요.</div>}
          {importCandidates.map((candidate) => (
            <article className="import-candidate" key={candidate.id}>
              <div>
                <strong>{candidate.draft.artist || candidate.draft.title || "제목 확인 필요"}</strong>
                <span>
                  {candidate.draft.date || "날짜 미정"} · {candidate.draft.venue || candidate.url}
                  {candidate.storage === "db" ? " · DB" : " · 로컬"}
                </span>
              </div>
              <button className="secondary-button" type="button" onClick={() => approveCandidate(candidate)}>
                {candidate.storage === "db" && candidateReadyForApproval(candidate) ? "승인 저장" : "초안 적용"}
              </button>
              <button className="icon-button" type="button" aria-label="후보 제외" onClick={() => rejectCandidate(candidate)}>
                <X size={17} />
              </button>
            </article>
          ))}
        </section>

        <form className="admin-panel" onSubmit={submitEvent}>
          <label className="admin-field full">
            <span><Lock size={15} /> 관리자 토큰</span>
            <input
              value={token}
              onChange={(event) => setToken(event.target.value)}
              type="password"
              autoComplete="current-password"
              required
            />
          </label>
          <label className="admin-field">
            <span>아티스트</span>
            <input value={draft.artist} onChange={(event) => updateDraft("artist", event.target.value)} required />
          </label>
          <label className="admin-field">
            <span>공연명</span>
            <input value={draft.title} onChange={(event) => updateDraft("title", event.target.value)} required />
          </label>
          <label className="admin-field">
            <span>도시</span>
            <input value={draft.city} onChange={(event) => updateDraft("city", event.target.value)} required />
          </label>
          <label className="admin-field">
            <span>회장</span>
            <input value={draft.venue} onChange={(event) => updateDraft("venue", event.target.value)} required />
          </label>
          <label className="admin-field">
            <span>공연일</span>
            <input value={draft.date} onChange={(event) => updateDraft("date", event.target.value)} type="date" required />
          </label>
          <label className="admin-field">
            <span>공연 시간</span>
            <input value={draft.time} onChange={(event) => updateDraft("time", event.target.value)} type="time" />
          </label>
          <label className="admin-field">
            <span>장르</span>
            <input value={draft.genre} onChange={(event) => updateDraft("genre", event.target.value)} />
          </label>
          <label className="admin-field">
            <span>출처</span>
            <input value={draft.source} onChange={(event) => updateDraft("source", event.target.value)} />
          </label>
          <label className="admin-field">
            <span>티켓 접근</span>
            <select
              value={draft.ticketAccess}
              onChange={(event) => updateDraft("ticketAccess", event.target.value as AdminEventDraft["ticketAccess"])}
            >
              {accessOptions.filter((option) => option !== "전체").map((option) => (
                <option key={option}>{option}</option>
              ))}
            </select>
          </label>
          <label className="admin-field">
            <span>판매 방식</span>
            <select
              value={draft.saleType}
              onChange={(event) => updateDraft("saleType", event.target.value as AdminEventDraft["saleType"])}
            >
              <option>추첨 접수</option>
              <option>일반 판매</option>
              <option>선착 판매</option>
              <option>해외 판매</option>
            </select>
          </label>
          <label className="admin-field">
            <span>판매 기간</span>
            <input value={draft.saleWindow} onChange={(event) => updateDraft("saleWindow", event.target.value)} />
          </label>
          <label className="admin-field">
            <span>가격</span>
            <input value={draft.price} onChange={(event) => updateDraft("price", event.target.value)} />
          </label>
          <label className="admin-field full">
            <span>원본 링크</span>
            <input value={draft.link} onChange={(event) => updateDraft("link", event.target.value)} type="url" />
          </label>
          <label className="admin-field full">
            <span>이미지 URL</span>
            <input value={draft.image} onChange={(event) => updateDraft("image", event.target.value)} type="url" />
          </label>
          <label className="admin-check full">
            <input
              checked={draft.phoneRequired}
              onChange={(event) => updateDraft("phoneRequired", event.target.checked)}
              type="checkbox"
            />
            <span>일본 전화번호 확인 필요</span>
          </label>
          <label className="admin-field full">
            <span>외국인/한국 예매 메모</span>
            <textarea
              value={draft.foreignerNote}
              onChange={(event) => updateDraft("foreignerNote", event.target.value)}
              rows={4}
            />
          </label>
          <div className="admin-actions full">
            <button className="primary-link" disabled={status === "saving"} type="submit">
              <Plus size={17} />
              {status === "saving" ? "저장 중" : "공연 저장"}
            </button>
            <button className="secondary-button" type="button" onClick={() => fetchRecentEvents()}>
              <Database size={17} />
              최근 목록
            </button>
            <button className="secondary-button" type="button" onClick={() => fetchCandidates()}>
              <Wand2 size={17} />
              후보 새로고침
            </button>
            {message && <span className={status === "error" ? "admin-error" : "admin-success"}>{message}</span>}
          </div>
        </form>

        <section className="admin-recent" aria-label="최근 입력 공연">
          <div className="list-summary">
            <strong>최근 입력 공연</strong>
            <span>{recentStatus === "loading" ? "불러오는 중" : `${recentEvents.length}개`}</span>
          </div>
          {recentStatus === "error" && <div className="empty-state">목록을 불러오지 못했어요.</div>}
          {recentStatus !== "error" && recentEvents.length === 0 && (
            <div className="empty-state">관리자 토큰을 입력하고 최근 목록을 불러오세요.</div>
          )}
          {recentEvents.map((event) => (
            <article className="recent-event" key={event.id}>
              <div>
                <strong>{event.artist}</strong>
                <span>{event.title}</span>
              </div>
              <span>{event.city} · {event.venue}</span>
              <span>{event.date.replaceAll("-", ".")} · {event.source}</span>
            </article>
          ))}
        </section>
      </section>
    </main>
  );
}

function AdminStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="admin-stat">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function StatusPill({ status }: { status: TicketAccess }) {
  const className =
    status === "한국 구매 가능" ? "safe" : status === "일본 번호 필요" ? "blocked" : "watch";
  return <span className={`status-pill ${className}`}>{status}</span>;
}

function SaleStatusPill({ status }: { status: Exclude<SaleStatus, "전체"> }) {
  const className =
    status === "판매 중" ? "safe" : status === "판매 종료" ? "blocked" : status === "오픈 예정" ? "upcoming" : "watch";
  return <span className={`sale-status-pill ${className}`}>{status}</span>;
}

function EventDetail({
  event,
  saved,
  onSave,
}: {
  event: Event;
  saved: boolean;
  onSave: (id: string) => void;
}) {
  return (
    <aside className="detail-panel" aria-label="공연 상세">
      <div className="detail-media">
        <img src={event.image} alt="" />
        <button className={`save-button ${saved ? "saved" : ""}`} onClick={() => onSave(event.id)}>
          <Heart size={17} fill={saved ? "currentColor" : "none"} />
          저장
        </button>
      </div>

      <div className="detail-body">
        <div className="source-row">
          <span>{event.source}</span>
          <StatusPill status={event.ticketAccess} />
        </div>

        <h2>{event.artist}</h2>
        <p className="detail-title">{event.title}</p>

        <div className="fact-grid">
          <Fact icon={<CalendarDays size={18} />} label="공연일" value={`${event.date.replaceAll("-", ".")} ${event.time}`} />
          <Fact icon={<MapPin size={18} />} label="도시/회장" value={`${event.city} · ${event.venue}`} />
          <Fact icon={<Ticket size={18} />} label="티켓" value={`${event.saleType} · ${event.price}`} />
          <Fact icon={<Clock3 size={18} />} label="예매 상태" value={getSaleStatus(event)} />
          <Fact icon={<Clock3 size={18} />} label="판매 기간" value={event.saleWindow} />
        </div>

        <div className="travel-check">
          <div className="check-item">
            {event.phoneRequired ? <Smartphone size={18} /> : <Check size={18} />}
            <div>
              <strong>{event.phoneRequired ? "일본 전화번호 확인 필요" : "일본 번호 없이 진행 가능성 높음"}</strong>
              <span>{event.foreignerNote}</span>
            </div>
          </div>
          <div className="check-item">
            <ShieldCheck size={18} />
            <div>
              <strong>원본 페이지 기준으로 최종 확인</strong>
              <span>판매 방식은 주최자와 플랫폼 정책에 따라 바뀔 수 있음</span>
            </div>
          </div>
        </div>

        <div className="action-row">
          <a href={event.link} target="_blank" rel="noreferrer" className="primary-link">
            원본 링크 열기
            <ExternalLink size={17} />
          </a>
          <button
            className={`secondary-button ${saved ? "active" : ""}`}
            onClick={() => onSave(event.id)}
            type="button"
          >
            {saved ? <Check size={17} /> : <Bell size={17} />}
            {saved ? "알림 설정됨" : "일정 알림"}
          </button>
        </div>
      </div>
    </aside>
  );
}

function Fact({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div className="fact">
      {icon}
      <div>
        <span>{label}</span>
        <strong>{value}</strong>
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
