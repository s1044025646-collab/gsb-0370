import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createServer as createNetServer } from "node:net";
import { Store } from "../db/store";
import { AppError } from "../core/errors";
import { LedgerService } from "../core/service";
import { reportToDTO } from "../core/serialize";

const DEFAULT_DB = "data/fifo.db";

/** 请求系统选择一个当前空闲的 TCP 端口。 */
export function pickFreePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const srv = createNetServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (addr && typeof addr === "object") {
        const port = addr.port;
        srv.close(() => resolvePort(port));
      } else {
        srv.close(() => reject(new Error("无法获取空闲端口")));
      }
    });
  });
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body, null, 2);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(text);
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buf.length;
    if (size > 5 * 1024 * 1024) {
      throw new AppError("VALIDATION_ERROR", "请求体超过 5MB 上限");
    }
    chunks.push(buf);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new AppError("VALIDATION_ERROR", "请求体不是合法 JSON");
  }
}

interface Route {
  method: string;
  pattern: RegExp;
  handle: (service: LedgerService, match: RegExpMatchArray, body: any, query: URLSearchParams) => unknown;
}

function bodyStr(body: any, key: string): string | undefined {
  const v = body?.[key];
  return typeof v === "undefined" ? undefined : String(v);
}
function bodyVersion(body: any): number | undefined {
  if (body?.version === undefined || body?.version === null) return undefined;
  const n = Number(body.version);
  if (!Number.isSafeInteger(n) || n < 1) throw new AppError("VALIDATION_ERROR", "version 必须是正整数");
  return n;
}

const routes: Route[] = [
  {
    method: "GET",
    pattern: /^\/api\/health$/,
    handle: () => ({ ok: true, service: "fifo-lots", time: new Date().toISOString() }),
  },
  {
    method: "GET",
    pattern: /^\/api\/ledgers$/,
    handle: (service) => ({ ledgers: service.listLedgers() }),
  },
  {
    method: "POST",
    pattern: /^\/api\/ledgers$/,
    handle: (service, _m, body) => {
      const id = bodyStr(body, "id");
      if (!id) throw new AppError("VALIDATION_ERROR", "缺少 id");
      return service.createLedger(id, typeof body?.note === "string" ? body.note : "");
    },
  },
  {
    method: "POST",
    pattern: /^\/api\/ledgers\/([^/]+)\/import$/,
    handle: (service, m, body) => {
      const { version, report } = service.importInto(m[1]!, body?.transactions);
      return { version, report: reportToDTO(report) };
    },
  },
  {
    method: "POST",
    pattern: /^\/api\/ledgers\/([^/]+)\/append$/,
    handle: (service, m, body) => {
      const r = service.append(m[1]!, body?.transactions);
      return { version: r.version, applied: r.applied, skipped: r.skipped, report: reportToDTO(r.report) };
    },
  },
  {
    method: "GET",
    pattern: /^\/api\/ledgers\/([^/]+)\/report$/,
    handle: (service, m, _b, query) => {
      const v = query.has("version") ? Number(query.get("version")) : undefined;
      if (query.has("version") && (!Number.isSafeInteger(v) || v! < 1))
        throw new AppError("VALIDATION_ERROR", "version 必须是正整数");
      const r = service.report(m[1]!, v);
      return { id: m[1], version: r.version, report: reportToDTO(r.report) };
    },
  },
  {
    method: "GET",
    pattern: /^\/api\/ledgers\/([^/]+)\/lots$/,
    handle: (service, m, _b, query) => {
      const v = query.has("version") ? Number(query.get("version")) : undefined;
      const r = service.lots(m[1]!, query.get("security") ?? undefined, v);
      return { id: m[1], version: r.version, lots: r.lots.map((l) => reportToDTO({
        buys: [], sells: [], lots: [l], summaries: [], totalRealizedPnl: 0n,
      }).lots[0]!) };
    },
  },
  {
    method: "GET",
    pattern: /^\/api\/ledgers\/([^/]+)\/sells\/([^/]+)$/,
    handle: (service, m, _b, query) => {
      const v = query.has("version") ? Number(query.get("version")) : undefined;
      const r = service.sell(m[1]!, decodeURIComponent(m[2]!), v);
      return { id: m[1], version: r.version, sell: reportToDTO({
        buys: [], sells: [r.sell], lots: [], summaries: [], totalRealizedPnl: 0n,
      }).sells[0]! };
    },
  },
  {
    method: "POST",
    pattern: /^\/api\/ledgers\/([^/]+)\/correct$/,
    handle: (service, m, body) => {
      const r = service.correct(m[1]!, body?.transactions, {
        baseVersion: bodyVersion(body),
        note: typeof body?.note === "string" ? body.note : "",
      });
      return { version: r.version, report: reportToDTO(r.report) };
    },
  },
  {
    method: "GET",
    pattern: /^\/api\/ledgers\/([^/]+)\/versions$/,
    handle: (service, m) => ({ id: m[1], versions: service.versions(m[1]!) }),
  },
];

export function createApp(dbPath: string): Server {
  const store = new Store(dbPath);
  const service = new LedgerService(store);

  const server = createServer((req, res) => {
    void (async () => {
      try {
        const url = new URL(req.url ?? "/", "http://127.0.0.1");
        if (req.method === "GET" && url.pathname === "/") {
          send(res, 200, {
            service: "fifo-lots",
            endpoints: routes.map((r) => `${r.method} ${r.pattern}`),
          });
          return;
        }
        const body = req.method === "POST" ? await readJson(req) : {};
        for (const route of routes) {
          if (route.method !== req.method) continue;
          const match = url.pathname.match(route.pattern);
          if (!match) continue;
          const result = route.handle(service, match, body as any, url.searchParams);
          send(res, 200, { ok: true, ...(result as object) });
          return;
        }
        send(res, 404, { ok: false, error: { code: "NOT_FOUND", message: `无此路由：${req.method} ${url.pathname}` } });
      } catch (e) {
        if (e instanceof AppError) {
          const status = e.code === "NOT_FOUND" ? 404 : e.code === "VERSION_ARCHIVED" ? 409 : 400;
          send(res, status, { ok: false, error: { code: e.code, message: e.message, details: e.details ?? null } });
        } else {
          send(res, 500, { ok: false, error: { code: "STORAGE_ERROR", message: String((e as Error).message) } });
        }
      }
    })();
  });

  server.on("close", () => store.close());
  return server;
}

async function main(): Promise<void> {
  const dbPath = process.env.FIFO_DB ?? DEFAULT_DB;
  const requested = process.env.PORT ? Number(process.env.PORT) : undefined;
  const port = requested ?? (await pickFreePort());
  const server = createApp(dbPath);
  await new Promise<void>((resolveListen) => server.listen(port, "127.0.0.1", resolveListen));
  const addr = server.address();
  const actualPort = typeof addr === "object" && addr ? addr.port : port;
  process.stdout.write(
    JSON.stringify({ status: "listening", url: `http://127.0.0.1:${actualPort}`, db: dbPath }) + "\n"
  );
}

if (require.main === module) {
  main().catch((e) => {
    process.stderr.write(String(e?.message ?? e) + "\n");
    process.exit(1);
  });
}
