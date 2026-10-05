/** 交易方向：仅买入与卖出。 */
export type Side = 'BUY' | 'SELL';

/** 一笔用户录入的有序交易。数量为正整数；单价、手续费均为非负整数分。 */
export interface TradeInput {
  /** 交易编号（同一账本内唯一；编号相同内容相同为幂等，内容不同报冲突）。 */
  tradeId: string;
  /** 明确序号，从 1 开始的正整数，必须互不相同；不使用系统时间排序。 */
  seq: number;
  /** 匿名证券编号。 */
  security: string;
  side: Side;
  /** 正整数数量，最大 1_000_000_000。 */
  qty: number;
  /** 单价（分/股），非负整数，允许为 0；最大 10^15 分。 */
  price: number;
  /** 本笔手续费（分），非负整数，允许为 0；最大 10^15 分。 */
  fee: number;
}

/** 卖出命中的一个买入批次片段。 */
export interface LotHit {
  buyTradeId: string;
  buySeq: number;
  consumedQty: bigint;
  costBefore: bigint;
  costTaken: bigint;
  costAfter: bigint;
  /** 该片段分摊的成交收入（数量×单价），不含手续费。 */
  grossRevenue: bigint;
  /** 该片段贡献的盈亏（收入按数量分摊，手续费在整笔卖出层面只扣一次）。 */
  pnlContribution: bigint;
  lotIndex: number;
}

export interface SaleResult {
  tradeId: string;
  seq: number;
  security: string;
  qty: bigint;
  price: bigint;
  fee: bigint;
  grossRevenue: bigint;
  netRevenue: bigint;
  costConsumed: bigint;
  realizedPnl: bigint;
  hits: LotHit[];
}

/** 一个买入批次的当前状态。 */
export interface Lot {
  lotIndex: number;
  buyTradeId: string;
  buySeq: number;
  security: string;
  initialQty: bigint;
  initialCost: bigint;
  remainingQty: bigint;
  remainingCost: bigint;
  closed: boolean;
}

export interface SecuritySummary {
  security: string;
  remainingQty: bigint;
  remainingCost: bigint;
  totalBoughtQty: bigint;
  totalBuyCost: bigint;
  costCarried: bigint;
  realizedPnl: bigint;
  openLots: number;
}

export interface LedgerReport {
  lots: Lot[];
  sales: SaleResult[];
  summaries: SecuritySummary[];
  /** 全部证券合计：买入总成本 = 已结转成本 + 剩余成本。 */
  totals: {
    totalBuyCost: bigint;
    costCarried: bigint;
    remainingCost: bigint;
    realizedPnl: bigint;
  };
}

export interface LedgerMeta {
  id: number;
  name: string;
  currentVersion: number;
  createdAt: string;
}

export interface VersionMeta {
  ledgerId: number;
  version: number;
  parentVersion: number | null;
  note: string | null;
  createdAt: string;
  tradeCount: number;
}
