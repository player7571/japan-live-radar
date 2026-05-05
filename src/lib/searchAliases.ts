import type { Event } from "../types/events";

export const koreanSearchAliases: Array<[string, string[]]> = [
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
  ["lawson ticket", ["로치케", "로손", "로손티켓", "로손 티켓", "로치케전자티켓"]],
  ["ticketmaster", ["티켓마스터"]],
  ["ticket board", ["티켓보드", "티켓 보드", "치케보"]],
  ["rakuten ticket", ["라쿠텐티켓", "라쿠텐 티켓", "라쿠텐"]],
  ["tixplus", ["티쿠플라", "치케플라", "티켓플러스", "치케프라"]],
  ["livefans", ["라이브팬즈", "라이브팬스", "라이브팬"]],
  ["도쿄", ["tokyo", "東京", "동경"]],
  ["오사카", ["osaka", "大阪"]],
  ["요코하마", ["yokohama", "横浜"]],
  ["나고야", ["nagoya", "名古屋"]],
  ["후쿠오카", ["fukuoka", "福岡"]],
  ["삿포로", ["sapporo", "札幌", "北海道", "홋카이도"]],
  ["센다이", ["sendai", "仙台", "宮城", "미야기"]],
  ["히로시마", ["hiroshima", "広島"]],
  ["사이타마", ["saitama", "埼玉", "さいたま"]],
  ["치바", ["chiba", "千葉", "幕張", "마쿠하리"]],
  ["교토", ["kyoto", "京都"]],
  ["고베", ["kobe", "神戸"]],
  ["니가타", ["niigata", "新潟", "朱鷺メッセ", "토키멧세", "토키 메세"]],
  ["시즈오카", ["shizuoka", "静岡", "エコパ", "에코파"]],
  ["가나자와", ["kanazawa", "金沢", "石川", "ishikawa", "이시카와"]],
  ["오키나와", ["okinawa", "沖縄", "naha", "那覇", "나하"]],
  ["오카야마", ["okayama", "岡山"]],
  ["구마모토", ["kumamoto", "熊本"]],
  ["가고시마", ["kagoshima", "鹿児島"]],
  ["마쓰야마", ["matsuyama", "松山", "愛媛", "ehime", "에히메"]],
  ["다카마쓰", ["takamatsu", "高松", "香川", "kagawa", "카가와"]],
  ["오이타", ["oita", "大分"]],
  ["나가노", ["nagano", "長野"]],
  ["다카사키", ["takasaki", "高崎", "群馬", "gunma", "군마"]],
  ["우쓰노미야", ["utsunomiya", "宇都宮", "栃木", "tochigi", "도치기"]],
  ["미토", ["mito", "水戸", "茨城", "ibaraki", "이바라키"]],
  ["한국 구매 가능", ["한국예매", "한국예매가능", "해외예매", "해외판매", "외국인판매", "한국구매"]],
  ["일본 번호 필요", ["일본번호", "일본번호필요", "일본전화번호", "sms인증", "문자인증", "전화번호인증"]],
  ["확인 필요", ["확인필요", "조건확인", "구매조건확인"]],
  ["추첨 접수", ["추첨", "로터리", "lottery", "抽選", "抽せん"]],
  ["일반 판매", ["일반판매", "general sale", "一般発売", "一般販売"]],
  ["선착 판매", ["선착", "선착순", "先着", "先着順"]],
  ["리세일", ["resale", "リセール", "트레이드", "公式トレード"]],
];

export function normalizeSearchValue(value: string) {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}+]+/gu, "");
}

export function searchVariants(value: string) {
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

export function eventSearchText(event: Event) {
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
