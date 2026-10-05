import { recompute } from "../core/engine";
import { AppError } from "../core/errors";
import type { LedgerReport, TxnInput } from "../core/types";

/**
 * 演示数据：
 * 证券 SEC-A：买入 3 股，单价 1000 分，手续费 1 分 -> 总成本 3001 分（一个批次）。
 * 随后分三次各卖 1 股，手续费 0：
 *   第 1 股 floor(3001*1/3)=1000，剩 2001/2
 *   第 2 股 floor(2001*1/2)=1000，剩 1001/1
 *   第 3 股整批取完带走 1001（余分归最后一部分）
 * 再加入证券 SEC-B 两个批次，演示跨批次卖出，以及一次必然超卖的拒绝。
 */
export function buildDemoInput(): {
  stagedReport: LedgerReport;
  fullReport: LedgerReport;
  oversellMessage: string;
} {
  const staged: TxnInput[] = [
    { seq: 1, txnId: "A-B1", securityId: "SEC-A", side: "BUY", qty: 3, price: 1000, fee: 1 },
    { seq: 2, txnId: "A-S1", securityId: "SEC-A", side: "SELL", qty: 1, price: 1000, fee: 0 },
    { seq: 3, txnId: "A-S2", securityId: "SEC-A", side: "SELL", qty: 1, price: 1000, fee: 0 },
    { seq: 4, txnId: "A-S3", securityId: "SEC-A", side: "SELL", qty: 1, price: 1000, fee: 0 },
  ];

  const full: TxnInput[] = [
    ...staged,
    // SEC-B：两个批次同价不同编号，不合并
    { seq: 5, txnId: "B-B1", securityId: "SEC-B", side: "BUY", qty: 2, price: 500, fee: 0 },
    { seq: 6, txnId: "B-B2", securityId: "SEC-B", side: "BUY", qty: 3, price: 700, fee: 7 },
    // 跨批次卖出 4 股：B1 全取 2 股(成本 1000)，B2 取 2 股 floor(2107*2/3)=1404
    { seq: 7, txnId: "B-S1", securityId: "SEC-B", side: "SELL", qty: 4, price: 800, fee: 5 },
  ];

  const stagedReport = recompute(staged);
  const fullReport = recompute(full);

  let oversellMessage: string;
  const oversell: TxnInput[] = [
    ...full,
    // SEC-B 卖出后只剩 1 股，再卖 2 股必然超卖
    { seq: 8, txnId: "B-S2-BAD", securityId: "SEC-B", side: "SELL", qty: 2, price: 800, fee: 0 },
  ];
  try {
    recompute(oversell);
    oversellMessage = "异常：超卖竟然成功";
  } catch (e) {
    if (e instanceof AppError && e.code === "OVERSOLD") {
      oversellMessage = `已拒绝 [${e.code}]：${e.message}`;
    } else {
      throw e;
    }
  }

  return { stagedReport, fullReport, oversellMessage };
}
