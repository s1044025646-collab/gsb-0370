import test from "node:test";
import assert from "node:assert/strict";
import { computeFromList } from "../core/service";
import { AppError } from "../core/errors";
import type { TxnInput } from "../core/types";

function t(seq: number, side: "BUY" | "SELL", qty: number, price: number, fee: number, securityId = "S1", txnId?: string): TxnInput {
  return { seq, txnId: txnId ?? `T${seq}`, securityId, side, qty, price, fee };
}

test("3001 分三股分三次各卖一股：1000 / 1000 / 1001", () => {
  const report = computeFromList([
    t(1, "BUY", 3, 1000, 1),
    t(2, "SELL", 1, 1000, 0),
    t(3, "SELL", 1, 1000, 0),
    t(4, "SELL", 1, 1000, 0),
  ]);
  const costs = report.sells.map((s) => s.allocatedCost);
  assert.deepEqual(costs, [1000n, 1000n, 1001n]);
  const summary = report.summaries[0]!;
  assert.equal(summary.remainingQty, 0);
  assert.equal(summary.remainingCost, 0n);
  assert.equal(summary.costCarried, 3001n);
  assert.equal(summary.buyTotalCost, summary.costCarried + summary.remainingCost);
  // 清空后无孤立成本
  assert.equal(report.lots.every((l) => l.closed && l.remainingCost === 0n), true);
});

test("跨两个批次的卖出与余分归属", () => {
  const report = computeFromList([
    t(1, "BUY", 2, 500, 0),    // 1000
    t(2, "BUY", 3, 700, 7),    // 2107
    t(3, "SELL", 4, 800, 5),   // 跨批次
  ]);
  const sell = report.sells[0]!;
  assert.equal(sell.consumptions.length, 2);
  assert.equal(sell.consumptions[0]!.buySeq, 1);
  assert.equal(sell.consumptions[0]!.consumedQty, 2);
  assert.equal(sell.consumptions[0]!.costAllocated, 1000n);
  assert.equal(sell.consumptions[1]!.buySeq, 2);
  assert.equal(sell.consumptions[1]!.consumedQty, 2);
  assert.equal(sell.consumptions[1]!.costAllocated, 1404n); // floor(2107*2/3)
  // 批次 2 剩 1 股，成本 703（余分留下）
  const lot2 = report.lots.find((l) => l.buySeq === 2)!;
  assert.equal(lot2.remainingQty, 1);
  assert.equal(lot2.remainingCost, 703n);
  // 净收入 3200-5=3195；盈亏 = 3195 - 2404 = 791
  assert.equal(sell.netIncome, 3195n);
  assert.equal(sell.allocatedCost, 2404n);
  assert.equal(sell.realizedPnl, 791n);
  // 手续费只扣一次：贡献之和 == 已实现盈亏
  const contribSum = sell.consumptions.reduce((s, c) => s + c.pnlContribution, 0n);
  assert.equal(contribSum, sell.realizedPnl);
  // 消耗数量之和等于卖出数量
  assert.equal(sell.consumptions.reduce((s, c) => s + c.consumedQty, 0), 4);
});

test("超卖整笔拒绝（纯引擎）", () => {
  assert.throws(
    () =>
      computeFromList([
        t(1, "BUY", 1, 100, 0),
        t(2, "SELL", 2, 100, 0),
      ]),
    (e: unknown) => e instanceof AppError && e.code === "OVERSOLD"
  );
});

test("不同证券批次互不混用、汇总独立", () => {
  const report = computeFromList([
    t(1, "BUY", 5, 100, 0, "AAA"),
    t(2, "BUY", 5, 200, 0, "BBB"),
    t(3, "SELL", 5, 300, 0, "AAA"),
  ]);
  const aaa = report.summaries.find((s) => s.securityId === "AAA")!;
  const bbb = report.summaries.find((s) => s.securityId === "BBB")!;
  assert.equal(aaa.remainingQty, 0);
  assert.equal(aaa.realizedPnl, 1000n);
  assert.equal(bbb.remainingQty, 5);
  assert.equal(bbb.remainingCost, 1000n);
  assert.equal(bbb.realizedPnl, 0n);
  assert.equal(report.totalRealizedPnl, 1000n);
});

test("全量卖出、零手续费、零单价", () => {
  const report = computeFromList([
    t(1, "BUY", 3, 0, 0),
    t(2, "SELL", 3, 50, 0),
  ]);
  assert.equal(report.sells[0]!.allocatedCost, 0n);
  assert.equal(report.sells[0]!.realizedPnl, 150n);
});

test("大整数金额精确（BigInt，无浮点误差）", () => {
  const big = 1_000_000_000;
  const report = computeFromList([
    t(1, "BUY", 1_000_000, big, big),
    t(2, "SELL", 500_000, big, 123),
  ]);
  const buyCost = BigInt(1_000_000) * BigInt(big) + BigInt(big);
  assert.equal(report.buys[0]!.totalCost, buyCost);
  const sell = report.sells[0]!;
  const expectedCost = (buyCost * 500000n) / 1000000n;
  assert.equal(sell.consumptions[0]!.costAllocated, expectedCost);
  assert.equal(sell.netIncome, BigInt(500000) * BigInt(big) - 123n);
  assert.equal(sell.realizedPnl, sell.netIncome - expectedCost);
});

test("同价不同编号不合并原始来源", () => {
  const report = computeFromList([
    t(1, "BUY", 2, 100, 0, "S1", "X1"),
    t(2, "BUY", 2, 100, 0, "S1", "X2"),
    t(3, "SELL", 3, 100, 0, "S1", "X3"),
  ]);
  assert.equal(report.lots.length, 2);
  assert.deepEqual(
    report.sells[0]!.consumptions.map((c) => [c.buyTxnId, c.consumedQty]),
    [["X1", 2], ["X2", 1]]
  );
});

test("余分随分笔方式变化的示例", () => {
  // 10 股总成本 1003：分 10 次各 1 股 => 前 7 次 100、后 3 次 101
  const txns: TxnInput[] = [t(1, "BUY", 10, 100, 3)];
  for (let i = 0; i < 10; i++) txns.push(t(2 + i, "SELL", 1, 100, 0, "S1", `S${i}`));
  const report = computeFromList(txns);
  const costs = report.sells.map((s) => s.allocatedCost);
  assert.deepEqual(costs, [100n, 100n, 100n, 100n, 100n, 100n, 100n, 101n, 101n, 101n]);
});

test("校验：负数、零数量、非法方向、非法编号", () => {
  assert.throws(() => computeFromList([t(1, "BUY", 0, 100, 0)]), AppError);
  assert.throws(() => computeFromList([t(1, "BUY", 1, -1, 0)]), AppError);
  assert.throws(() => computeFromList([t(1, "BUY", 1, 100, -1)]), AppError);
  assert.throws(
    () => computeFromList([{ seq: 1, txnId: "a", securityId: "s", side: "HOLD", qty: 1, price: 1, fee: 0 } as unknown as TxnInput]),
    AppError
  );
  assert.throws(
    () => computeFromList([{ ...t(1, "BUY", 1, 1, 0), txnId: "bad id!" }]),
    AppError
  );
});
