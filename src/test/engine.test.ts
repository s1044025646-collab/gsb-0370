import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeFifo } from '../engine.js';
import { AppError } from '../errors.js';
import type { TradeInput } from '../types.js';

function t(
  tradeId: string,
  seq: number,
  security: string,
  side: 'BUY' | 'SELL',
  qty: number,
  price: number,
  fee = 0,
): TradeInput {
  return { tradeId, seq, security, side, qty, price, fee };
}

test('3001 分三批余分：三次各卖一股结转 1000/1000/1001', () => {
  const report = computeFifo([
    t('B1', 1, 'A', 'BUY', 3, 1000, 1),
    t('S1', 2, 'A', 'SELL', 1, 1000),
    t('S2', 3, 'A', 'SELL', 1, 1000),
    t('S3', 4, 'A', 'SELL', 1, 1000),
  ]);
  assert.deepEqual(
    report.sales.map((s) => s.costConsumed),
    [1000n, 1000n, 1001n],
  );
  assert.deepEqual(
    report.sales.map((s) => s.realizedPnl),
    [0n, 0n, -1n],
  );
  const lot = report.lots[0]!;
  assert.equal(lot.remainingQty, 0n);
  assert.equal(lot.remainingCost, 0n, '清空后不得留下孤立成本');
  assert.equal(report.totals.remainingCost, 0n);
  assert.equal(
    report.totals.totalBuyCost,
    report.totals.costCarried + report.totals.remainingCost,
  );
});

test('跨两个批次的卖出：命中明细数量之和等于卖出数量，成本守恒', () => {
  const report = computeFifo([
    t('B1', 1, 'A', 'BUY', 2, 1000, 1),
    t('B2', 2, 'A', 'BUY', 3, 2000, 0),
    t('S1', 3, 'A', 'SELL', 4, 1500, 5),
  ]);
  const sale = report.sales[0]!;
  assert.equal(sale.hits.length, 2);
  assert.equal(sale.hits[0]!.buyTradeId, 'B1');
  assert.equal(sale.hits[0]!.consumedQty, 2n);
  assert.equal(sale.hits[0]!.costTaken, 2001n);
  assert.equal(sale.hits[1]!.buyTradeId, 'B2');
  assert.equal(sale.hits[1]!.consumedQty, 2n);
  assert.equal(sale.hits[1]!.costBefore, 6000n);
  assert.equal(sale.hits[1]!.costTaken, 4000n, 'floor(6000*2/3)=4000');
  assert.equal(sale.hits[1]!.costAfter, 2000n);
  const hitQty = sale.hits.reduce((s, h) => s + h.consumedQty, 0n);
  assert.equal(hitQty, 4n);
  assert.equal(sale.grossRevenue, 6000n);
  assert.equal(sale.netRevenue, 5995n, '手续费只在整笔扣一次');
  assert.equal(sale.costConsumed, 6001n);
  assert.equal(sale.realizedPnl, -6n);
  assert.equal(sale.hits.reduce((s, h) => s + h.pnlContribution, 0n), sale.realizedPnl);
  assert.equal(report.totals.totalBuyCost, report.totals.costCarried + report.totals.remainingCost);
});

test('超卖整笔拒绝', () => {
  assert.throws(
    () =>
      computeFifo([
        t('B1', 1, 'A', 'BUY', 1, 1000),
        t('S1', 2, 'A', 'SELL', 2, 1000),
      ]),
    (err) => err instanceof AppError && err.code === 'OVERSOLD',
  );
});

test('不同证券互不混用且独立汇总', () => {
  const report = computeFifo([
    t('B1', 1, 'A', 'BUY', 1, 1000),
    t('B2', 2, 'B', 'BUY', 1, 500),
    t('S1', 3, 'A', 'SELL', 1, 1200),
  ]);
  const a = report.summaries.find((s) => s.security === 'A')!;
  const b = report.summaries.find((s) => s.security === 'B')!;
  assert.equal(a.realizedPnl, 200n);
  assert.equal(a.remainingQty, 0n);
  assert.equal(b.remainingQty, 1n);
  assert.equal(b.remainingCost, 500n);
  assert.equal(b.realizedPnl, 0n);
});

test('全量卖出、零手续费、同价不同编号不合并来源', () => {
  const report = computeFifo([
    t('B1', 1, 'A', 'BUY', 2, 100),
    t('B2', 2, 'A', 'BUY', 2, 100),
    t('S1', 3, 'A', 'SELL', 4, 100),
  ]);
  assert.equal(report.lots.length, 2, '同价也保留两个原始批次');
  const sale = report.sales[0]!;
  assert.equal(sale.hits.length, 2);
  assert.equal(sale.fee, 0n);
  assert.equal(sale.realizedPnl, 0n);
  assert.equal(report.totals.remainingCost, 0n);
});

test('大整数金额（bigint，不用浮点）', () => {
  const big = 1_000_000_000_000;
  const report = computeFifo([
    t('B1', 1, 'A', 'BUY', 3, big),
    t('S1', 2, 'A', 'SELL', 1, big),
  ]);
  const lot = report.lots[0]!;
  assert.equal(lot.initialCost, 3_000_000_000_000n);
  assert.equal(lot.remainingCost, 2_000_000_000_000n);
  assert.equal(report.sales[0]!.realizedPnl, 0n);
});

test('余分随分笔方式变化：整笔一次卖出带走全部，分批产生余分', () => {
  const once = computeFifo([t('B1', 1, 'A', 'BUY', 3, 100, 1), t('S1', 2, 'A', 'SELL', 3, 100)]);
  assert.equal(once.sales[0]!.costConsumed, 301n);

  const split = computeFifo([
    t('B1', 1, 'A', 'BUY', 3, 100, 1),
    t('S1', 2, 'A', 'SELL', 1, 100),
    t('S2', 3, 'A', 'SELL', 1, 100),
  ]);
  assert.deepEqual(split.sales.map((s) => s.costConsumed), [100n, 100n]);
  assert.equal(split.lots[0]!.remainingCost, 101n, '余分留在最后一部分');
});
