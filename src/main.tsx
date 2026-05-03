import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  Bell,
  CalendarDays,
  Check,
  ChevronRight,
  Clock3,
  ExternalLink,
  Filter,
  Heart,
  MapPin,
  Plane,
  Search,
  ShieldCheck,
  SlidersHorizontal,
  Smartphone,
  Ticket,
  X,
} from "lucide-react";
import { seedEvents } from "./data/seedEvents";
import type { Event, EventApiResponse, TicketAccess } from "./types/events";
import "./styles.css";

type DateWindow = "전체" | "60일 이내" | "90일 이내" | "여름 원정";

const cityOptions: Array<Event["city"] | "전체"> = ["전체", "도쿄", "오사카", "요코하마", "나고야", "후쿠오카"];
const accessOptions: Array<TicketAccess | "전체"> = [
  "전체",
  "한국 구매 가능",
  "일본 번호 필요",
  "확인 필요",
];
const dateWindowOptions: DateWindow[] = ["전체", "60일 이내", "90일 이내", "여름 원정"];
const today = new Date("2026-05-04T00:00:00+09:00");
const useSeedData = import.meta.env.VITE_USE_SEED_DATA === "true";

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

function App() {
  const [events, setEvents] = useState<Event[]>(seedEvents);
  const [dataSource, setDataSource] = useState<EventApiResponse["source"]>("seed");
  const [lastSyncLabel, setLastSyncLabel] = useState("샘플 데이터");
  const [query, setQuery] = useState("");
  const [city, setCity] = useState<Event["city"] | "전체">("전체");
  const [access, setAccess] = useState<TicketAccess | "전체">("전체");
  const [dateWindow, setDateWindow] = useState<DateWindow>("전체");
  const [koreaFriendlyOnly, setKoreaFriendlyOnly] = useState(false);
  const [selectedId, setSelectedId] = useState(seedEvents[0].id);
  const [saved, setSaved] = useState<string[]>([seedEvents[3].id]);

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

  const filteredEvents = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return events.filter((event) => {
      const text = `${event.artist} ${event.title} ${event.venue} ${event.genre}`.toLowerCase();
      const queryMatch = !normalized || text.includes(normalized);
      const cityMatch = city === "전체" || event.city === city;
      const accessMatch = access === "전체" || event.ticketAccess === access;
      const dateMatch = isInDateWindow(event.date, dateWindow);
      const koreaFriendlyMatch =
        !koreaFriendlyOnly || (event.ticketAccess === "한국 구매 가능" && !event.phoneRequired);
      return queryMatch && cityMatch && accessMatch && dateMatch && koreaFriendlyMatch;
    });
  }, [access, city, dateWindow, koreaFriendlyOnly, query]);

  const selectedEvent = filteredEvents.find((event) => event.id === selectedId) ?? filteredEvents[0];
  const heroEvent = selectedEvent ?? events[0];

  const toggleSaved = (id: string) => {
    setSaved((current) =>
      current.includes(id) ? current.filter((savedId) => savedId !== id) : [...current, id],
    );
  };

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
          <button className="icon-button" aria-label="알림">
            <Bell size={20} />
          </button>
        </header>

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

function StatusPill({ status }: { status: TicketAccess }) {
  const className =
    status === "한국 구매 가능" ? "safe" : status === "일본 번호 필요" ? "blocked" : "watch";
  return <span className={`status-pill ${className}`}>{status}</span>;
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
          <button className="secondary-button">
            <Bell size={17} />
            일정 알림
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
