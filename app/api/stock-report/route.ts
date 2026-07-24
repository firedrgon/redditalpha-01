import { NextRequest, NextResponse } from "next/server";
import {
  generateStockReport,
  getSavedReport,
  getReportsExist,
  isValidUSTicker,
} from "@/lib/stock-report";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const ticker = sp.get("ticker");
  const existsParam = sp.get("exists");
  const tickersParam = sp.get("tickers");

  // 批量存在性检查（收藏列表用）：?exists=1&tickers=AAPL,MSFT
  if (existsParam === "1" && tickersParam) {
    const tickers = tickersParam
      .split(",")
      .map((t) => t.trim().toUpperCase())
      .filter(isValidUSTicker);
    const reports = await getReportsExist(tickers);
    return NextResponse.json({ reports });
  }

  // 单只：返回已存报告；无则 { exists:false }
  if (ticker && String(ticker).trim()) {
    const clean = String(ticker).trim().toUpperCase();
    if (!isValidUSTicker(clean)) {
      return NextResponse.json({ error: "无效的股票代码" }, { status: 400 });
    }
    const saved = await getSavedReport(clean);
    if (saved) {
      return NextResponse.json(saved, {
        headers: { "Cache-Control": "no-store" },
      });
    }
    return NextResponse.json({ exists: false, ticker: clean });
  }

  return NextResponse.json({ error: "缺少参数" }, { status: 400 });
}

export async function POST(req: NextRequest) {
  let ticker: string | undefined;
  try {
    const body = (await req.json()) as { ticker?: string };
    ticker = body?.ticker;
  } catch {
    // 忽略解析错误，交由下方校验
  }
  if (!ticker || !String(ticker).trim()) {
    return NextResponse.json({ error: "缺少 ticker 参数" }, { status: 400 });
  }
  const clean = String(ticker).trim();
  if (!isValidUSTicker(clean)) {
    return NextResponse.json(
      { error: "无效的股票代码（美股应为字母代码，如 AAPL）" },
      { status: 400 }
    );
  }
  try {
    const result = await generateStockReport(clean);
    return NextResponse.json(result, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // 未配置 LLM / 调用失败等统一返回 502，前端展示错误
    return NextResponse.json({ error: msg }, { status: 502 });
  }
}
