import { formatFen } from "../core/money";
import type { LedgerReport, SellResult } from "../core/types";

function pad(text: string, width: number): string {
  // 中文按两个显示宽度粗估，保证表格基本对齐
  let visual = 0;
  for (const ch of text) visual += ch.codePointAt(0)! > 255 ? 2 : 1;
  return text + " ".repeat(Math.max(0, width - visual));
}

function row(cells: string[], widths: number[]): string {
  return cells.map((c, i) => pad(c, widths[i] ?? c.length)).join(" | ");
}

export function renderSell(sell: SellResult): string {
  const lines: string[] = [];
  lines.push(
    `卖出 seq=${sell.seq} txnId=${sell.txnId} 证券=${sell.securityId} 数量=${sell.qty} 单价=${sell.price}分 手续费=${sell.fee}分`
  );
  lines.push(`  总收入 ${sell.grossIncome.toString()}分 (${formatFen(sell.grossIncome)}元)`);
  lines.push(`  净收入 ${sell.netIncome.toString()}分 (${formatFen(sell.netIncome)}元)`);
  lines.push(`  结转成本 ${sell.allocatedCost.toString()}分 (${formatFen(sell.allocatedCost)}元)`);
  lines.push(`  已实现盈亏 ${sell.realizedPnl.toString()}分 (${formatFen(sell.realizedPnl)}元)`);
  lines.push("  批次消耗表：");

  const headers = ["买入seq", "买入编号", "消耗数量", "扣前数量", "扣后数量", "扣前成本(分)", "分摊成本(分)", "扣后成本(分)", "贡献盈亏(分)"];
  const widths = headers.map((h) => h.length);
  const dataRows = sell.consumptions.map((c) => [
    String(c.buySeq),
    c.buyTxnId,
    String(c.consumedQty),
    String(c.qtyBefore),
    String(c.qtyAfter),
    c.costBefore.toString(),
    c.costAllocated.toString(),
    c.costAfter.toString(),
    c.pnlContribution.toString(),
  ]);
  for (const r of dataRows) r.forEach((v, i) => (widths[i] = Math.max(widths[i]!, v.length)));
  lines.push("    " + row(headers, widths));
  lines.push("    " + "-".repeat(widths.reduce((s, w) => s + w, 0) + widths.length * 3 - 1));
  for (const r of dataRows) lines.push("    " + row(r, widths));

  const qtySum = sell.consumptions.reduce((s, c) => s + c.consumedQty, 0);
  const costSum = sell.consumptions.reduce((s, c) => s + c.costAllocated, 0n);
  lines.push(`  校验：消耗数量合计=${qtySum}（应等于卖出数量 ${sell.qty}），分摊成本合计=${costSum}分`);
  return lines.join("\n");
}

export function renderReport(report: LedgerReport): string {
  const lines: string[] = [];

  lines.push("== 当前持仓批次（不同来源买入不合并） ==");
  const open = report.lots.filter((l) => !l.closed);
  if (open.length === 0) {
    lines.push("（无剩余批次）");
  } else {
    for (const l of open) {
      lines.push(
        `  证券 ${l.securityId} | 买入 seq=${l.buySeq} ${l.buyTxnId} | 剩余 ${l.remainingQty}/${l.origQty} 股 | 剩余成本 ${l.remainingCost.toString()}分 (${formatFen(l.remainingCost)}元) / 原始 ${l.origCost.toString()}分`
      );
    }
  }

  lines.push("");
  lines.push("== 分证券汇总 ==");
  for (const s of report.summaries) {
    lines.push(
      `  ${s.securityId}: 剩余 ${s.remainingQty} 股 / 剩余成本 ${s.remainingCost.toString()}分 (${formatFen(s.remainingCost)}元)`
    );
    lines.push(
      `    买入总成本 ${s.buyTotalCost.toString()}分 = 已结转 ${s.costCarried.toString()}分 + 剩余 ${s.remainingCost.toString()}分；已卖 ${s.soldQty} 股；已实现盈亏 ${s.realizedPnl.toString()}分 (${formatFen(s.realizedPnl)}元)`
    );
  }
  lines.push(`全部证券已实现盈亏合计：${report.totalRealizedPnl.toString()}分 (${formatFen(report.totalRealizedPnl)}元)`);

  if (report.sells.length > 0) {
    lines.push("");
    lines.push("== 卖出明细 ==");
    for (const s of report.sells) lines.push(renderSell(s), "");
  }
  return lines.join("\n");
}
