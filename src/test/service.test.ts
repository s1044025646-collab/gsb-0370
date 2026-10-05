import test from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../db/store";
import { LedgerService } from "../core/service";
import { AppError } from "../core/errors";

function tempDb(): string {
  const dir = join(tmpdir(), `fifo-test-${process.pid}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
  return join(dir, "test.db");
}

function txns() {
  return [
    { seq: 1, txnId: "B1", securityId: "S1", side: "BUY", qty: 3, price: 1000, fee: 1 },
    { seq: 2, txnId: "S1", securityId: "S1", side: "SELL", qty: 1, price: 1000, fee: 0 },
  ];
}

test("建账+导入+重算结果稳定（重新加载一致）", () => {
  const path = tempDb();
  const store = new Store(path);
  const service = new LedgerService(store);
  service.createLedger("L1");
  const r1 = service.importInto("L1", txns());
  assert.equal(r1.version, 1);
  const r2 = service.report("L1");
  assert.deepEqual(
    r2.report.sells.map((s) => s.allocatedCost),
    r1.report.sells.map((s) => s.allocatedCost)
  );
  store.close();

  const store2 = new Store(path);
  const service2 = new LedgerService(store2);
  const r3 = service2.report("L1");
  assert.deepEqual(r3.report.sells.map((s) => s.allocatedCost), [1000n]);
  store2.close();
  rmSync(join(path, ".."), { recursive: true, force: true });
});

test("超卖/非法导入不改变有效账本（回滚）", () => {
  const path = tempDb();
  const store = new Store(path);
  const service = new LedgerService(store);
  service.createLedger("L1");
  service.importInto("L1", txns());

  assert.throws(
    () =>
      service.append("L1", [
        { seq: 3, txnId: "S2", securityId: "S1", side: "SELL", qty: 99, price: 1, fee: 0 },
      ]),
    (e: unknown) => e instanceof AppError && e.code === "OVERSOLD"
  );
  // 追加失败后账本仍是 2 笔
  assert.equal(service.report("L1").report.buys.length + service.report("L1").report.sells.length, 2);

  assert.throws(
    () =>
      service.importInto("L1", [
        { seq: 9, txnId: "X", securityId: "S1", side: "SELL", qty: 99, price: 1, fee: 0 },
      ]),
    AppError
  );
  store.close();
  rmSync(join(path, ".."), { recursive: true, force: true });
});

test("幂等追加与 txnId 冲突", () => {
  const path = tempDb();
  const store = new Store(path);
  const service = new LedgerService(store);
  service.createLedger("L1");
  service.importInto("L1", txns());

  const same = txns()[0]!;
  const added = service.append("L1", [
    same,
    { seq: 3, txnId: "S2", securityId: "S1", side: "SELL", qty: 1, price: 1200, fee: 0 },
  ]);
  assert.equal(added.applied, 1);
  assert.equal(added.skipped, 1);

  assert.throws(
    () =>
      service.append("L1", [
        { seq: 4, txnId: "B1", securityId: "S1", side: "BUY", qty: 5, price: 1, fee: 0 },
      ]),
    (e: unknown) => e instanceof AppError && e.code === "TXN_DUPLICATE_CONFLICT"
  );

  assert.throws(
    () =>
      service.append("L1", [
        { seq: 1, txnId: "B9", securityId: "S1", side: "BUY", qty: 1, price: 1, fee: 0 },
      ]),
    (e: unknown) => e instanceof AppError && e.code === "SEQ_CONFLICT"
  );
  store.close();
  rmSync(join(path, ".."), { recursive: true, force: true });
});

test("历史更正生成新版本，旧报告保留；旧版本仍可查", () => {
  const path = tempDb();
  const store = new Store(path);
  const service = new LedgerService(store);
  service.createLedger("L1");
  service.importInto("L1", txns());
  const v1Report = service.report("L1", 1);
  assert.equal(v1Report.report.sells[0]!.realizedPnl, 0n); // 1000 - 1000

  const corrected = service.correct(
    "L1",
    [
      { seq: 1, txnId: "B1", securityId: "S1", side: "BUY", qty: 3, price: 1000, fee: 1 },
      { seq: 2, txnId: "S1", securityId: "S1", side: "SELL", qty: 2, price: 1000, fee: 0 },
    ],
    { note: "卖出数量更正为 2" }
  );
  assert.equal(corrected.version, 2);
  // v1 原样保留
  const oldAgain = service.report("L1", 1);
  assert.equal(oldAgain.report.sells[0]!.qty, 1);
  const versions = service.versions("L1");
  assert.deepEqual(versions.map((v) => v.version), [1, 2]);
  assert.equal(versions[0]!.archived, true);
  // v2：卖 2 股成本 floor(3001*2/3)=2000
  assert.equal(service.report("L1", 2).report.sells[0]!.allocatedCost, 2000n);
  store.close();
  rmSync(join(path, ".."), { recursive: true, force: true });
});

test("更正时超卖被拒且不产生新版本", () => {
  const path = tempDb();
  const store = new Store(path);
  const service = new LedgerService(store);
  service.createLedger("L1");
  service.importInto("L1", txns());

  assert.throws(
    () =>
      service.correct("L1", [
        { seq: 1, txnId: "B1", securityId: "S1", side: "BUY", qty: 1, price: 1, fee: 0 },
        { seq: 2, txnId: "S1", securityId: "S1", side: "SELL", qty: 2, price: 1, fee: 0 },
      ]),
    (e: unknown) => e instanceof AppError && e.code === "OVERSOLD"
  );
  assert.deepEqual(service.versions("L1").map((v) => v.version), [1]);
  store.close();
  rmSync(join(path, ".."), { recursive: true, force: true });
});

test("卖出解释查询", () => {
  const path = tempDb();
  const store = new Store(path);
  const service = new LedgerService(store);
  service.createLedger("L1");
  service.importInto("L1", txns());
  const bySeq = service.sell("L1", "2");
  assert.equal(bySeq.sell.txnId, "S1");
  const byId = service.sell("L1", "S1");
  assert.equal(byId.sell.seq, 2);
  assert.throws(() => service.sell("L1", "999"), (e: unknown) => e instanceof AppError && e.code === "NOT_FOUND");
  store.close();
  rmSync(join(path, ".."), { recursive: true, force: true });
});
