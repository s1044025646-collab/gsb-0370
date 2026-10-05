import { LedgerStore } from './db.js';
import { computeFifo } from './engine.js';
import { mergeWithExisting, validateTrades } from './validation.js';
import type { LedgerReport, TradeInput } from './types.js';
import { AppError } from './errors.js';

export interface ImportResult {
  version: number;
  inserted: number;
  deduplicated: number;
  totalTrades: number;
  report: LedgerReport;
}

export class LedgerService {
  constructor(private readonly store: LedgerStore) {}

  createLedger(name: string): { id: number; name: string; currentVersion: number } {
    const meta = this.store.createLedger(name);
    return { id: meta.id, name: meta.name, currentVersion: Number(meta.currentVersion) };
  }

 listLedgers() {
    return this.store.listLedgers().map((m) => ({ ...m, currentVersion: Number(m.currentVersion) }));
  }

  /**
   * 新建账本并一次性导入有序交易（整批原子）：
   * 非法输入或超卖时不留下任何有效账本数据。
   */
  createWithTrades(name: string, rawTrades: unknown[]): ImportResult & { ledgerId: number } {
    const incoming = validateTrades(rawTrades);
    const report = computeFifo(incoming);
    const ledger = this.store.createLedger(name);
    try {
      this.store.saveVersion({
        ledgerId: ledger.id,
        version: 1,
        parentVersion: null,
        note: 'initial',
        trades: incoming,
        report,
        setCurrent: true,
      });
    } catch (err) {
      // 极端落库失败：删除已建空账本，保持“非法导入不改变有效数据”。
      this.store.db.prepare('DELETE FROM ledgers WHERE id = ?').run(ledger.id);
      throw err;
    }
    return {
      ledgerId: ledger.id,
      version: 1,
      inserted: incoming.length,
      deduplicated: 0,
      totalTrades: incoming.length,
      report,
    };
  }

  /**
   * 在当前版本上追加交易：先合并校验、从头重算，通过后才以新版本原子落库。
   * 任何失败（序号冲突、编号冲突、超卖）都不会改变当前版本。
   */
  appendTrades(ledgerId: number, rawTrades: unknown[], note: string | null): ImportResult {
    const meta = this.store.requireLedger(ledgerId);
    const current = Number(meta.currentVersion);
    const existing = this.store.getTrades(ledgerId, current);
    const incoming = validateTrades(rawTrades);
    const merged = mergeWithExisting(existing, incoming);
    const report = computeFifo(merged);

    const existingIds = new Set(existing.map((t) => t.tradeId));
    const inserted = incoming.filter((t) => !existingIds.has(t.tradeId)).length;
    const nextVersion = current + 1;
    this.store.saveVersion({
      ledgerId,
      version: nextVersion,
      parentVersion: current,
      note,
      trades: merged,
      report,
      setCurrent: true,
    });
    return {
      version: nextVersion,
      inserted,
      deduplicated: incoming.length - inserted,
      totalTrades: merged.length,
      report,
    };
  }

  /**
   * 历史更正：基于指定父版本，用一份全新的完整交易清单从头重算，
   * 生成新版本并切为当前版本；原版本报告原样保留。
   */
  correctHistory(
    ledgerId: number,
    parentVersion: number,
    rawTrades: unknown[],
    note: string | null,
  ): ImportResult {
    this.store.requireLedger(ledgerId);
    this.store.getVersion(ledgerId, parentVersion);
    const trades = validateTrades(rawTrades);
    const report = computeFifo(trades);

    const versions = this.store.listVersions(ledgerId);
    const nextVersion = versions.reduce((max, v) => Math.max(max, v.version), 0) + 1;
    this.store.saveVersion({
      ledgerId,
      version: nextVersion,
      parentVersion,
      note,
      trades,
      report,
      setCurrent: true,
    });
    return {
      version: nextVersion,
      inserted: trades.length,
      deduplicated: 0,
      totalTrades: trades.length,
      report,
    };
  }

  getReport(ledgerId: number, version?: number) {
    const meta = this.store.requireLedger(ledgerId);
    const v = version ?? Number(meta.currentVersion);
    return this.store.getVersion(ledgerId, v);
  }

  listVersions(ledgerId: number) {
    return this.store.listVersions(ledgerId);
  }

  /** 卖出解释：列出某笔卖出命中的批次扣减明细。 */
  explainSale(ledgerId: number, tradeId: string, version?: number) {
    const { meta, report } = this.getReport(ledgerId, version);
    const sale = report.sales.find((s) => s.tradeId === tradeId);
    if (!sale) {
      throw new AppError('BAD_REQUEST', `卖出交易不存在：${tradeId}`, { tradeId });
    }
    return { ledgerId, version: meta.version, sale };
  }

  /** 批次查询，可按证券过滤。 */
  lots(ledgerId: number, security?: string, version?: number) {
    const { meta, report } = this.getReport(ledgerId, version);
    const lots = security ? report.lots.filter((l) => l.security === security) : report.lots;
    const summaries = security
      ? report.summaries.filter((s) => s.security === security)
      : report.summaries;
    return { ledgerId, version: meta.version, lots, summaries, totals: report.totals };
  }
}

export function tradesToReport(trades: TradeInput[]): LedgerReport {
  return computeFifo(validateTrades(trades));
}
