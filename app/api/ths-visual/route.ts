import { NextRequest, NextResponse } from "next/server";
import { detectMarket, normalizeCNTicker } from "@/lib/market";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

/**
 * 从同花顺接口获取财务图解页面 URL（动态，随报告期变化）
 */
async function fetchThsVisualUrl(code: string): Promise<string | null> {
  const url = `https://basic.10jqka.com.cn/basicapi/finance/stock/visual/recent/?code=${code}`;
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": UA, Referer: "https://basic.10jqka.com.cn/" },
      cache: "no-store",
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      status_code?: number;
      data?: { url?: string };
    };
    const pageUrl = data.data?.url;
    if (!pageUrl) return null;
    return pageUrl.startsWith("//") ? `https:${pageUrl}` : pageUrl;
  } catch {
    return null;
  }
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const ticker = (searchParams.get("ticker") || "").trim();
  if (!ticker) {
    return NextResponse.json({ error: "缺少 ticker" }, { status: 400 });
  }

  const upper = ticker.toUpperCase();
  if (detectMarket(upper) !== "CN") {
    return NextResponse.json({ url: null });
  }

  const normalized = normalizeCNTicker(upper) ?? upper;
  const code = normalized.replace(/\.(SH|SZ|SS)$/i, "").trim();
  if (!/^\d{6}$/.test(code)) {
    return NextResponse.json({ url: null });
  }

  const visualUrl = await fetchThsVisualUrl(code);
  return NextResponse.json({ url: visualUrl });
}
