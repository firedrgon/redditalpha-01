/**
 * 股票市场识别与 ticker 规范化
 *
 * 支持 A 股（沪市/深市）与美股。A 股代码为 6 位数字，
 * 可带 .SH/.SZ/.SS 后缀或 SH/SZ 前缀；美股为字母代码。
 *
 * 规范化输出格式：
 *   - A 股：`600519.SH` / `000001.SZ`（点号后缀，大写）
 *   - 美股：`AAPL`（大写字母）
 *
 * 雪球 API 使用的前置格式（SH600519）由 toXueqiuSymbol 转换。
 */

export type Market = "US" | "CN" | "HK" | "UNKNOWN";

/** A 股交易所后缀（规范化用） */
export type CNExchange = "SH" | "SZ";

/**
 * 识别 ticker 所属市场。
 *
 * A 股识别规则（任一命中即判定为 A 股）：
 *   1. 6 位纯数字（按首位推断交易所：6→沪，0/3→深）
 *   2. 6 位数字 + .SH/.SS/.SZ 后缀
 *   3. SH/SZ 前置 + 6 位数字（雪球格式，如 SH600519）
 *
 * 港股（5 位数字 + .HK）当前识别但不深度支持，返回 HK。
 */
export function detectMarket(rawTicker: string): Market {
  const t = rawTicker.trim().toUpperCase();

  // 带后缀的明确市场
  if (/\.(SH|SS)$/.test(t)) return "CN";
  if (/\.(SZ)$/.test(t)) return "CN";
  if (/\.(HK)$/.test(t)) return "HK";

  // 雪球/前置交易所格式：SH600519 / SZ000001
  if (/^(SH|SZ)\d{6}$/.test(t)) return "CN";

  // 纯 6 位数字 → A 股
  if (/^\d{6}$/.test(t)) return "CN";

  // 纯 5 位数字 → 港股
  if (/^\d{5}$/.test(t)) return "HK";

  // 字母代码 → 美股
  if (/^[A-Z][A-Z0-9.\-]{0,19}$/i.test(rawTicker)) return "US";

  return "UNKNOWN";
}

/**
 * 规范化 A 股 ticker 为 `600519.SH` 格式。
 * 输入不合法时返回 null。
 *
 * 接受格式：
 *   600519 / 600519.SH / 600519.SS / SH600519 / sh.600519
 */
export function normalizeCNTicker(rawTicker: string): string | null {
  const t = rawTicker.trim().toUpperCase().replace(/\s/g, "");

  // SH.600519 / SZ.600519（带点的前置格式）
  const prefixed = t.match(/^(SH|SZ)\.?(\d{6})$/);
  if (prefixed) {
    return `${prefixed[2]}.${prefixed[1] === "SS" ? "SH" : prefixed[1]}`;
  }

  // 600519.SH / 600519.SS / 600519.SZ
  const suffixed = t.match(/^(\d{6})\.(SH|SS|SZ)$/);
  if (suffixed) {
    const ex = suffixed[2] === "SS" ? "SH" : suffixed[2];
    return `${suffixed[1]}.${ex}`;
  }

  // 纯 6 位数字 → 按首位推断交易所
  if (/^\d{6}$/.test(t)) {
    return `${t}.${inferExchange(t)}`;
  }

  return null;
}

/**
 * 按代码首位推断 A 股交易所。
 *   6 / 9 → 沪市（主板 60xxxx、科创板 688xxx、B股 900xxx）
 *   0 / 3 → 深市（主板 000/001、中小板 002、创业板 300/301）
 *   8 / 4 → 北交所（暂不支持，默认返回 SH）
 */
export function inferExchange(code: string): CNExchange {
  const first = code.charAt(0);
  if (first === "6" || first === "9") return "SH";
  if (first === "0" || first === "3") return "SZ";
  // 北交所 8/4 开头，当前不支持，默认 SH
  return "SH";
}

/**
 * 规范化 ticker：根据市场输出统一格式。
 * A 股 → 600519.SH；美股 → AAPL。
 */
export function normalizeTicker(rawTicker: string): string {
  const market = detectMarket(rawTicker);
  if (market === "CN") {
    return normalizeCNTicker(rawTicker) ?? rawTicker.trim().toUpperCase();
  }
  return rawTicker.trim().toUpperCase();
}

/**
 * 转换为雪球 API 使用的 symbol 格式（SH600519）。
 * 仅 A 股有效，输入需为规范化后的 600519.SH 格式。
 */
export function toXueqiuSymbol(ticker: string): string {
  const m = ticker.match(/^(\d{6})\.(SH|SZ)$/);
  if (m) return `${m[2]}${m[1]}`;
  // 兜底：若已是 SH600519 格式
  if (/^(SH|SZ)\d{6}$/.test(ticker)) return ticker.toUpperCase();
  return ticker.toUpperCase();
}

/**
 * 转换为 Yahoo Finance 使用的 symbol 格式。
 * A 股：600519.SH → 600519.SS（上交所用 .SS，深交所用 .SZ）
 * 非A股：原样返回
 */
export function toYahooSymbol(ticker: string): string {
  const m = ticker.match(/^(\d{6})\.(SH|SZ)$/);
  if (m) {
    // Yahoo: 上交所 .SS，深交所 .SZ
    const ex = m[2] === "SH" ? "SS" : "SZ";
    return `${m[1]}.${ex}`;
  }
  return ticker.toUpperCase();
}

/**
 * 转换为同花顺 realhead 接口的 symbol 格式。
 * A 股：600519.SH → hs_600519（沪深统一用 hs_ 前缀）
 */
export function toTonghuashunSymbol(ticker: string): string {
  const m = ticker.match(/^(\d{6})\.(SH|SZ)$/);
  if (m) return `hs_${m[1]}`;
  return ticker.toUpperCase();
}

/** 提取 A 股 6 位数字代码（用于同花顺 basic 页面 URL） */
export function toTonghuashunCode(ticker: string): string | null {
  const m = ticker.match(/^(\d{6})\.(SH|SZ)$/);
  return m ? m[1] : null;
}

/** 判断是否为 A 股 ticker（规范化后） */
export function isCN(ticker: string): boolean {
  return detectMarket(ticker) === "CN";
}

/** 判断是否为美股 ticker */
export function isUS(ticker: string): boolean {
  return detectMarket(ticker) === "US";
}
