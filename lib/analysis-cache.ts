/**
 * 股票分析结果缓存
 *
 * 缓存策略：以 ticker 为键，存储最近一次分析结果（StockAnalysis）。
 * 下次点分析按钮时，先返回缓存；用户点"重新分析"会以 force=true 调用 API，
 * 拉取最新财务数据 + LLM 后覆盖旧数据。
 *
 * 持久化：项目根目录 .analysis-cache.json（可写时）
 * 降级：serverless 只读文件系统下使用内存副本（重启后丢失）
 */

import fs from "node:fs/promises";
import path from "node:path";
import type { StockAnalysis } from "./analysis";

const FILE = path.join(process.cwd(), ".analysis-cache.json");

interface CacheStore {
  items: Record<string, StockAnalysis>;
  updatedAt: number;
}

// 内存降级副本：当文件不可写时使用
let memoryStore: CacheStore | null = null;

async function readCache(): Promise<CacheStore> {
  // 优先用内存副本
  if (memoryStore) {
    return JSON.parse(JSON.stringify(memoryStore)) as CacheStore;
  }
  try {
    const raw = await fs.readFile(FILE, "utf-8");
    const parsed = JSON.parse(raw) as Partial<CacheStore>;
    return {
      items: parsed.items ?? {},
      updatedAt: parsed.updatedAt ?? 0,
    };
  } catch {
    return { items: {}, updatedAt: 0 };
  }
}

async function writeCache(store: CacheStore): Promise<void> {
  const data: CacheStore = { ...store, updatedAt: Date.now() };
  // 始终更新内存副本
  memoryStore = JSON.parse(JSON.stringify(data)) as CacheStore;
  // 尝试写文件（失败则降级到内存模式）
  try {
    await fs.writeFile(FILE, JSON.stringify(data, null, 2), "utf-8");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!msg.includes("EROFS") && !msg.includes("read-only")) {
      throw err;
    }
  }
}

/** 读取某个 ticker 的缓存分析结果，无则返回 null */
export async function getCachedAnalysis(
  ticker: string
): Promise<StockAnalysis | null> {
  const store = await readCache();
  return store.items[ticker.toUpperCase()] ?? null;
}

/** 写入/覆盖某 ticker 的分析结果 */
export async function saveAnalysis(
  analysis: StockAnalysis
): Promise<void> {
  const store = await readCache();
  store.items[analysis.ticker.toUpperCase()] = analysis;
  await writeCache(store);
}

/** 清除某个 ticker 的缓存 */
export async function clearCachedAnalysis(
  ticker: string
): Promise<void> {
  const store = await readCache();
  delete store.items[ticker.toUpperCase()];
  await writeCache(store);
}

/** 清空所有缓存 */
export async function clearAllCache(): Promise<void> {
  await writeCache({ items: {}, updatedAt: 0 });
}

/** 列出所有缓存的 ticker */
export async function listCachedTickers(): Promise<string[]> {
  const store = await readCache();
  return Object.keys(store.items).sort();
}
