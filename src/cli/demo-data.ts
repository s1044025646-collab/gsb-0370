import type { TradeInput } from '../types.js';

/**
 * 主演示：证券 A 以 1000 分/股买入 3 股、买入手续费 1 分，
 * 总成本 = 3*1000 + 1 = 3001 分。随后分三次各卖 1 股（零手续费、单价 1000），
 * 按固定余分规则，三笔结转成本依次为 1000、1000、1001 分。
 * 再买入 2 股（1000 分/股，零费）并跨两个批次卖出。
 * 证券 B 展示不同证券独立、全量卖出、大整数、同价不同编号。
 */
export function demoMainTrades(): TradeInput[] {
  return [
    { tradeId: 'A-B1', seq: 1, security: 'SEC-A', side: 'BUY', qty: 3, price: 1000, fee: 1 },
    { tradeId: 'A-S1', seq: 2, security: 'SEC-A', side: 'SELL', qty: 1, price: 1000, fee: 0 },
    { tradeId: 'A-S2', seq: 3, security: 'SEC-A', side: 'SELL', qty: 1, price: 1000, fee: 0 },
    { tradeId: 'A-S3', seq: 4, security: 'SEC-A', side: 'SELL', qty: 1, price: 1000, fee: 0 },
    { tradeId: 'A-B2', seq: 5, security: 'SEC-A', side: 'BUY', qty: 2, price: 1000, fee: 0 },
    { tradeId: 'A-S4', seq: 6, security: 'SEC-A', side: 'SELL', qty: 2, price: 1000, fee: 0 },

    { tradeId: 'B-B1', seq: 7, security: 'SEC-B', side: 'BUY', qty: 2, price: 1_000_000_000_000, fee: 0 },
    { tradeId: 'B-B2', seq: 8, security: 'SEC-B', side: 'BUY', qty: 1, price: 1_000_000_000_000, fee: 0 },
    { tradeId: 'B-S1', seq: 9, security: 'SEC-B', side: 'SELL', qty: 3, price: 1_000_000_000_000, fee: 7 },
  ];
}

/** 在 SEC-A 已清空后再卖 1 股，必然超卖，用于演示整笔拒绝与回滚。 */
export function demoOversellTrade(): TradeInput {
  return { tradeId: 'A-OVER', seq: 10, security: 'SEC-A', side: 'SELL', qty: 1, price: 1000, fee: 0 };
}

/** 历史更正：基于 v1 重算 SEC-A（将买入手续费 1 分删除），证券 B 保持不变。 */
export function demoCorrectionTrades(): TradeInput[] {
  return [
    { tradeId: 'A-B1', seq: 1, security: 'SEC-A', side: 'BUY', qty: 3, price: 1000, fee: 0 },
    { tradeId: 'A-S1', seq: 2, security: 'SEC-A', side: 'SELL', qty: 1, price: 1000, fee: 0 },
    { tradeId: 'A-S2', seq: 3, security: 'SEC-A', side: 'SELL', qty: 1, price: 1000, fee: 0 },
    { tradeId: 'A-S3', seq: 4, security: 'SEC-A', side: 'SELL', qty: 1, price: 1000, fee: 0 },
    { tradeId: 'A-B2', seq: 5, security: 'SEC-A', side: 'BUY', qty: 2, price: 1000, fee: 0 },
    { tradeId: 'A-S4', seq: 6, security: 'SEC-A', side: 'SELL', qty: 2, price: 1000, fee: 0 },
    { tradeId: 'B-B1', seq: 7, security: 'SEC-B', side: 'BUY', qty: 2, price: 1_000_000_000_000, fee: 0 },
    { tradeId: 'B-B2', seq: 8, security: 'SEC-B', side: 'BUY', qty: 1, price: 1_000_000_000_000, fee: 0 },
    { tradeId: 'B-S1', seq: 9, security: 'SEC-B', side: 'SELL', qty: 3, price: 1_000_000_000_000, fee: 7 },
  ];
}
