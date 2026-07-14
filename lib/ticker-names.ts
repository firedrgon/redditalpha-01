/**
 * Ticker 名称解析服务（混合方案）
 *
 * 查询优先级：
 *   1. 静态中文字典（秒查，覆盖常见 ticker）
 *   2. 服务端内存缓存（已动态查询过的结果）
 *   3. Yahoo Finance Search API（动态补全未知 ticker）
 *
 * 缓存策略：
 *   - 命中名称：缓存 24 小时
 *   - 查询失败：缓存 1 小时（避免反复请求）
 */

// ============================================================
// 静态中文字典（股票 + 加密货币 + ETF）
// ============================================================
const STATIC_NAMES: Record<string, string> = {
  // 美股科技
  AAPL: "苹果", MSFT: "微软", GOOGL: "谷歌", GOOG: "谷歌", AMZN: "亚马逊",
  META: "Meta", NVDA: "英伟达", TSLA: "特斯拉", AVGO: "博通", ORCL: "甲骨文",
  CRM: "Salesforce", AMD: "超威半导体", INTC: "英特尔", QCOM: "高通",
  ADP: "ADP自动数据", CSCO: "思科", IBM: "IBM", TXN: "德州仪器",
  NOW: "ServiceNow", ADBE: "Adobe", PYPL: "PayPal", NFLX: "奈飞",
  MU: "美光科技", ASML: "阿斯麦", AMAT: "应用材料", LRCX: "泛林半导体",
  KLAC: "科磊", MRVL: "迈威尔科技", ARM: "ARM控股", SMCI: "超微电脑",
  PLTR: "Palantir", SNOW: "Snowflake", CRWD: "CrowdStrike", PANW: "Palo Alto",
  SNAP: "Snap", PINS: "Pinterest", ROKU: "Roku", UBER: "Uber",
  ABNB: "Airbnb", COIN: "Coinbase", RBLX: "Roblox", APP: "AppLovin",
  DDOG: "Datadog", ZM: "Zoom", DOCU: "DocuSign", ZS: "Zscaler",
  NET: "Cloudflare", OKTA: "Okta", TEAM: "Atlassian", MDB: "MongoDB",
  ESTC: "Elastic", TWLO: "Twilio", S: "SentinelOne", GTLB: "GitLab",
  PATH: "UiPath", AI: "C3.ai", FROG: "JFrog", PD: "PagerDuty",
  // 金融
  JPM: "摩根大通", V: "Visa", MA: "万事达", BAC: "美国银行",
  WFC: "富国银行", GS: "高盛", MS: "摩根士丹利", C: "花旗",
  AXP: "美国运通", BLK: "贝莱德", SCHW: "嘉信理财",
  MET: "大都会人寿", PRU: "保德信金融", ALL: "好事达",
  AIG: "美国国际集团", USB: "合众银行", PNC: "PNC金融",
  COF: "第一资本", SPGI: "标普全球", MCO: "穆迪",
  // 消费/医药
  WMT: "沃尔玛", COST: "Costco", HD: "家得宝", MCD: "麦当劳",
  NKE: "耐克", SBUX: "星巴克", PFE: "辉瑞", JNJ: "强生",
  UNH: "联合健康", LLY: "礼来", MRK: "默克", ABBV: "艾伯维",
  KO: "可口可乐", PEP: "百事可乐", PG: "宝洁",
  T: "AT&T", VZ: "威瑞森", DIS: "迪士尼",
  ABT: "雅培", BMY: "百时美施贵宝", GILD: "吉利德", AMGN: "安进",
  REGN: "再生元", VRTX: "福泰制药", DHR: "丹纳赫", TMO: "赛默飞",
  // 能源/工业
  XOM: "埃克森美孚", CVX: "雪佛龙", COP: "康菲石油",
  SLB: "斯伦贝谢", EOG: "EOG能源", PXD: "先锋自然资源",
  MPC: "马拉松石油", PSX: "菲利普斯66", VLO: "瓦莱罗能源",
  CAT: "卡特彼勒", BA: "波音", GE: "通用电气", LMT: "洛克希德马丁",
  RTX: "雷神技术", UPS: "联合包裹", DE: "迪尔", HON: "霍尼韦尔",
  // 通信/媒体
  TMUS: "T-Mobile", CMCSA: "康卡斯特", CHTR: "Charter",
  FOXA: "福克斯", WBD: "华纳兄弟探索", PARA: "派拉蒙",
  // 零售/其他
  LOW: "劳氏", TJX: "TJX", ROST: "罗斯百货", TGT: "塔吉特",
  F: "福特", GM: "通用汽车", RIVN: "Rivian", LCID: "Lucid",
  NIO: "蔚来", XPEV: "小鹏", LI: "理想汽车",
  // ETF/指数
  SPY: "标普500ETF", QQQ: "纳斯达克100ETF", IWM: "罗素2000ETF",
  DIA: "道琼斯ETF", TLT: "长期国债ETF", GLD: "黄金ETF",
  VIX: "波动率指数", UVXY: "短期波动率ETF", SOXX: "半导体ETF",
  XLF: "金融ETF", XLE: "能源ETF", XLK: "科技ETF", XLY: "可选消费ETF",
  ARKK: "ARK创新ETF", ARKW: "ARK下一代互联网ETF",
  // 加密货币
  BTC: "比特币", ETH: "以太坊", SOL: "索拉纳", XRP: "瑞波币",
  DOGE: "狗狗币", SHIB: "柴犬币", ADA: "卡尔达诺", AVAX: "雪崩",
  DOT: "波卡", LINK: "Chainlink", MATIC: "Polygon", LTC: "莱特币",
  BNB: "币安币", USDT: "泰达币", USDC: "USD Coin",
  MSTR: "MicroStrategy", GMT: "GMT", ATOM: "Cosmos",
  UNI: "Uniswap", AAVE: "Aave", NEAR: "NEAR", APT: "Aptos",
  ARB: "Arbitrum", OP: "Optimism", PEPE: "Pepe", WIF: "dogwifhat",
  BONK: "Bonk", FLOKI: "Floki", TRX: "波场", TON: "Toncoin",
  ICP: "互联网计算机", FIL: "Filecoin", INJ: "Injective",
  TIA: "Celestia", SEI: "Sei", SUI: "Sui",
  JUP: "Jupiter", PYTH: "Pyth", RUNE: "THORChain",
  // 其他热门/Meme
  GEVO: "Gevo", SOUN: "SoundHound", SNDK: "SanDisk",
  MOU: "MOU", DRAM: "DRAM", SPCX: "SPCX", MEHR: "MEHR",
  GME: "游戏驿站", AMC: "AMC院线", BB: "黑莓", NOK: "诺基亚",
  NKLA: "尼古拉", HOOD: "Robinhood", DASH: "DoorDash",
  PLUG: "Plug Power", FCEL: "FuelCell", BLNK: "Blink Charging",
  WKHS: "Workhorse", NNDM: "Nano Dimension", SOS: "SOS",
  ZOM: "Zomedica", CEI: "Camber Energy", PROG: "Progenity",
  ATER: "Aterian", SAVA: "Cassava Sciences", BBBY: "Bed Bath & Beyond",
  MULN: "Mullen Automotive", INDO: "Indonesia Energy",
  // A 股（沪深主板/创业板/科创板，代码.交易所 格式）
  "600519.SH": "贵州茅台", "601398.SH": "工商银行", "601318.SH": "中国平安",
  "600036.SH": "招商银行", "601166.SH": "兴业银行", "000858.SZ": "五粮液",
  "000333.SZ": "美的集团", "000001.SZ": "平安银行", "002594.SZ": "比亚迪",
  "300750.SZ": "宁德时代", "600276.SH": "恒瑞医药", "603259.SH": "药明康德",
  "600030.SH": "中信证券", "601628.SH": "中国人寿", "600887.SH": "伊利股份",
  "000651.SZ": "格力电器", "600031.SH": "三一重工", "601012.SH": "隆基绿能",
  "002475.SZ": "立讯精密", "300059.SZ": "东方财富", "600900.SH": "长江电力",
  "688981.SH": "中芯国际", "688111.SH": "金山办公", "300760.SZ": "迈瑞医疗",
  "002415.SZ": "海康威视", "000725.SZ": "京东方A", "601899.SH": "紫金矿业",
  "600585.SH": "海螺水泥", "601888.SH": "中国中免", "002714.SZ": "牧原股份",
  "600438.SH": "通威股份", "601633.SH": "长城汽车", "601238.SH": "广汽集团",
  "600009.SH": "上海机场", "000002.SZ": "万科A", "600048.SH": "保利发展",
};

