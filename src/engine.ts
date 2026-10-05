import type {
  LedgerReport,
  Lot,
  LotHit,
  SaleResult,
  SecuritySummary,
  TradeInput,
} from './types.js';
import { AppError } from './errors.js';

interface InternalLot extends Lot {
  open: boolean;
}

/**
 * 对一份按 seq 排序的交易清单从头执行 FIFO 核算。
 * 纯函数：相同输入永远得到相同结果；超卖直接抛错，不产生部分结果。
 */
export function computeFifo(trades: TradeInput[]): LedgerReport {
  const lotsBySecurity = new Map<string, InternalLot[]>();
  const sales: SaleResult[] = [];

  const boughtQty = new Map<string, bigint>();
  const soldQty = new Map<string, bigint>();
  const totalBuyCost = new Map<string, bigint>();
  const costCarried = new Map<string, bigint>();
  const realizedPnl = new Map<string, bigint>();

  const add = (m: Map<string, bigint>, k: string, v: bigint) => m.set(k, (m.get(k) ?? 0n) + v);

  for (const t of trades) {
    const qty = BigInt(t.qty);
    const price = BigInt(t.price);
    const fee = BigInt(t.fee);
    let lots = lotsBySecurity.get(t.security);
    if (!lots) {
      lots = [];
      lotsBySecurity.set(t.security, lots);
    }

    if (t.side === 'BUY') {
      const cost = qty * price + fee;
      lots.push({
        lotIndex: lots.length + 1,
        buyTradeId: t.tradeId,
        buySeq: t.seq,
        security: t.security,
        initialQty: qty,
        initialCost: cost,
        remainingQty: qty,
        remainingCost: cost,
        closed: false,
        open: true,
      });
      add(boughtQty, t.security, qty);
      add(totalBuyCost, t.security, cost);
    } else {
      const available = lots.reduce((sum, l) => sum + (l.open ? l.remainingQty : 0n), 0n);
      if (qty > available) {
        throw new AppError(
          'OVERSOLD',
          `卖出超量被拒绝：证券 ${t.security} 交易 ${t.tradeId}(seq=${t.seq}) 卖出 ${qty} 股，但可用仅 ${available} 股。本笔不执行`,
          { tradeId: t.tradeId, seq: t.seq, security: t.security, sellQty: qty.toString(), available: available.toString() },
        );
      }

      const grossRevenue = qty * price;
      const hits: LotHit[] = [];
      let need = qty;
      let costConsumed = 0n;

      const openLots = lots.filter((l) => l.open);
      for (let i = 0; i < openLots.length && need > 0n; i++) {
        const lot = openLots[i]!;
        const take = lot.remainingQty < need ? lot.remainingQty : need;

        // 固定分摊口径：
        // 部分取出 -> floor(批次剩余成本 * 取出数量 / 批次剩余数量)
        // 整批取完 -> 带走全部剩余成本（最后一部分自动取得此前留下的余分）。
        let takenCost: bigint;
        if (take === lot.remainingQty) {
          takenCost = lot.remainingCost;
        } else {
          takenCost = (lot.remainingCost * take) / lot.remainingQty;
        }

        const costBefore = lot.remainingCost;
        lot.remainingCost -= takenCost;
        lot.remainingQty -= take;
        if (lot.remainingQty === 0n) {
          lot.open = false;
          lot.closed = true;
        }
        const costAfter = lot.remainingCost;

        hits.push({
          lotIndex: lot.lotIndex,
          buyTradeId: lot.buyTradeId,
          buySeq: lot.buySeq,
          consumedQty: take,
          costBefore,
          costTaken: takenCost,
          costAfter,
          grossRevenue: 0n,
          pnlContribution: 0n,
        });

        costConsumed += takenCost;
        need -= take;
      }

      if (need !== 0n) {
        throw new AppError('INTERNAL_ERROR', 'FIFO 扣减数量不平', { need: need.toString() });
      }

      // 成交收入按数量精确分摊到各片段（最大余数法），仅用于逐片段展示；
      // 手续费不在片段间分摊，只在整笔卖出净收入中扣一次。
      const exactPerHit = hits.map((h) => ({
        h,
        base: (grossRevenue * h.consumedQty) / qty,
        rem: (grossRevenue * h.consumedQty) % qty,
      }));
      let allocated = 0n;
      exactPerHit.forEach((x) => {
        x.h.grossRevenue = x.base;
        allocated += x.base;
      });
      let leftover = grossRevenue - allocated;
      const order = [...exactPerHit.keys()].sort((a, b) => {
        const r = exactPerHit[b]!.rem - exactPerHit[a]!.rem;
        return r === 0n ? a - b : Number(r > 0n ? 1 : -1);
      });
      for (const idx of order) {
        if (leftover === 0n) break;
        exactPerHit[idx]!.h.grossRevenue += 1n;
        leftover -= 1n;
      }

      const netRevenue = grossRevenue - fee;
      const realized = netRevenue - costConsumed;

      // 片段贡献盈亏之和必须精确等于整笔盈亏：先按“片段收入-片段成本”汇总，
      // 再把手续费造成的差额整体放入最后一个片段。
      let contribSum = 0n;
      for (let i = 0; i < hits.length; i++) {
        const h = hits[i]!;
        if (i < hits.length - 1) {
          h.pnlContribution = h.grossRevenue - h.costTaken;
          contribSum += h.pnlContribution;
        }
      }
      const last = hits[hits.length - 1]!;
      last.pnlContribution = realized - contribSum;

      sales.push({
        tradeId: t.tradeId,
        seq: t.seq,
        security: t.security,
        qty,
        price,
        fee,
        grossRevenue,
        netRevenue,
        costConsumed,
        realizedPnl: realized,
        hits,
      });

      add(soldQty, t.security, qty);
      add(costCarried, t.security, costConsumed);
      add(realizedPnl, t.security, realized);
    }
  }

  const securities = [...new Set(trades.map((t) => t.security))].sort();
  const summaries: SecuritySummary[] = securities.map((security) => {
    const lots = lotsBySecurity.get(security)!;
    const remainingQty = lots.reduce((s, l) => s + l.remainingQty, 0n);
    const remainingCost = lots.reduce((s, l) => s + l.remainingCost, 0n);
    return {
      security,
      remainingQty,
      remainingCost,
      totalBoughtQty: boughtQty.get(security) ?? 0n,
      totalBuyCost: totalBuyCost.get(security) ?? 0n,
      costCarried: costCarried.get(security) ?? 0n,
      realizedPnl: realizedPnl.get(security) ?? 0n,
      openLots: lots.filter((l) => l.open).length,
    };
  });

  const allLots = [...lotsBySecurity.values()].flat();
  const totals = {
    totalBuyCost: sumMap(totalBuyCost),
    costCarried: sumMap(costCarried),
    remainingCost: allLots.reduce((s, l) => s + l.remainingCost, 0n),
    realizedPnl: sumMap(realizedPnl),
  };

  return { lots: allLots, sales: sales.sort((a, b) => a.seq - b.seq), summaries, totals };
}

function sumMap(m: Map<string, bigint>): bigint {
  let s = 0n;
  for (const v of m.values()) s += v;
  return s;
}
