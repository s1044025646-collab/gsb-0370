import { AppError } from "./errors";
import { sameTxn } from "./validation";
import type {
  BuyResult,
  LedgerReport,
  LotConsumption,
  LotState,
  SellResult,
  SecuritySummary,
  TxnInput,
} from "./types";

/**
 * 固定分摊口径（本题规则，不代表任何税务口径）：
 * 部分取出某批次 q 股：cost = floor(剩余成本 * q / 剩余数量)
 * 整批取完（q == 当前剩余数量）：带走全部剩余成本。
 * 因此前面分笔可能留下不足 1 分/股的余分，由该批次最后一次取出自动取得。
 */

interface InternalLot extends LotState {}

export function recompute(txnsInput: TxnInput[]): LedgerReport {
  // 防御性拷贝并按用户给定 seq 升序处理（seq 唯一性已在校验阶段保证）。
  const txns = [...txnsInput].sort((a, b) => a.seq - b.seq);

  const lots = new Map<string, InternalLot[]>(); // securityId -> FIFO 开放批次
  const buyResults: BuyResult[] = [];
  const sellResults: SellResult[] = [];

  const openLots = (securityId: string): InternalLot[] => {
    let list = lots.get(securityId);
    if (!list) {
      list = [];
      lots.set(securityId, list);
    }
    return list;
  };

  for (const t of txns) {
    if (t.side === "BUY") {
      const totalCost = BigInt(t.qty) * BigInt(t.price) + BigInt(t.fee);
      const lot: InternalLot = {
        buySeq: t.seq,
        buyTxnId: t.txnId,
        securityId: t.securityId,
        origQty: t.qty,
        remainingQty: t.qty,
        origCost: totalCost,
        remainingCost: totalCost,
        closed: false,
      };
      openLots(t.securityId).push(lot);
      buyResults.push({
        seq: t.seq,
        txnId: t.txnId,
        securityId: t.securityId,
        qty: t.qty,
        price: t.price,
        fee: t.fee,
        totalCost,
      });
    } else {
      const list = openLots(t.securityId);
      const available = list.reduce((sum, lot) => sum + (lot.closed ? 0 : lot.remainingQty), 0);
      if (t.qty > available) {
        // 超卖：整笔拒绝，不做任何扣减（调用方在数据库事务中回滚全部输入）。
        throw new AppError(
          "OVERSOLD",
          `卖出序号 ${t.seq}（交易编号 ${t.txnId}）数量 ${t.qty} 超过可用持仓 ${available}`,
          { seq: t.seq, txnId: t.txnId, securityId: t.securityId, requested: t.qty, available }
        );
      }

      const fee = BigInt(t.fee);
      const price = BigInt(t.price);
      const totalQty = BigInt(t.qty);
      const grossIncome = totalQty * price;
      const netIncome = grossIncome - fee;

      const consumptions: LotConsumption[] = [];
      let need = t.qty;
      let allocatedCost = 0n;
      let allocatedFee = 0n;

      // 预先确定命中的批次及数量，保证消耗数量之和恰为卖出数量。
      const hits: { lot: InternalLot; take: number }[] = [];
      for (const lot of list) {
        if (lot.closed) continue;
        if (need === 0) break;
        const take = Math.min(lot.remainingQty, need);
        hits.push({ lot, take });
        need -= take;
      }
      if (need !== 0) {
        throw new AppError("OVERSOLD", `卖出序号 ${t.seq} 库存匹配失败`, { seq: t.seq });
      }

      hits.forEach((hit, index) => {
        const { lot, take } = hit;
        const isLast = index === hits.length - 1;
        const costBefore = lot.remainingCost;
        const qtyBefore = lot.remainingQty;

        let costTaken: bigint;
        if (take === lot.remainingQty) {
          costTaken = lot.remainingCost; // 整批取完带走全部剩余成本（含历史余分）
        } else {
          costTaken = (lot.remainingCost * BigInt(take)) / BigInt(lot.remainingQty); // 向下取整
        }

        // 手续费只扣一次：按数量向下取整分摊到各命中，最后一个命中承接余分。
        let feeTaken: bigint;
        if (isLast) {
          feeTaken = fee - allocatedFee;
        } else {
          feeTaken = (fee * BigInt(take)) / totalQty;
          allocatedFee += feeTaken;
        }

        const grossPart = BigInt(take) * price;
        const pnlContribution = grossPart - feeTaken - costTaken;

        lot.remainingQty -= take;
        lot.remainingCost -= costTaken;
        lot.closed = lot.remainingQty === 0;
        if (lot.closed) lot.remainingCost = 0n;
        allocatedCost += costTaken;

        consumptions.push({
          buySeq: lot.buySeq,
          buyTxnId: lot.buyTxnId,
          consumedQty: take,
          costBefore,
          qtyBefore,
          costAllocated: costTaken,
          costAfter: lot.remainingCost,
          qtyAfter: lot.remainingQty,
          pnlContribution,
        });
      });

      const realizedPnl = netIncome - allocatedCost;
      const contributionSum = consumptions.reduce((s, c) => s + c.pnlContribution, 0n);
      if (contributionSum !== realizedPnl) {
        throw new AppError("INVALID_BATCH", "手续费余分分摊校验失败");
      }

      sellResults.push({
        seq: t.seq,
        txnId: t.txnId,
        securityId: t.securityId,
        qty: t.qty,
        price: t.price,
        fee: t.fee,
        grossIncome,
        netIncome,
        allocatedCost,
        realizedPnl,
        consumptions,
      });
    }
  }

  // 汇总：按证券统计剩余批次成本、买入总成本、已结转成本与已实现盈亏。
  const summaryMap = new Map<string, SecuritySummary>();
  const allLots: LotState[] = [];
  for (const [securityId, list] of lots) {
    const buyTotalCost = list.reduce((s, lot) => s + lot.origCost, 0n);
    const remainingCost = list.reduce((s, lot) => s + lot.remainingCost, 0n);
    const remainingQty = list.reduce((s, lot) => s + lot.remainingQty, 0);
    const realizedPnl = sellResults
      .filter((sell) => sell.securityId === securityId)
      .reduce((s, sell) => s + sell.realizedPnl, 0n);
    const soldQty = sellResults
      .filter((sell) => sell.securityId === securityId)
      .reduce((s, sell) => s + sell.qty, 0);
    summaryMap.set(securityId, {
      securityId,
      remainingQty,
      remainingCost,
      buyTotalCost,
      costCarried: buyTotalCost - remainingCost,
      realizedPnl,
      soldQty,
    });
    for (const lot of list) allLots.push(lot);
  }

  const summaries = [...summaryMap.values()].sort((a, b) =>
    a.securityId < b.securityId ? -1 : a.securityId > b.securityId ? 1 : 0
  );
  const totalRealizedPnl = summaries.reduce((s, x) => s + x.realizedPnl, 0n);

  // 守恒断言：买入总成本 == 已结转成本 + 剩余成本（每个证券独立成立）。
  for (const s of summaries) {
    if (s.buyTotalCost !== s.costCarried + s.remainingCost) {
      throw new AppError("INVALID_BATCH", `证券 ${s.securityId} 成本守恒校验失败`);
    }
  }

  return {
    buys: buyResults.sort((a, b) => a.seq - b.seq),
    sells: sellResults.sort((a, b) => a.seq - b.seq),
    lots: allLots.sort((a, b) =>
      a.securityId === b.securityId ? a.buySeq - b.buySeq : a.securityId < b.securityId ? -1 : 1
    ),
    summaries,
    totalRealizedPnl,
  };
}

