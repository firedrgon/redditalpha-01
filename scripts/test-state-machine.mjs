// 验证状态机决策表
// 模拟：先准备一些历史 alert，再调用 processStarredStock 看 decision

const ticker = "TEST";
const userId = "test_user";
const prismaMock = {
  signalAlert: {
    findFirst: async ({ where, orderBy }) => {
      // 模拟"最近一条 buy/sell"
      const hist = globalThis.__testHistory || [];
      const filtered = hist
        .filter(a => a.userId === where.userId && a.ticker === where.ticker && ['buy','sell'].includes(a.signalType))
        .sort((a,b) => b.createdAt - a.createdAt);
      return filtered[0] || null;
    },
    create: async ({ data }) => {
      const a = { ...data, createdAt: Date.now() };
      globalThis.__testHistory = globalThis.__testHistory || [];
      globalThis.__testHistory.push(a);
      console.log(`  [DB] create alert: ${data.signalType} for ${data.ticker}`);
      return a;
    },
  },
  technicalSignalSnapshot: {
    upsert: async () => ({}),
  },
};

// stub 技术信号
import { fetchTradingViewTechnicals } from '../lib/technical.ts';
