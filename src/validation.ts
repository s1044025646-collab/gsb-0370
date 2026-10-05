import type { TradeInput } from './types.js';
import { AppError } from './errors.js';

/** 输入上限（README 同样声明）。 */
export const LIMITS = {
  MAX_QTY: 1_000_000_000,
  MAX_PRICE: 1_000_000_000_000_000, // 10^15 分
  MAX_FEE: 1_000_000_000_000_000,
  MAX_ID_LEN: 64,
  MAX_NAME_LEN: 100,
} as const;

function isInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isSafeInteger(v);
}

function isNonEmptyString(v: unknown, maxLen: number): v is string {
  return typeof v === 'string' && v.trim().length > 0 && v.length <= maxLen;
}

/** 校验单笔交易字段，非法时抛出 VALIDATION_ERROR。 */
export function validateTrade(raw: unknown): TradeInput {
  if (typeof raw !== 'object' || raw === null) {
    throw new AppError('VALIDATION_ERROR', '每笔交易必须是对象', raw);
  }
  const t = raw as Record<string, unknown>;

  if (!isNonEmptyString(t.tradeId, LIMITS.MAX_ID_LEN)) {
    throw new AppError('VALIDATION_ERROR', `tradeId 必须是 1-${LIMITS.MAX_ID_LEN} 字符的非空字符串`, t.tradeId);
  }
  if (!isInt(t.seq) || (t.seq as number) < 1) {
    throw new AppError('VALIDATION_ERROR', 'seq 必须是 >=1 的整数序号', t.seq);
  }
  if (!isNonEmptyString(t.security, LIMITS.MAX_ID_LEN)) {
    throw new AppError('VALIDATION_ERROR', `security 必须是 1-${LIMITS.MAX_ID_LEN} 字符的非空字符串`, t.security);
  }
  if (t.side !== 'BUY' && t.side !== 'SELL') {
    throw new AppError('VALIDATION_ERROR', 'side 只能是 BUY 或 SELL', t.side);
  }
  if (!isInt(t.qty) || (t.qty as number) < 1 || (t.qty as number) > LIMITS.MAX_QTY) {
    throw new AppError('VALIDATION_ERROR', `qty 必须是 1-${LIMITS.MAX_QTY} 的正整数`, t.qty);
  }
  if (!isInt(t.price) || (t.price as number) < 0 || (t.price as number) > LIMITS.MAX_PRICE) {
    throw new AppError('VALIDATION_ERROR', `price 必须是 0-${LIMITS.MAX_PRICE} 的非负整数分（允许零单价）`, t.price);
  }
  if (!isInt(t.fee) || (t.fee as number) < 0 || (t.fee as number) > LIMITS.MAX_FEE) {
    throw new AppError('VALIDATION_ERROR', `fee 必须是 0-${LIMITS.MAX_FEE} 的非负整数分（允许零手续费）`, t.fee);
  }

  return {
    tradeId: t.tradeId,
    seq: t.seq as number,
    security: t.security,
    side: t.side,
    qty: t.qty as number,
    price: t.price as number,
    fee: t.fee as number,
  };
}

/** 校验交易列表：字段合法、序号不冲突、交易编号冲突规则。返回按 seq 排序的列表。 */
export function validateTrades(rawList: unknown): TradeInput[] {
  if (!Array.isArray(rawList) || rawList.length === 0) {
    throw new AppError('VALIDATION_ERROR', 'trades 必须是非空数组');
  }
  const trades = rawList.map((t) => validateTrade(t));

  const bySeq = new Map<number, string>();
  for (const t of trades) {
    const existing = bySeq.get(t.seq);
    if (existing !== undefined) {
      throw new AppError('SEQ_CONFLICT', `序号冲突：seq=${t.seq} 同时被 ${existing} 与 ${t.tradeId} 使用`, {
        seq: t.seq,
      });
    }
    bySeq.set(t.seq, t.tradeId);
  }

  const byId = new Map<string, TradeInput>();
  for (const t of trades) {
    const existing = byId.get(t.tradeId);
    if (existing !== undefined && !sameTrade(existing, t)) {
      throw new AppError(
        'TRADE_ID_CONFLICT',
        `交易编号冲突：${t.tradeId} 出现两次但内容不同`,
        { existing, incoming: t },
      );
    }
    byId.set(t.tradeId, t);
  }

  return [...trades].sort((a, b) => a.seq - b.seq);
}

/**
 * 合并待写入交易与库中已有交易：
 * - 编号相同且内容相同 -> 幂等（忽略重复）
 * - 编号相同内容不同 -> 冲突
 * - 序号相同编号不同 -> 序号冲突
 */
export function mergeWithExisting(existing: TradeInput[], incoming: TradeInput[]): TradeInput[] {
  const byId = new Map<string, TradeInput>(existing.map((t) => [t.tradeId, t]));
  const seqOwner = new Map<number, string>(existing.map((t) => [t.seq, t.tradeId]));

  for (const t of incoming) {
    const sameId = byId.get(t.tradeId);
    if (sameId) {
      if (!sameTrade(sameId, t)) {
        throw new AppError(
          'TRADE_ID_CONFLICT',
          `交易编号冲突：${t.tradeId} 已存在但内容不同`,
          { existing: sameId, incoming: t },
        );
      }
      continue;
    }
    const owner = seqOwner.get(t.seq);
    if (owner !== undefined) {
      throw new AppError('SEQ_CONFLICT', `序号冲突：seq=${t.seq} 已被交易 ${owner} 占用`, { seq: t.seq });
    }
    byId.set(t.tradeId, t);
    seqOwner.set(t.seq, t.tradeId);
  }

  return [...byId.values()].sort((a, b) => a.seq - b.seq);
}

export function sameTrade(a: TradeInput, b: TradeInput): boolean {
  return (
    a.tradeId === b.tradeId &&
    a.seq === b.seq &&
    a.security === b.security &&
    a.side === b.side &&
    a.qty === b.qty &&
    a.price === b.price &&
    a.fee === b.fee
  );
}

export function tradeKey(t: TradeInput): string {
  return JSON.stringify([t.tradeId, t.seq, t.security, t.side, t.qty, t.price, t.fee]);
}
