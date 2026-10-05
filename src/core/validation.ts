import { AppError } from "./errors";
import type { Side, TxnInput } from "./types";

/**
 * 输入上限（固定规则，README 同步说明）：
 * - 证券编号 / 交易编号：1~64 个字符，限字母、数字、下划线、短横线。
 * - 数量 qty：1 ~ 1_000_000 股的正整数。
 * - 单价 price：0 ~ 1_000_000_000（分/股）。允许零单价（如赠送/特殊录入），
 *   此时该批次成本只有手续费；禁止负数。
 * - 手续费 fee：0 ~ 1_000_000_000 分。允许零手续费；禁止负数。
 *   数量*单价 + 手续费 最大约 1e15 分，BigInt 精确表示，无溢出问题。
 * - 序号 seq：1 ~ 2_147_483_647 的正整数，同一账本内不得重复。
 */
export const LIMITS = {
  MAX_ID_LENGTH: 64,
  MAX_QTY: 1_000_000,
  MAX_PRICE: 1_000_000_000,
  MAX_FEE: 1_000_000_000,
  MAX_SEQ: 2_147_483_647,
} as const;

const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

function checkInt(value: unknown, field: string, max: number, { allowZero }: { allowZero: boolean }): number {
  if (typeof value === "boolean" || value === null || typeof value === "undefined") {
    throw new AppError("VALIDATION_ERROR", `字段 ${field} 必须是整数`);
  }
  let n: number;
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      throw new AppError("VALIDATION_ERROR", `字段 ${field} 必须是安全整数`);
    }
    n = value;
  } else if (typeof value === "string" && /^\d+$/.test(value)) {
    n = Number(value);
    if (!Number.isSafeInteger(n)) {
      throw new AppError("VALIDATION_ERROR", `字段 ${field} 超出安全整数范围`);
    }
  } else {
    throw new AppError("VALIDATION_ERROR", `字段 ${field} 必须是整数（收到 ${JSON.stringify(value)}）`);
  }
  const min = allowZero ? 0 : 1;
  if (n < min || n > max) {
 throw new AppError(
      "VALIDATION_ERROR",
      `字段 ${field} 必须位于 [${min}, ${max}]（收到 ${n}）`
    );
  }
  return n;
}

export function validateTxn(raw: unknown): TxnInput {
  if (typeof raw !== "object" || raw === null) {
    throw new AppError("VALIDATION_ERROR", "交易必须是对象");
  }
  const r = raw as Record<string, unknown>;

  const seq = checkInt(r.seq, "seq", LIMITS.MAX_SEQ, { allowZero: false });
  const qty = checkInt(r.qty, "qty", LIMITS.MAX_QTY, { allowZero: false });
  const price = checkInt(r.price, "price", LIMITS.MAX_PRICE, { allowZero: true });
  const fee = checkInt(r.fee, "fee", LIMITS.MAX_FEE, { allowZero: true });

  for (const field of ["txnId", "securityId"] as const) {
    if (typeof r[field] !== "string" || !ID_PATTERN.test(r[field] as string)) {
      throw new AppError(
        "VALIDATION_ERROR",
        `字段 ${field} 必须是 1~${LIMITS.MAX_ID_LENGTH} 位字母/数字/下划线/短横线`
      );
    }
  }
  if (r.side !== "BUY" && r.side !== "SELL") {
    throw new AppError("VALIDATION_ERROR", `字段 side 只能是 BUY 或 SELL（收到 ${JSON.stringify(r.side)}）`);
  }

  return {
    seq,
    txnId: r.txnId as string,
    securityId: r.securityId as string,
    side: r.side as Side,
    qty,
    price,
    fee,
  };
}

/** 校验一批交易：序号唯一、txnId 重复时内容必须完全一致（幂等），否则冲突。 */
export function validateTxnList(rawList: unknown): TxnInput[] {
  if (!Array.isArray(rawList)) {
    throw new AppError("VALIDATION_ERROR", "transactions 必须是数组");
  }
  if (rawList.length === 0) {
    throw new AppError("VALIDATION_ERROR", "交易列表不能为空");
  }
  if (rawList.length > LIMITS.MAX_SEQ) {
    throw new AppError("VALIDATION_ERROR", "交易数量超出上限");
  }

  const list = rawList.map((item) => validateTxn(item));

  const bySeq = new Map<number, TxnInput>();
  for (const t of list) {
    const exist = bySeq.get(t.seq);
    if (exist) {
      throw new AppError(
        "SEQ_CONFLICT",
        `序号 ${t.seq} 在同一次提交中重复`,
        { seq: t.seq }
      );
    }
    bySeq.set(t.seq, t);
  }

  const byTxnId = new Map<string, TxnInput>();
  for (const t of list) {
    const exist = byTxnId.get(t.txnId);
    if (exist && !sameTxn(exist, t)) {
      throw new AppError(
        "TXN_DUPLICATE_CONFLICT",
        `交易编号 ${t.txnId} 重复但内容不同`,
        { txnId: t.txnId, first: exist, conflict: t }
      );
    }
    byTxnId.set(t.txnId, t);
  }

  return list;
}

export function sameTxn(a: TxnInput, b: TxnInput): boolean {
  return (
    a.seq === b.seq &&
    a.txnId === b.txnId &&
    a.securityId === b.securityId &&
    a.side === b.side &&
    a.qty === b.qty &&
    a.price === b.price &&
    a.fee === b.fee
  );
}
