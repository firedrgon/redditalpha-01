import { PrismaClient } from '@prisma/client';
const p = new PrismaClient();

console.log('=== SignalAlert 全部 ===');
const all = await p.signalAlert.findMany({
  orderBy: { createdAt: 'asc' },
  take: 30,
});
for (const a of all) {
  console.log({
    createdAt: a.createdAt.toISOString(),
    ticker: a.ticker,
    signalType: a.signalType,
    overallSignal: a.overallSignal,
    note: a.note?.slice(0, 80),
  });
}

console.log(`\nTotal: ${await p.signalAlert.count()} alerts`);

await p.$disconnect();
