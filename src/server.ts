import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { pathToFileURL } from 'node:url';
import { LedgerService } from './service.js';
import { AppError } from './errors.js';

interface JsonError {
  error: { code: string; message: string; details?: unknown };
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(text);
}

function readJson(req: IncomingMessage, limitBytes = 5 * 1024 * 1024): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > limitBytes) {
        reject(new AppError('BAD_REQUEST', `请求体超过 ${limitBytes} 字节上限`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (chunks.length === 0) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new AppError('BAD_REQUEST', '请求体不是合法 JSON'));
      }
    });
    req.on('error', reject);
  });
}

function errorBody(err: unknown): { status: number; body: JsonError } {
  if (err instanceof AppError) {
    const statusMap: Record<string, number> = {
      VALIDATION_ERROR: 400,
      SEQ_CONFLICT: 409,
      TRADE_ID_CONFLICT: 409,
      OVERSOLD: 422,
      BAD_REQUEST: 400,
      LEDGER_NOT_FOUND: 404,
      VERSION_NOT_FOUND: 404,
      INTERNAL_ERROR: 500,
    };
    return {
      status: statusMap[err.code] ?? 500,
      body: { error: { code: err.code, message: err.message, details: err.details } },
    };
  }
  const message = err instanceof Error ? err.message : String(err);
  return { status: 500, body: { error: { code: 'INTERNAL_ERROR', message } } };
}

export function createApp(service: LedgerService): Server {
  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const path = url.pathname.replace(/\/+$/, '') || '/';
      const method = req.method ?? 'GET';

      if (method === 'GET' && path === '/health') {
        sendJson(res, 200, { ok: true });
        return;
      }

      const seg = path.split('/').filter(Boolean);

      if (method === 'POST' && path === '/ledgers') {
        const body = (await readJson(req)) as { name?: string; trades?: unknown[] };
        if (typeof body.name !== 'string' || body.name.trim().length === 0) {
          throw new AppError('VALIDATION_ERROR', 'name 为必填非空字符串');
        }
        if (body.trades !== undefined) {
          if (!Array.isArray(body.trades)) throw new AppError('VALIDATION_ERROR', 'trades 必须是数组');
          const result = service.createWithTrades(body.name.trim(), body.trades);
          sendJson(res, 201, result);
          return;
        }
        sendJson(res, 201, service.createLedger(body.name.trim()));
        return;
      }

      if (method === 'GET' && path === '/ledgers') {
        sendJson(res, 200, { ledgers: service.listLedgers() });
        return;
      }

      const ledgerId = seg[0] === 'ledgers' && seg[1] ? Number(seg[1]) : NaN;
      if (!Number.isInteger(ledgerId)) {
        sendJson(res, 404, { error: { code: 'BAD_REQUEST', message: `未找到路由: ${method} ${path}` } });
        return;
      }
      const versionParam = url.searchParams.get('version');
      const version = versionParam !== null ? Number(versionParam) : undefined;
      if (versionParam !== null && !Number.isInteger(version)) {
        throw new AppError('VALIDATION_ERROR', 'version 必须是整数');
      }

      if (method === 'GET' && seg.length === 2) {
        sendJson(res, 200, service.getReport(ledgerId, version));
        return;
      }
      if (method === 'GET' && seg.length === 3 && seg[2] === 'versions') {
        sendJson(res, 200, { versions: service.listVersions(ledgerId) });
        return;
      }
      if (method === 'GET' && seg.length === 3 && seg[2] === 'lots') {
        const security = url.searchParams.get('security') ?? undefined;
        sendJson(res, 200, service.lots(ledgerId, security, version));
        return;
      }
      if (method === 'GET' && seg.length === 4 && seg[2] === 'sales') {
        sendJson(res, 200, service.explainSale(ledgerId, decodeURIComponent(seg[3]!), version));
        return;
      }
      if (method === 'POST' && seg.length === 3 && seg[2] === 'trades') {
        const body = (await readJson(req)) as { trades?: unknown[]; note?: string };
        if (!Array.isArray(body.trades)) throw new AppError('VALIDATION_ERROR', 'trades 必须是数组');
        sendJson(res, 201, service.appendTrades(ledgerId, body.trades, body.note ?? null));
        return;
      }
      if (method === 'POST' && seg.length === 3 && seg[2] === 'corrections') {
        const body = (await readJson(req)) as { parentVersion?: number; trades?: unknown[]; note?: string };
        if (!Number.isInteger(body.parentVersion)) {
          throw new AppError('VALIDATION_ERROR', 'parentVersion 必须是整数');
        }
        if (!Array.isArray(body.trades)) throw new AppError('VALIDATION_ERROR', 'trades 必须是数组');
        sendJson(res, 201, service.correctHistory(ledgerId, body.parentVersion!, body.trades, body.note ?? null));
        return;
      }

      sendJson(res, 404, { error: { code: 'BAD_REQUEST', message: `未找到路由: ${method} ${path}` } });
    } catch (err) {
      if (!res.headersSent) {
        const { status, body } = errorBody(err);
        sendJson(res, status, body);
      }
    }
  });
}

/** 返回一个可用的空闲 TCP 端口。 */
export function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      probe.close(() => resolve(port));
    });
    probe.on('error', reject);
  });
}

async function main(): Promise<void> {
  const { resolve } = await import('node:path');
  const { LedgerStore } = await import('./db.js');

  const args = process.argv.slice(2);
  const portArg = args.indexOf('--port');
  const requestedPort = portArg >= 0 ? Number(args[portArg + 1]) : NaN;
  const dbArg = args.indexOf('--db');
  const dbPath = dbArg >= 0 ? args[dbArg + 1]! : resolve('data/ledger.sqlite');

  const store = new LedgerStore(dbPath);
  const service = new LedgerService(store);
  const server = createApp(service);
  const port = Number.isInteger(requestedPort) && requestedPort > 0 ? requestedPort : await getFreePort();

  server.listen(port, '127.0.0.1', () => {
    console.log(`FIFO 账本服务已启动`);
    console.log(`地址: http://127.0.0.1:${port}`);
    console.log(`数据库: ${dbPath}`);
  });

  const shutdown = () => {
    server.close(() => {
      store.close();
      process.exit(0);
    });
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
