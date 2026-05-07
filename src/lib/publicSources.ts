export type PublicEventSource = {
  key: string;
  label: string;
  syncRunSource: string;
  script: string;
  aliases: string[];
};

export const publicEventSources: PublicEventSource[] = [
  { key: "seed", label: "Seed events", syncRunSource: "Seed", script: "sync:seed", aliases: ["fallback"] },
  { key: "ticketmaster", label: "Ticketmaster", syncRunSource: "Ticketmaster", script: "sync:ticketmaster", aliases: ["tm"] },
  { key: "eplus", label: "e+", syncRunSource: "e+", script: "sync:eplus", aliases: ["e+", "e plus", "イープラス"] },
  {
    key: "lawson",
    label: "Lawson Ticket",
    syncRunSource: "Lawson Ticket",
    script: "sync:lawson",
    aliases: ["lawson ticket", "l-tike", "ローチケ", "ローソン"],
  },
  {
    key: "ticket-pia",
    label: "Ticket Pia",
    syncRunSource: "Ticket Pia",
    script: "sync:ticket-pia",
    aliases: ["ticket pia", "ticketpia", "pia", "チケットぴあ"],
  },
  {
    key: "rakuten-ticket",
    label: "Rakuten Ticket",
    syncRunSource: "Rakuten Ticket",
    script: "sync:rakuten-ticket",
    aliases: ["rakuten ticket", "rakuten", "楽天チケット", "楽天"],
  },
  {
    key: "creativeman",
    label: "Creativeman",
    syncRunSource: "Creativeman",
    script: "sync:creativeman",
    aliases: ["creativeman productions", "creative man", "クリエイティブマン"],
  },
  {
    key: "livenation-hip",
    label: "Live Nation H.I.P.",
    syncRunSource: "Live Nation H.I.P.",
    script: "sync:livenation-hip",
    aliases: ["live nation hip", "live nation h.i.p.", "livenation hip", "hip"],
  },
  {
    key: "livefans",
    label: "LiveFans",
    syncRunSource: "LiveFans",
    script: "sync:livefans",
    aliases: ["live fans", "ライブファンズ"],
  },
];

export const trackedSyncSources = publicEventSources.map((source) => source.syncRunSource);
