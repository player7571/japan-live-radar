export type PublicEventSource = {
  key: string;
  label: string;
  syncRunSource: string;
  script: string;
  aliases: string[];
  searchPriority?: number;
  searchUrl?: (encodedKeyword: string) => string;
};

export const publicEventSources: PublicEventSource[] = [
  { key: "seed", label: "Seed events", syncRunSource: "Seed", script: "sync:seed", aliases: ["fallback"] },
  {
    key: "ticketmaster",
    label: "Ticketmaster",
    syncRunSource: "Ticketmaster",
    script: "sync:ticketmaster",
    aliases: ["tm"],
    searchPriority: 40,
    searchUrl: (keyword) => `https://www.ticketmaster.com/search?q=${keyword}&sort=date%2Casc&country=jp`,
  },
  {
    key: "eplus",
    label: "e+",
    syncRunSource: "e+",
    script: "sync:eplus",
    aliases: ["e+", "e plus", "イープラス"],
    searchPriority: 20,
    searchUrl: (keyword) => `https://eplus.jp/sf/word?keyword=${keyword}`,
  },
  {
    key: "lawson",
    label: "Lawson Ticket",
    syncRunSource: "Lawson Ticket",
    script: "sync:lawson",
    aliases: ["lawson ticket", "l-tike", "ローチケ", "ローソン"],
    searchPriority: 30,
    searchUrl: (keyword) => `https://l-tike.com/search/?keyword=${keyword}`,
  },
  {
    key: "ticket-pia",
    label: "Ticket Pia",
    syncRunSource: "Ticket Pia",
    script: "sync:ticket-pia",
    aliases: ["ticket pia", "ticketpia", "pia", "チケットぴあ"],
    searchPriority: 10,
    searchUrl: (keyword) => `https://t.pia.jp/en/pia/search_dtl_input.do?keyword=${keyword}`,
  },
  {
    key: "rakuten-ticket",
    label: "Rakuten Ticket",
    syncRunSource: "Rakuten Ticket",
    script: "sync:rakuten-ticket",
    aliases: ["rakuten ticket", "rakuten", "楽天チケット", "楽天"],
    searchPriority: 50,
    searchUrl: (keyword) => `https://ticket.rakuten.co.jp/?q=${keyword}`,
  },
  {
    key: "creativeman",
    label: "Creativeman",
    syncRunSource: "Creativeman",
    script: "sync:creativeman",
    aliases: ["creativeman productions", "creative man", "クリエイティブマン"],
    searchPriority: 80,
    searchUrl: () => "https://www.creativeman.co.jp/upcoming/",
  },
  {
    key: "livenation-hip",
    label: "Live Nation H.I.P.",
    syncRunSource: "Live Nation H.I.P.",
    script: "sync:livenation-hip",
    aliases: ["live nation hip", "live nation h.i.p.", "livenation hip", "hip"],
    searchPriority: 70,
    searchUrl: () => "https://www.livenationhip.co.jp/",
  },
  {
    key: "livefans",
    label: "LiveFans",
    syncRunSource: "LiveFans",
    script: "sync:livefans",
    aliases: ["live fans", "ライブファンズ"],
    searchPriority: 60,
    searchUrl: (keyword) => `https://www.livefans.jp/search?option=3&keyword=${keyword}`,
  },
];

export const trackedSyncSources = publicEventSources.map((source) => source.syncRunSource);
export const publicSearchSources = publicEventSources
  .filter((source) => source.searchUrl)
  .sort((left, right) => (left.searchPriority ?? Number.MAX_SAFE_INTEGER) - (right.searchPriority ?? Number.MAX_SAFE_INTEGER));