// ============================================================
// 内存缓存
// ============================================================
interface CacheEntry {
  name: string | null;
  expireAt: number;
}

const CACHE_TTL_HIT = 24 * 60 * 60 * 1000; // 命中：24 小时
const CACHE_TTL_MISS = 60 * 60 * 1000;    // 未命中：1 小时

const nameCache = new Map<string, CacheEntry>();

function getCached(ticker: string): string | null | undefined {
  const entry = nameCache.get(ticker);
  if (!entry) return undefined; // 未缓存
  if (Date.now() > entry.expireAt) {
    nameCache.delete(ticker);
    return undefined; // 过期
  }
  return entry.name; // 可能是 string 或 null
}

function setCached(ticker: string, name: string | null): void {
  const ttl = name ? CACHE_TTL_HIT : CACHE_TTL_MISS;
  nameCache.set(ticker, { name, expireAt: Date.now() + ttl });
}

// ============================================================
// Yahoo Finance Search API 动态查询
// ============================================================
async function fetchNameFromYahoo(ticker: string): Promise<string | null> {
  try {
    const url = `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(ticker)}&quotesCount=1&newsCount=0`;
    const res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        Accept: "application/json",
      },
      // 防止 Next.js 在构建时缓存
      cache: "no-store",
    });

    if (!res.ok) return null;

    const data = await res.json();
    const quotes: Array<{ shortname?: string; longname?: string; symbol?: string }> =
      data.quotes || [];

    // 找到 symbol 精确匹配或第一个结果
    const upper = ticker.toUpperCase();
    const match =
      quotes.find((q) => q.symbol?.toUpperCase() === upper) || quotes[0];

    return match?.longname || match?.shortname || null;
  } catch {
    return null;
  }
}

