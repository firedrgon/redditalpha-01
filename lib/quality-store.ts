"use client";

import { useEffect, useState } from "react";
import type { QualityStatus } from "@/lib/db/company-quality-cache";

export type QualityStatusMap = Record<string, QualityStatus>;

/**
 * 批量查询「哪些 A股已打过质地分」（服务端缓存表 CompanyQualityCache），供列表徽章。
 *
 * 早期版本用 localStorage 记录「已打分」状态，但局限明显：状态只存在本机浏览器
 * （换设备 / 清缓存即丢）、不跨用户共享。现统一落库，列表侧批量查询即可，
 * 打分成功由 /api/company-quality 自动 upsert，无需前端写入。
 */
export function useQualityStatusMap(tickers: string[]): QualityStatusMap {
  const [map, setMap] = useState<QualityStatusMap>({});
  const key = tickers.join(",");

  useEffect(() => {
    if (tickers.length === 0) {
      setMap({});
      return;
    }
    let cancelled = false;
    const qs = encodeURIComponent(tickers.join(","));
    fetch(`/api/company-quality/status?tickers=${qs}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (!cancelled && j?.status) setMap(j.status as QualityStatusMap);
      })
      .catch(() => {
        /* 网络失败降级为全部未打分 */
      });
    return () => {
      cancelled = true;
    };
    // tickers 已折叠为 key 字符串作为依赖
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return map;
}
