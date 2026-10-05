#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { LedgerStore } from '../db.js';
import { LedgerService } from '../service.js';
import { AppError } from '../errors.js';
import { formatAllSales, formatLots, formatSale } from './format.js';
import { demoMainTrades, demoOversellTrade, demoCorrectionTrades } from './demo-data.js';

function parseOpts(argv: string[]): { args: string[]; opts: Map<string, string | boolean> } {
  const args: string[] = [];
  const opts = new Map<string, string | boolean>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith('--')) {
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        opts.set(a.slice(2), next);
        i++;
      } else {
        opts.set(a.slice(2), true);
      }
    } else {
      args.push(a);
    }
  }
  return { args, opts };
}

function readTrades(file: string): unknown[] {
  const raw = JSON.parse(readFileSync(resolve(file), 'utf8'));
  if (Array.isArray(raw)) return raw;
  if (raw && Array.isArray((raw as { trades?: unknown[] }).trades)) {
    return (raw as { trades: unknown[] }).trades;
  }
  throw new AppError('VALIDATION_ERROR', '交易文件必须是数组或含 trades 数组的对象');
}

function reportJson(value: unknown): string {
  return JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2);
}

const HELP = `FIFO 证券成本批次账本 CLI

用法: fifo-ledger <命令> [参数] [--db data/ledger.sqlite]

命令:
  create --name 名称 [--file trades.json]   新建账本，可选一次性导入有序交易
  list                                      列出账本
  report <id> [--version v]                 查看完整核算报告（批次+卖出+汇总）
  lots <id> [--security s] [--version v]    查看未清空批次与持仓汇总（批次消耗表）
  sales <id> [--version v]                  列出全部卖出解释
  sale <id> <tradeId> [--version v]         单笔卖出的命中批次解释
  append <id> --file t.json [--note 说明]    追加交易（生成新版本，失败回滚）
  versions <id>                             列出历史版本
  correct <id> --parent v --file t.json [--note]  历史更正：新清单从头重算为新版本
  export <id> [--version v] [--out f.json]  导出报告 JSON
  demo                                      运行内置演示（含跨批次与超卖拒绝）
  help                                      显示本帮助

金额单位均为整数分；数量为正整数；price 与 fee 允许为 0。
`;

function runDemo(store: LedgerStore): void {
  const service = new LedgerService(store);

  console.log('========== 演示 1：主账票（3 股总成本 3001 分，三次卖 1 股等场景） ==========');
  const created = service.createWithTrades('demo-main', demoMainTrades());
  const id = created.ledgerId;
  console.log(`已建账本 id=${id}，版本 v${created.version}，交易 ${created.totalTrades} 笔`);
  console.log();
  console.log(formatLots(created.report));
  console.log();
  console.log('========== 卖出解释（批次消耗表） ==========');
  console.log(formatAllSales(created.report));

  console.log();
  console.log('========== 演示 2：超卖整笔拒绝（不改动有效账本） ==========');
  const before = service.listVersions(id).length;
  try {
    service.appendTrades(id, [demoOversellTrade()], '尝试超卖（应失败）');
    console.log('错误：超卖竟然被接受！');
  } catch (err) {
    if (err instanceof AppError && err.code === 'OVERSOLD') {
      console.log(`已拒绝 [${err.code}] ${err.message}`);
    } else {
      throw err;
    }
  }
  const after = service.listVersions(id).length;
  console.log(`版本数 拒绝前=${before} 拒绝后=${after}（相同说明有效账本未被改变）`);

  console.log();
  console.log('========== 演示 3：历史更正（基于 v1 重算，保留原报告） ==========');
  const corrected = service.correctHistory(id, 1, demoCorrectionTrades(), '更正：删除手续费');
  console.log(`已生成新版本 v${corrected.version}（父版本 v1），原 v1 报告保留`);
  console.log(`更正后已实现盈亏: ${corrected.report.totals.realizedPnl} 分`);
  console.log();
  console.log('版本列表:');
  for (const v of service.listVersions(id)) {
    console.log(`  v${v.version} 父版本=${v.parentVersion ?? '-'} 交易数=${v.tradeCount} 备注=${v.note ?? ''}`);
  }
}

