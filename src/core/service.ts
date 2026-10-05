import { Store } from "../db/store";
import { checkAppendable, recompute } from "./engine";
import { AppError } from "./errors";
import type { LedgerReport, TxnInput } from "./types";
import { validateTxnList } from "./validation";

export interface VersionMeta {
  id: string;
  version: number;
  parentVersion: number | null;
  note: string;
  archived: boolean;
}

export class LedgerService {
  constructor(private readonly store: Store) {}

  createLedger(id: string, note = ""): VersionMeta {
    if (this.store.latestVersion(id) !== null) {
      throw new AppError("VALIDATION_ERROR", `账本 ${id} 已存在，请使用 import/append 或 correct`);
    }
    const version = this.store.createLedger(id, note, null);
    return { id, version, parentVersion: null, note, archived: false };
  }

  /** 导入有序交易到新版本；账本必须存在且当前版本为空（v1 初始导入）。 */
  importInto(id: string, rawList: unknown): { version: number; report: LedgerReport } {
    const version = this.requireLatest(id);
    const existing = this.store.loadTxns(id, version);
    if (existing.length > 0) {
      throw new AppError("VALIDATION_ERROR", `账本 ${id} v${version} 已有交易，请使用 append`);
    }
    const txns = validateTxnList(rawList);
    // 先在内存全量重算，任何超卖/非法批次都在写库前失败。
    const report = recompute(txns);
    this.store.replaceVersionTxns(id, version, txns);
    return { version, report };
  }

  /** 追加交易；同 txnId 内容完全相同视为幂等忽略，否则冲突；seq 冲突拒绝。 */
  append(id: string, rawList: unknown): { version: number; report: LedgerReport; applied: number; skipped: number } {
    const version = this.requireLatest(id);
    if (this.isArchived(id, version)) {
      throw new AppError("VERSION_ARCHIVED", `账本 ${id} v${version} 已归档，不能追加`);
    }
    const additions = validateTxnList(rawList);
    const existing = this.store.loadTxns(id, version);
    const { toApply } = checkAppendable(existing, additions);
    if (toApply.length > 0) {
      // 先全量重算成功再写库：超卖会在这里抛出，已存在数据不受影响。
      recompute([...existing, ...toApply]);
      this.store.appendTxns(id, version, toApply);
    }
    return {
      version,
      report: recompute(this.store.loadTxns(id, version)),
      applied: toApply.length,
      skipped: additions.length - toApply.length,
    };
  }

  report(id: string, version?: number): { version: number; report: LedgerReport } {
    const v = version ?? this.requireLatest(id);
    this.requireExists(id, v);
    return { version: v, report: recompute(this.store.loadTxns(id, v)) };
  }

  lots(id: string, securityId?: string, version?: number): { version: number; lots: LedgerReport["lots"] } {
    const { version: v, report } = this.report(id, version);
    const lots = securityId ? report.lots.filter((l) => l.securityId === securityId) : report.lots;
    return { version: v, lots };
  }

  sell(id: string, seqOrTxnId: string, version?: number): { version: number; sell: LedgerReport["sells"][number] } {
    const { version: v, report } = this.report(id, version);
    const sell = report.sells.find(
      (s) => String(s.seq) === String(seqOrTxnId) || s.txnId === seqOrTxnId
    );
    if (!sell) {
      throw new AppError("NOT_FOUND", `未找到卖出交易：${seqOrTxnId}`);
    }
    return { version: v, sell };
  }

  /** 历史更正：基于指定（默认最新）版本创建新版本，从头重算；旧版本与报告原样保留。 */
  correct(
    id: string,
    rawList: unknown,
    opts: { baseVersion?: number; note?: string } = {}
  ): { version: number; report: LedgerReport } {
    const baseVersion = opts.baseVersion ?? this.requireLatest(id);
    this.requireExists(id, baseVersion);
    const txns = validateTxnList(rawList);
    const report = recompute(txns); // 写库前全量重算
    const newVersion = this.store.createLedger(id, opts.note ?? "", baseVersion);
    this.store.replaceVersionTxns(id, newVersion, txns);
    return { version: newVersion, report };
  }

  versions(id: string): VersionMeta[] {
    return this.store.listVersions(id).map((v) => ({ id, ...v }));
  }

  listLedgers(): { id: string; latestVersion: number }[] {
    return this.store.listLedgers();
  }

  private requireLatest(id: string): number {
    const v = this.store.latestVersion(id);
    if (v === null) throw new AppError("NOT_FOUND", `账本不存在：${id}`);
    return v;
  }

  private requireExists(id: string, version: number): void {
    if (!this.store.ledgerExists(id, version)) {
      throw new AppError("NOT_FOUND", `账本版本不存在：${id} v${version}`);
    }
  }

  private isArchived(id: string, version: number): boolean {
    const meta = this.versions(id).find((v) => v.version === version);
    return meta?.archived ?? false;
  }
}

/** 供测试/演示使用：从交易数组直接计算报告。 */
export function computeFromList(rawList: unknown): LedgerReport {
  return recompute(validateTxnList(rawList));
}

export function loadTxns(store: Store, id: string, version: number): TxnInput[] {
  return store.loadTxns(id, version);
}
