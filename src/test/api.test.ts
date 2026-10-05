import test from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createApp, pickFreePort } from "../api/server";
import type { Server } from "node:http";

async function api(base: string, method: string, path: string, body?: unknown) {
  const res = await fetch(base + path, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = (await res.json()) as any;
  return { status: res.status, json };
}

test("HTTP API 全链路：建账/导入/查询/追加幂等/超卖 4xx/更正版本", async () => {
  const dir = join(tmpdir(), `fifo-api-${process.pid}-${Date.now()}`);
  const dbPath = join(dir, "api.db");
  const server: Server = createApp(dbPath);
  const port = await pickFreePort();
  await new Promise<void>((r) => server.listen(port, "127.0.0.1", r));
  const base = `http://127.0.0.1:${port}`;

  try {
    const health = await api(base, "GET", "/api/health");
    assert.equal(health.status, 200);
    assert.equal(health.json.ok, true);

    assert.equal((await api(base, "POST", "/api/ledgers", { id: "L1" })).status, 200);
    assert.equal((await api(base, "POST", "/api/ledgers", { id: "L1" })).status, 400);

    const imported = await api(base, "POST", "/api/ledgers/L1/import", {
      transactions: [
        { seq: 1, txnId: "B1", securityId: "S1", side: "BUY", qty: 3, price: 1000, fee: 1 },
        { seq: 2, txnId: "S1", securityId: "S1", side: "SELL", qty: 1, price: 1000, fee: 0 },
        { seq: 3, txnId: "S2", securityId: "S1", side: "SELL", qty: 1, price: 1000, fee: 0 },
        { seq: 4, txnId: "S3", securityId: "S1", side: "SELL", qty: 1, price: 1000, fee: 0 },
      ],
    });
    assert.equal(imported.status, 200);
    assert.deepEqual(imported.json.report.sells.map((s: any) => s.allocatedCost.fen), ["1000", "1000", "1001"]);

    const sell = await api(base, "GET", "/api/ledgers/L1/sells/4");
    assert.equal(sell.json.sell.allocatedCost.yuan, "10.01");

    const oversold = await api(base, "POST", "/api/ledgers/L1/append", {
      transactions: [{ seq: 5, txnId: "BAD", securityId: "S1", side: "SELL", qty: 1, price: 1, fee: 0 }],
    });
    assert.equal(oversold.status, 400);
    assert.equal(oversold.json.error.code, "OVERSOLD");

    const idem = await api(base, "POST", "/api/ledgers/L1/append", {
      transactions: [
        { seq: 2, txnId: "S1", securityId: "S1", side: "SELL", qty: 1, price: 1000, fee: 0 },
      ],
    });
    assert.equal(idem.status, 200);
    assert.equal(idem.json.skipped, 1);

    const corrected = await api(base, "POST", "/api/ledgers/L1/correct", {
      note: "test",
      transactions: [
        { seq: 1, txnId: "B1", securityId: "S1", side: "BUY", qty: 3, price: 1000, fee: 1 },
      ],
    });
    assert.equal(corrected.status, 200);
    assert.equal(corrected.json.version, 2);

    const versions = await api(base, "GET", "/api/ledgers/L1/versions");
    assert.deepEqual(versions.json.versions.map((v: any) => v.version), [1, 2]);

    const oldReport = await api(base, "GET", "/api/ledgers/L1/report?version=1");
    assert.equal(oldReport.json.report.sells.length, 3);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    rmSync(dir, { recursive: true, force: true });
  }
});