function main(): void {
  const { args, opts } = parseOpts(process.argv.slice(2));
  const command = args[0] ?? 'help';
  const dbPath = resolve((opts.get('db') as string | undefined) ?? 'data/ledger.sqlite');

  if (command === 'help' || (opts.get('help') as boolean | undefined)) {
    console.log(HELP);
    return;
  }

  const store = new LedgerStore(dbPath);
  try {
    const service = new LedgerService(store);
    const versionOpt = opts.has('version') ? Number(opts.get('version')) : undefined;

    switch (command) {
      case 'demo': {
        runDemo(store);
        break;
      }
      case 'create': {
        const name = opts.get('name');
        if (typeof name !== 'string') throw new AppError('VALIDATION_ERROR', '需要 --name');
        if (opts.has('file')) {
          const result = service.createWithTrades(name, readTrades(opts.get('file') as string));
          console.log(reportJson({ ledgerId: result.ledgerId, version: result.version, totalTrades: result.totalTrades }));
          console.log();
          console.log(formatLots(result.report));
        } else {
          console.log(reportJson(service.createLedger(name)));
        }
        break;
      }
      case 'list': {
        console.log(reportJson(service.listLedgers()));
        break;
      }
      case 'report': {
        const id = Number(args[1]);
        const { report } = service.getReport(id, versionOpt);
        console.log(formatLots(report));
        console.log();
        console.log(formatAllSales(report));
        break;
      }
      case 'lots': {
        const id = Number(args[1]);
        const security = opts.get('security') as string | undefined;
        console.log(reportJson(service.lots(id, security, versionOpt)));
        break;
      }
      case 'sales': {
        const id = Number(args[1]);
        const { report } = service.getReport(id, versionOpt);
        console.log(formatAllSales(report));
        break;
      }
      case 'sale': {
        const id = Number(args[1]);
        const tradeId = args[2];
        if (!tradeId) throw new AppError('VALIDATION_ERROR', '需要 tradeId');
        console.log(formatSale(service.explainSale(id, tradeId, versionOpt).sale));
        break;
      }
      case 'append': {
        const id = Number(args[1]);
        if (!opts.has('file')) throw new AppError('VALIDATION_ERROR', '需要 --file');
        const result = service.appendTrades(id, readTrades(opts.get('file') as string), (opts.get('note') as string) ?? null);
        console.log(`已生成新版本 v${result.version}：新增 ${result.inserted} 笔，幂等去重 ${result.deduplicated} 笔，共 ${result.totalTrades} 笔`);
        console.log(formatLots(result.report));
        break;
      }
      case 'versions': {
        const id = Number(args[1]);
        for (const v of service.listVersions(id)) {
          console.log(`v${v.version} 父版本=${v.parentVersion ?? '-'} 交易数=${v.tradeCount} 备注=${v.note ?? ''} 时间=${v.createdAt}`);
        }
 break;
      }
      case 'correct': {
        const id = Number(args[1]);
        const parent = Number(opts.get('parent'));
        if (!Number.isInteger(parent)) throw new AppError('VALIDATION_ERROR', '需要 --parent 版本号');
        if (!opts.has('file')) throw new AppError('VALIDATION_ERROR', '需要 --file');
        const result = service.correctHistory(id, parent, readTrades(opts.get('file') as string), (opts.get('note') as string) ?? null);
        console.log(`已更正并生成新版本 v${result.version}（父版本 v${parent}），交易 ${result.totalTrades} 笔`);
        console.log(formatLots(result.report));
        break;
      }
      case 'export': {
        const id = Number(args[1]);
        const data = service.getReport(id, versionOpt);
        const text = reportJson(data);
        if (opts.has('out')) {
          writeFileSync(resolve(opts.get('out') as string), text, 'utf8');
          console.log(`已导出到 ${opts.get('out')}`);
        } else {
          console.log(text);
        }
        break;
      }
      default:
        console.log(`未知命令: ${command}\n`);
        console.log(HELP);
        process.exitCode = 1;
    }
  } catch (err) {
    if (err instanceof AppError) {
      console.error(`错误 [${err.code}] ${err.message}`);
      if (err.details !== undefined) console.error(JSON.stringify(err.details));
    } else {
      console.error(err);
    }
    process.exitCode = 1;
  } finally {
    store.close();
  }
}

main();
