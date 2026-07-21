import { PrismaClient } from '@prisma/client';
const p = new PrismaClient();

const models = [
  'analysisCache',
  'strategyCategory',
  'strategy',
  'user',
  'account',
  'session',
  'verificationToken',
  'favorite',
  'appSetting',
  'llmModelCache',
  'financeSnapshot',
  'signalAlert',
  'technicalSignalSnapshot',
  'cronRun',
];

console.log('=== 表数据量统计 ===');
for (const m of models) {
  try {
    const count = await p[m].count();
    console.log(`${m.padEnd(30)} ${count}`);
  } catch (e) {
    console.log(`${m.padEnd(30)} ERROR: ${e.message.split('\n')[0]}`);
  }
}

await p.$disconnect();
