import { NextRequest, NextResponse } from "next/server";
import { generateStockReport, isValidUSTicker } from "@/lib/stock-report";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function handle(ticker: string | null | undefined) {
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

export async function GET(req: NextRequest) {
  const ticker = req.nextUrl.searchParams.get("ticker");
  return handle(ticker);
}

export async function POST(req: NextRequest) {
  let ticker: string | undefined;
  try {
    const body = (await req.json()) as { ticker?: string };
    ticker = body?.ticker;
  } catch {
    // 忽略解析错误，交由 handle 校验
  }
  return handle(ticker);
}