// ============================================================
// A 股名称解析（同花顺 → 雪球 → Yahoo Finance 降级）
// ============================================================
async function fetchCNNameFromTonghuashun(ticker: string): Promise<string | null> {
  try {
    const { toTonghuashunSymbol } = await import("./market");
    const symbol = toTonghuashunSymbol(ticker);
    // 同花顺 realhead JSONP 接口返回 name 字段
    const res = await fetch(
      `https://d.10jqka.com.cn/v6/realhead/${symbol}/last.js`,
      {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36",
          Referer: "https://basic.10jqka.com.cn/",
        },
        cache: "no-store",
        signal: AbortSignal.timeout(8000),
      }
    );
    if (!res.ok) return null;
    const body = await res.text();
    // 解析 JSONP：quotebridge_v6_realhead_hs_600519_last({...})
    const m = body.match(/\((\{[\s\S]*\})\)/);
    if (!m) return null;
    const data = JSON.parse(m[1]);
    return data?.name ?? null;
  } catch {
    return null;
  }
}

async function fetchCNNameFromXueqiu(ticker: string): Promise<string | null> {
  try {
    const { toXueqiuSymbol } = await import("./market");
    const symbol = toXueqiuSymbol(ticker);
    // 雪球 quote 接口返回股票名称
    const res = await fetch(
      `https://stock.xueqiu.com/v5/stock/quote.json?symbol=${symbol}&extend=detail`,
      {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
          Accept: "application/json",
          Referer: "https://xueqiu.com/",
        },
        cache: "no-store",
        signal: AbortSignal.timeout(8000),
      }
    );
    if (!res.ok) return null;
    const data = await res.json();
    return data?.data?.quote?.name ?? null;
  } catch {
    return null;
  }
}

async function fetchCNNameFromYahoo(ticker: string): Promise<string | null> {
  try {
    const { toYahooSymbol } = await import("./market");
    const yahooSymbol = toYahooSymbol(ticker);
    const res = await fetch(
      `https://query2.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(yahooSymbol)}`,
      {
        headers: { "User-Agent": "Mozilla/5.0" },
        cache: "no-store",
        signal: AbortSignal.timeout(8000),
      }
    );
    if (!res.ok) return null;
    const data = await res.json();
    return data?.quoteResponse?.result?.[0]?.shortName ?? data?.quoteResponse?.result?.[0]?.longName ?? null;
  } catch {
    return null;
  }
}

// ============================================================
// 单个 ticker 名称解析
// ============================================================
export async function resolveTickerName(ticker: string): Promise<string | null> {
  const upper = ticker.toUpperCase();

  // 2. 内存缓存
  const cached = getCached(upper);
  if (cached !== undefined) return cached;

  // A 股走同花顺 → 雪球 → Yahoo 降级
  const { detectMarket, normalizeCNTicker } = await import("./market");
  if (detectMarket(upper) === "CN") {
    const cnTicker = normalizeCNTicker(upper) ?? upper;
    // 静态 A 股字典命中优先
    if (STATIC_NAMES[cnTicker]) {
      setCached(upper, STATIC_NAMES[cnTicker]);
      return STATIC_NAMES[cnTicker];
    }
    // 同花顺（海外可访问）
    let name = await fetchCNNameFromTonghuashun(cnTicker);
    // 雪球降级
    if (!name) name = await fetchCNNameFromXueqiu(cnTicker);
    // Yahoo 降级
    if (!name) name = await fetchCNNameFromYahoo(cnTicker);
    setCached(upper, name);
    return name;
  }

  // 1. 美股静态字典
  if (STATIC_NAMES[upper]) {
    setCached(upper, STATIC_NAMES[upper]);
    return STATIC_NAMES[upper];
  }

  // 3. 动态查询 Yahoo Finance（美股）
  const name = await fetchNameFromYahoo(upper);
  setCached(upper, name);
  return name;
}

// ============================================================
// 批量 enrich：给 Ticker 列表补上 name 字段
// ============================================================
export interface NameableTicker {
  ticker: string;
  name?: string | null;
}

export async function enrichTickersWithNames<T extends NameableTicker>(
  tickers: T[]
): Promise<T[]> {
  // 收集所有需要查询的 ticker（去重）
  const uniqueTickers = [...new Set(tickers.map((t) => t.ticker.toUpperCase()))];

  // 并行查询（静态字典命中会立即返回，动态查询走 Yahoo Finance）
  const nameMap = new Map<string, string | null>();
  await Promise.all(
    uniqueTickers.map(async (ticker) => {
      const name = await resolveTickerName(ticker);
      nameMap.set(ticker, name);
    })
  );

  // 填充 name 字段
  return tickers.map((t) => ({
    ...t,
    name: nameMap.get(t.ticker.toUpperCase()) ?? null,
  }));
}
