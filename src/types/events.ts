export type City = "도쿄" | "오사카" | "요코하마" | "나고야" | "후쿠오카";
export type TicketAccess = "한국 구매 가능" | "일본 번호 필요" | "확인 필요";
export type SaleType = "추첨 접수" | "일반 판매" | "선착 판매" | "해외 판매";

export type Event = {
  id: string;
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

export type EventApiResponse = {
  events: Event[];
  source: "supabase" | "seed";
  meta?: {
    lastSync?: SyncRun;
  };
};

export type SyncRun = {
  source: string;
  status: "success" | "error";
  fetchedCount: number;
  upsertedCount: number;
  skippedCount: number;
  message: string | null;
  finishedAt: string;
};
