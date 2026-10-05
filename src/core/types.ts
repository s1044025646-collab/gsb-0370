/** 交易方向：只处理买入与卖出。 */
export type Side = "BUY" | "SELL";

/**
 * 一笔用户录入的有序交易。
 * seq 为用户给定的明确序号（从 1 起的正整数），系统不按时间重排。
 * qty 为正整数股数；price / fee 为以「分」为单位的非负整数。
 */
export interface TxnInput {
  seq: number;
  txnId: string;
  securityId: string;
  side: Side;
  qty: number;
  price: number;
  fee: number;
}

/** 卖出时命中一个买入批次的分摊明细。 */
export interface LotConsumption {
  buySeq: number;
  buyTxnId: string;
  consumedQty: number;
  costBefore: bigint;
  qtyBefore: number;
  costAllocated: bigint;
  costAfter: bigint;
  qtyAfter: number;
  /** 本命中对该笔卖出已实现盈亏的贡献 = 按数量比例的净收入 - 分摊成本（见引擎说明）。 */
  pnlContribution: bigint;
}

/** 一个买入批次当前的剩余状态（不同来源买入永不合并）。 */
export interface LotState {
  buySeq: number;
  buyTxnId: string;
  securityId: string;
  origQty: number;
  remainingQty: number;
  origCost: bigint;
  remainingCost: bigint;
  closed: boolean;
}

/** 单笔卖出的核算结果。 */
export interface SellResult {
  seq: number;
  txnId: string;
  securityId: string;
  qty: number;
  price: number;
  fee: number;
  grossIncome: bigint;
  netIncome: bigint;
  allocatedCost: bigint;
  realizedPnl: bigint;
  consumptions: LotConsumption[];
}

/** 单笔买入的核算结果。 */
export interface BuyResult {
  seq: number;
  txnId: string;
  securityId: string;
  qty: number;
  price: number;
  fee: number;
  totalCost: bigint;
}

export interface SecuritySummary {
  securityId: string;
  remainingQty: number;
  remainingCost: bigint;
  buyTotalCost: bigint;
  costCarried: bigint;
  realizedPnl: bigint;
  soldQty: number;
}

export interface LedgerReport {
  buys: BuyResult[];
  sells: SellResult[];
  lots: LotState[];
  summaries: SecuritySummary[];
  totalRealizedPnl: bigint;
}
