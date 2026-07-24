"use client";

import SiteHeader from "@/app/components/SiteHeader";
import HotStocksPanel from "@/app/components/HotStocksPanel";

export default function HotStocksPage() {
  return (
    <>
      <SiteHeader />
      <div className="mx-auto max-w-2xl px-4 py-6">
        <HotStocksPanel variant="list" />
      </div>
    </>
  );
}
