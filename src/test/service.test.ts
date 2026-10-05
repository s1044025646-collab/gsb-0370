import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LedgerStore } from '../db.js';
import { LedgerService } from '../service.js';
import { AppError } from '../errors.js';
import type { TradeInput } from '../types.js';

const dbPath = join(tmpdir(), `fifo-test-${process.pid}-${Date.now()}.sqlite`);
let store: LedgerStore;
let service: LedgerService;

const baseTrades: TradeInput[] = [
  { tradeId: 'B1', seq: 1, security: 'A', side: 'BUY', qty: 3, price: 1000, fee: 1 },
  { tradeId: 'S1', seq: 2, security: 'A', side: 'SELL', qty: 1, price: 1000, fee: 0 },
];

before(() => {
  store = new LedgerStore(dbPath);
  service = new LedgerService(store);
});

after(() => {
  store.close();
  rmSync(dbPath, { force: true });
  rmSync(`${dbPath}-wal`, { force: true });
  rmSync(`${dbPath}-shm`, { force: true });
});

test('建账导入与重算复现', () => {
  const created = service.createWithTrades('test', baseTrades);
  assert.equal(created.report.sales[0]!.costConsumed, 1000n);
  const again = service.getReport(created.ledgerId, 1);
  assert.equal(again.report.sales[0]!.costConsumed, 1000n);
});

test('幂等：相同编号相同内容可重复导入', () => {
  const { ledgerId } = service.createWithTrades('idem', [
    { tradeId: 'B1', seq: 1, security: 'A', side: 'BUY', qty: 1, price: 100, fee: 0 },
  ]);
  const result = service.appendTrades(
    ledgerId,
    [{ tradeId: 'B1', seq: 1, security: 'A', side: 'BUY', qty: 1, price: 100, fee: 0 }],
    null,
  );
  assert.equal(result.inserted, 0);
  assert.equal(result.deduplicated, 1);
});

test('编号相同内容不同 -> 冲突 409', () => {
  const { ledgerId } = service.createWithTrades('conflict', [
    { tradeId: 'B1', seq: 1, security: 'A', side: 'BUY', qty: 1, price: 100, fee: 0 },
  ]);
  assert.throws(
    () =>
      service.appendTrades(
        ledgerId,
        [{ tradeId: 'B1', seq: 2, security: 'A', side: 'BUY', qty: 2, price: 100, fee: 0 }],
        null,
      ),
    (e) => e instanceof AppError && e.code === 'TRADE_ID_CONFLICT',
  );
});

test('序号冲突拒绝', () => {
  const { ledgerId } = service.createWithTrades('seq', [
    { tradeId: 'B1', seq: 1, security: 'A', side: 'BUY', qty: 1, price: 100, fee: 0 },
  ]);
  assert.throws(
    () =>
      service.appendTrades(
        ledgerId,
        [{ tradeId: 'B2', seq: 1, security: 'A', side: 'BUY', qty: 1, price: 100, fee: 0 }],
        null,
      ),
    (e) => e instanceof AppError && e.code === 'SEQ_CONFLICT',
  );
});

test('超卖追加失败不改变当前版本（回滚）', () => {
  const { ledgerId } = service.createWithTrades('oversold', baseTrades);
  const versionsBefore = service.listVersions(ledgerId).length;
  assert.throws(
    () =>
      service.appendTrades(
        ledgerId,
        [{ tradeId: 'X', seq: 3, security: 'A', side: 'SELL', qty: 99, price: 1000, fee: 0 }],
        null,
      ),
    (e) => e instanceof AppError && e.code === 'OVERSOLD',
  );
  const versionsAfter = service.listVersions(ledgerId).length;
  assert.equal(versionsBefore, versionsAfter);
  const { report, meta } = service.getReport(ledgerId);
  assert.equal(meta.version, 1, '当前版本仍为 v1');
  assert.equal(report.totals.remainingCost, 2001n);
});

test('历史更正生成新版本并保留原报告', () => {
  const { ledgerId } = service.createWithTrades('correct', baseTrades);
  const corrected = service.correctHistory(
    ledgerId,
    1,
    [
      { tradeId: 'B1', seq: 1, security: 'A', side: 'BUY', qty: 3, price: 1000, fee: 0 },
      { tradeId: 'S1', seq: 2, security: 'A', side: 'SELL', qty: 1, price: 1000, fee: 0 },
    ],
    '去掉手续费',
  );
  assert.equal(corrected.version, 2);
  const v1 = service.getReport(ledgerId, 1);
  assert.equal(v1.report.lots[0]!.initialCost, 3001n, 'v1 原报告保留');
  const v2 = service.getReport(ledgerId, 2);
  assert.equal(v2.report.lots[0]!.initialCost, 3000n);
});

test('重启后重新打开数据库结果一致', () => {
  store.close();
  const reopened = new LedgerStore(dbPath);
  const svc2 = new LedgerService(reopened);
  const ledgers = svc2.listLedgers();
  assert.ok(ledgers.some((l) => l.name === 'correct'));
  const correct = ledgers.find((l) => l.name === 'correct')!;
  const { report } = svc2.getReport(correct.id, 1);
  assert.equal(report.sales[0]!.costConsumed, 1000n);
  assert.equal(report.totals.remainingCost, 2001n);
  reopened.close();
  store = new LedgerStore(dbPath);
  service = new LedgerService(store);
});

test('非法字段校验', () => {
  assert.throws(
    () =>
      service.createWithTrades('bad', [
        { tradeId: '', seq: 1, security: 'A', side: 'BUY', qty: 1, price: 0, fee: 0 },
      ]),
    (e) => e instanceof AppError && e.code === 'VALIDATION_ERROR',
  );
  assert.throws(
    () =>
      service.createWithTrades('bad2', [
        { tradeId: 'T', seq: 1, security: 'A', side: 'SHORT', qty: 1, price: 0, fee: 0 },
      ]),
    (e) => e instanceof AppError && e.code === 'VALIDATION_ERROR',
  );
});
