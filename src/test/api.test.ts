import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { LedgerStore } from '../db.js';
import { LedgerService } from '../service.js';
import { createApp } from '../server.js';
import type { Server } from 'node:http';

const dbPath = join(tmpdir(), `fifo-api-${process.pid}-${Date.now()}.sqlite`);
const store = new LedgerStore(dbPath);
const service = new LedgerService(store);
const server: Server = createApp(service);
let base: string;

before(async () => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  store.close();
  rmSync(dbPath, { force: true });
});

async function jsonRequest(path: string, init?: RequestInit): Promise<{ status: number; body: any }> {
  const res = await fetch(base + path, {
    method: init?.method ?? 'GET',
    headers: { 'Content-Type': 'application/json' },
    body: init?.body,
  });
  return { status: res.status, body: await res.json() };
}

test('API 全流程：建账、查询、追加、超卖422、更正', async () => {
  const created = await jsonRequest('/ledgers', {
    method: 'POST',
    body: JSON.stringify({
      name: 'api',
      trades: [
        { tradeId: 'B1', seq: 1, security: 'A', side: 'BUY', qty: 3, price: 1000, fee: 1 },
        { tradeId: 'S1', seq: 2, security: 'A', side: 'SELL', qty: 1, price: 1000, fee: 0 },
      ],
    }),
  });
  assert.equal(created.status, 201);
  const id = created.body.ledgerId;

  const report = await jsonRequest(`/ledgers/${id}`);
  assert.equal(report.body.report.sales[0].costConsumed, '1000');

  const oversold = await jsonRequest(`/ledgers/${id}/trades`, {
    method: 'POST',
    body: JSON.stringify({
      trades: [{ tradeId: 'X', seq: 3, security: 'A', side: 'SELL', qty: 99, price: 1, fee: 0 }],
    }),
  });
  assert.equal(oversold.status, 422);
  assert.equal(oversold.body.error.code, 'OVERSOLD');

  const corrected = await jsonRequest(`/ledgers/${id}/corrections`, {
    method: 'POST',
    body: JSON.stringify({
      parentVersion: 1,
      note: '改',
      trades: [{ tradeId: 'B1', seq: 1, security: 'A', side: 'BUY', qty: 1, price: 100, fee: 0 }],
    }),
  });
  assert.equal(corrected.status, 201);
  assert.equal(corrected.body.version, 2);

  const sale = await jsonRequest(`/ledgers/${id}/sales/S1?version=1`);
  assert.equal(sale.body.sale.tradeId, 'S1');
  assert.equal(sale.body.sale.hits[0].costTaken, '1000');

  const notFound = await jsonRequest('/ledgers/99999');
  assert.equal(notFound.status, 404);
});