/** 检查追加交易与已有交易是否冲突：seq 必须全新；txnId 相同则内容必须一致（幂等忽略）。 */
export function checkAppendable(existing: TxnInput[], additions: TxnInput[]): { toApply: TxnInput[] } {
  const existingBySeq = new Map<number, TxnInput>();
  const existingByTxnId = new Map<string, TxnInput>();
  for (const t of existing) {
    existingBySeq.set(t.seq, t);
    existingByTxnId.set(t.txnId, t);
  }

  const toApply: TxnInput[] = [];
  for (const t of additions) {
    if (existingBySeq.has(t.seq)) {
      const old = existingBySeq.get(t.seq)!;
      if (sameTxn(old, t)) continue; // 同 seq 且完全相同 -> 幂等忽略（理论上不会出现，txnId 决定）
      throw new AppError("SEQ_CONFLICT", `序号 ${t.seq} 已存在且内容不同`, { seq: t.seq });
    }
    const oldById = existingByTxnId.get(t.txnId);
    if (oldById) {
      if (sameTxn(oldById, t)) {
        // 内容相同但 seq 不同属于异常，按序号冲突处理
        throw new AppError("TXN_DUPLICATE_CONFLICT", `交易编号 ${t.txnId} 已存在但序号不同`, {
          txnId: t.txnId,
        });
      }
      throw new AppError("TXN_DUPLICATE_CONFLICT", `交易编号 ${t.txnId} 重复但内容不同`, {
        txnId: t.txnId,
      });
    }
    toApply.push(t);
  }
  return { toApply };
}
