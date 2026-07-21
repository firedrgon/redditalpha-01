import { PrismaClient } from '@prisma/client';
const p = new PrismaClient();

console.log('=== 最近 5 条 CronRun ===');
const runs = await p.cronRun.findMany({
  orderBy: { startedAt: 'desc' },
  take: 5,
});
for (const r of runs) {
  console.log({
    jobName: r.jobName,
    startedAt: r.startedAt,
    endedAt: r.endedAt,
    status: r.status,
    total: r.total,
    processed: r.processed,
    skipped: r.skipped,
    errorCount: r.errorCount,
    errorMessage: r.errorMessage,
    errors: r.errors,
  });
}

console.log('\n=== 最近 10 条 SignalAlert ===');
const alerts = await p.signalAlert.findMany({
  orderBy: { createdAt: 'desc' },
  take: 10,
});
for (const a of alerts) {
  console.log({
    ticker: a.ticker,
    signalType: a.signalType,
    overallSignal: a.overallSignal,
    note: a.note,
    createdAt: a.createdAt,
  });
}

console.log('\n=== starred 的收藏 ===');
const stars = await p.favorite.findMany({
  where: { starred: true },
  select: { ticker: true, name: true, userId: true },
});
for (const s of stars) {
  console.log(s);
}

console.log('\n=== 最近 5 条 TechnicalSignalSnapshot ===');
const snaps = await p.technicalSignalSnapshot.findMany({
  orderBy: { updatedAt: 'desc' },
  take: 5,
});
for (const s of snaps) {
  console.log({ ticker: s.ticker, overall: s.overall, updatedAt: s.updatedAt });
}

await p.$disconnect();
