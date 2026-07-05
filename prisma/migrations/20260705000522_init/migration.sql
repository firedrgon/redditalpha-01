-- CreateTable
CREATE TABLE "AnalysisCache" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "ticker" TEXT NOT NULL,
    "name" TEXT,
    "metrics" TEXT NOT NULL,
    "overallVerdict" TEXT NOT NULL,
    "overallSummary" TEXT NOT NULL,
    "currentPrice" REAL,
    "targetMeanPrice" REAL,
    "targetHighPrice" REAL,
    "targetLowPrice" REAL,
    "targetMedianPrice" REAL,
    "targetUpside" REAL,
    "numberOfAnalysts" INTEGER,
    "recommendationMean" REAL,
    "llmNarrative" TEXT,
    "llmProvider" TEXT,
    "llmError" TEXT,
    "strategyIdsUsed" TEXT NOT NULL,
    "dataSource" TEXT,
    "warnings" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "StrategyCategory" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "order" INTEGER NOT NULL,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "color" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "Strategy" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "categoryId" TEXT NOT NULL,
    "metricField" TEXT NOT NULL,
    "operator" TEXT NOT NULL,
    "threshold" REAL NOT NULL,
    "format" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "order" INTEGER NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Strategy_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "StrategyCategory" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Favorite" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "ticker" TEXT NOT NULL,
    "name" TEXT,
    "note" TEXT,
    "tags" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "AppSetting" (
    "key" TEXT NOT NULL PRIMARY KEY,
    "value" TEXT NOT NULL,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "FinanceSnapshot" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "ticker" TEXT NOT NULL,
    "snapshotDate" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "price" REAL,
    "marketCap" REAL,
    "trailingPE" REAL,
    "forwardPE" REAL,
    "pegRatio" REAL,
    "priceToBook" REAL,
    "roe" REAL,
    "returnOnEquity5yAvg" REAL,
    "revenueGrowthYoY" REAL,
    "quarterlyRevenueGrowth" REAL,
    "grossMargin" REAL,
    "profitMargin" REAL,
    "quickRatio" REAL,
    "currentRatio" REAL,
    "debtToEquity" REAL,
    "industry" TEXT,
    "sector" TEXT,
    "industryPE" REAL,
    "targetMeanPrice" REAL,
    "targetUpside" REAL,
    "recommendationMean" REAL,
    "dataSource" TEXT,
    "rawJson" TEXT
);

-- CreateIndex
CREATE UNIQUE INDEX "AnalysisCache_ticker_key" ON "AnalysisCache"("ticker");

-- CreateIndex
CREATE UNIQUE INDEX "Favorite_ticker_key" ON "Favorite"("ticker");

-- CreateIndex
CREATE INDEX "FinanceSnapshot_ticker_snapshotDate_idx" ON "FinanceSnapshot"("ticker", "snapshotDate");
