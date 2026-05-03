import React, { useMemo, useState } from "react";
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
import "./styles.css";

type City = "도쿄" | "오사카" | "요코하마" | "나고야" | "후쿠오카";
type TicketAccess = "한국 구매 가능" | "일본 번호 필요" | "확인 필요";
type SaleType = "추첨 접수" | "일반 판매" | "선착 판매" | "해외 판매";
type DateWindow = "전체" | "60일 이내" | "90일 이내" | "여름 원정";

type Event = {
  id: number;
  artist: string;
  title: string;
  city: City;
  venue: string;
  date: string;
  time: string;
  genre: string;
  source: string;
  ticketAccess: TicketAccess;
  saleType: SaleType;
  saleWindow: string;
  price: string;
  phoneRequired: boolean;
  foreignerNote: string;
  link: string;
  image: string;
};

const events: Event[] = [
  {
    id: 1,
    artist: "YOASOBI",
    title: "Asia Dome Session",
    city: "도쿄",
    venue: "Tokyo Dome",
    date: "2026-06-19",
    time: "18:30",
    genre: "J-Pop",
    source: "Ticket Pia",
    ticketAccess: "확인 필요",
    saleType: "추첨 접수",
    saleWindow: "5.12 12:00 - 5.20 23:59",
    price: "¥9,800 - ¥14,800",
    phoneRequired: true,
    foreignerNote: "일본 번호 인증 가능성이 높아 대행/동행 구매 여부 확인 필요",
    link: "https://t.pia.jp/",
    image:
      "https://images.unsplash.com/photo-1501386761578-eac5c94b800a?auto=format&fit=crop&w=1200&q=80",
  },
  {
    id: 2,
    artist: "ONE OK ROCK",
    title: "Neon Arena Night",
    city: "오사카",
    venue: "Osaka-jō Hall",
    date: "2026-07-03",
    time: "19:00",
    genre: "Rock",
    source: "e+",
    ticketAccess: "일본 번호 필요",
    saleType: "선착 판매",
    saleWindow: "5.25 10:00 - 매진 시",
    price: "¥11,000",
    phoneRequired: true,
    foreignerNote: "스마치케 사용 시 앱/전화번호 인증 조건 확인 필요",
    link: "https://eplus.jp/",
    image:
      "https://images.unsplash.com/photo-1524368535928-5b5e00ddc76b?auto=format&fit=crop&w=1200&q=80",
  },
  {
    id: 3,
    artist: "Ado",
    title: "Blue Flame Tour",
    city: "요코하마",
    venue: "K-Arena Yokohama",
    date: "2026-07-21",
    time: "18:00",
    genre: "J-Pop",
    source: "Lawson Ticket",
    ticketAccess: "확인 필요",
    saleType: "추첨 접수",
    saleWindow: "5.18 13:00 - 5.27 23:59",
    price: "¥12,500",
    phoneRequired: true,
    foreignerNote: "로치케 전자티켓은 일본 앱스토어/번호 제약을 확인해야 함",
    link: "https://l-tike.com/",
    image:
      "https://images.unsplash.com/photo-1506157786151-b8491531f063?auto=format&fit=crop&w=1200&q=80",
  },
  {
    id: 4,
    artist: "NewJeans",
    title: "Summer Pop-Up Live",
    city: "후쿠오카",
    venue: "Marine Messe Fukuoka",
    date: "2026-08-08",
    time: "17:30",
    genre: "K-Pop",
    source: "Ticketmaster",
    ticketAccess: "한국 구매 가능",
    saleType: "해외 판매",
    saleWindow: "6.02 11:00 - 8.07 18:00",
    price: "¥13,200",
    phoneRequired: false,
    foreignerNote: "해외 카드 결제와 모바일 티켓 수령 조건 확인",
    link: "https://www.ticketmaster.com/",
    image:
      "https://images.unsplash.com/photo-1516450360452-9312f5e86fc7?auto=format&fit=crop&w=1200&q=80",
  },
  {
    id: 5,
    artist: "RADWIMPS",
    title: "Afterglow Hall Set",
    city: "나고야",
    venue: "Nippon Gaishi Hall",
    date: "2026-09-12",
    time: "18:00",
    genre: "Rock",
    source: "Ticket Pia",
    ticketAccess: "한국 구매 가능",
    saleType: "일반 판매",
    saleWindow: "7.04 10:00 - 9.11 23:59",
    price: "¥9,900",
    phoneRequired: false,
    foreignerNote: "해외 판매 페이지가 열릴 경우 여권명 기준으로 예매",
    link: "https://t.pia.jp/en",
    image:
      "https://images.unsplash.com/photo-1524368535928-5b5e00ddc76b?auto=format&fit=crop&w=1200&q=80",
  },
];

const cityOptions: Array<City | "전체"> = ["전체", "도쿄", "오사카", "요코하마", "나고야", "후쿠오카"];
const accessOptions: Array<TicketAccess | "전체"> = [
  "전체",
  "한국 구매 가능",
  "일본 번호 필요",
  "확인 필요",
];
const dateWindowOptions: DateWindow[] = ["전체", "60일 이내", "90일 이내", "여름 원정"];
const today = new Date("2026-05-04T00:00:00+09:00");

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
  const [query, setQuery] = useState("");
  const [city, setCity] = useState<City | "전체">("전체");
  const [access, setAccess] = useState<TicketAccess | "전체">("전체");
  const [dateWindow, setDateWindow] = useState<DateWindow>("전체");
  const [koreaFriendlyOnly, setKoreaFriendlyOnly] = useState(false);
  const [selectedId, setSelectedId] = useState(events[0].id);
  const [saved, setSaved] = useState<number[]>([4]);

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

  const toggleSaved = (id: number) => {
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
              <select value={city} onChange={(event) => setCity(event.target.value as City | "전체")}>
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
  onSave: (id: number) => void;
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
