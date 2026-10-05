import { formatFen } from "./money";
import type { LedgerReport } from "./types";

/** 金额双表示：fen 为精确分字符串，用于机器消费；yuan 仅用于展示，禁止再参与计算。 */
export interface FenView {
  fen: string;
  yuan: string;
}

export function fenView(value: bigint): FenView {
  return { fen: value.toString(), yuan: formatFen(value) };
}

export type ReportDTO = ReturnType<typeof reportToDTO>;

export function reportToDTO(report: LedgerReport) {
  return {
    buys: report.buys.map((b) => ({
      seq: b.seq,
      txnId: b.txnId,
      securityId: b.securityId,
      qty: b.qty,
      price: b.price,
      fee: b.fee,
      totalCost: fenView(b.totalCost),
    })),
    sells: report.sells.map((s) => ({
      seq: s.seq,
      txnId: s.txnId,
      securityId: s.securityId,
      qty: s.qty,
      price: s.price,
      fee: s.fee,
      grossIncome: fenView(s.grossIncome),
      netIncome: fenView(s.netIncome),
      allocatedCost: fenView(s.allocatedCost),
      realizedPnl: fenView(s.realizedPnl),
      consumptions: s.consumptions.map((c) => ({
        buySeq: c.buySeq,
        buyTxnId: c.buyTxnId,
        consumedQty: c.consumedQty,
        qtyBefore: c.qtyBefore,
        qtyAfter: c.qtyAfter,
        costBefore: fenView(c.costBefore),
        costAllocated: fenView(c.costAllocated),
        costAfter: fenView(c.costAfter),
        pnlContribution: fenView(c.pnlContribution),
      })),
    })),
    lots: report.lots.map((l) => ({
      buySeq: l.buySeq,
      buyTxnId: l.buyTxnId,
      securityId: l.securityId,
      origQty: l.origQty,
      remainingQty: l.remainingQty,
      origCost: fenView(l.origCost),
      remainingCost: fenView(l.remainingCost),
      closed: l.closed,
    })),
    summaries: report.summaries.map((s) => ({
      securityId: s.securityId,
      remainingQty: s.remainingQty,
      soldQty: s.soldQty,
      remainingCost: fenView(s.remainingCost),
      buyTotalCost: fenView(s.buyTotalCost),
      costCarried: fenView(s.costCarried),
      realizedPnl: fenView(s.realizedPnl),
    })),
    totalRealizedPnl: fenView(report.totalRealizedPnl),
  };
}
