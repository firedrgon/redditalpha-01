/**
 * 公司质地打分「缓存主键」归一化工具（纯函数，无 prisma 依赖）。
 *
 * 收藏 / 热榜 / 用户输入的 ticker 形态不一（002739、002739.SZ、600519.SH），
 * 统一抽成 6 位裸码大写作为缓存主键，保证同一只股票命中同一条缓存。
 * 同时供客户端（quality-store hook）与服务端（company-quality-cache）共用，
 * 避免客户端文件直接 import 含 @prisma/client 的服务端模块。
 */
export function cacheKeyOf(ticker: string): string | null {
  const m = ticker.trim().toUpperCase().match(/^(\d{6})/);
  return m ? m[1] : null;
}
