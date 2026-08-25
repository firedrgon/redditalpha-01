import { NextRequest, NextResponse } from "next/server";
import { fetchCompanyQuality } from "@/lib/company-quality";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const ticker = (sp.get("ticker") || sp.get("code") || "").trim();

  if (!ticker) {
    return NextResponse.json({ error: "缺少 ticker 参数（A 股 6 位代码，如 002739）" }, { status: 400 });
  }

  // 仅接受 A 股代码形态，避免误打到美股流程
  if (!/^\d{6}(\.(SH|SZ|BJ))?$/i.test(ticker.trim())) {
    return NextResponse.json(
      { error: "仅支持 A 股 6 位代码（如 002739 / 600519.SH），美股请用 /api/analyze" },
      { status: 400 }
    );
  }

  if (!process.env.THS_API_KEY) {
    return NextResponse.json(
      { error: "未配置 THS_API_KEY，无法访问同花顺金融数据 API" },
      { status: 500 }
    );
  }

  try {
    const result = await fetchCompanyQuality(ticker);
    if (!result) {
      return NextResponse.json(
        { error: "无法解析该 A 股代码或不支持的市场" },
        { status: 400 }
      );
    }
    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: `公司质地打分失败: ${msg}` }, { status: 502 });
  }
}
