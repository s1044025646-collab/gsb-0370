import type { LedgerReport, Lot, SaleResult } from '../types.js';
import { formatCents } from '../money.js';

function padRight(s: string, n: number): string {
  const len = visibleLen(s);
  return len >= n ? s : s + ' '.repeat(n - len);
}

function padLeft(s: string, n: number): string {
  const len = visibleLen(s);
  return len >= n ? s : ' '.repeat(n - len) + s;
}

function visibleLen(s: string): number {
  let n = 0;
  for (const ch of s) n += ch.charCodeAt(0) > 255 ? 2 : 1;
  return n;
}

function table(headers: string[], rows: string[][], align: ('l' | 'r')[]): string {
  const widths = headers.map((h, i) =>
    Math.max(visibleLen(h), ...rows.map((r) => visibleLen(r[i] ?? ''))),
  );
  const line = (cells: string[]): string =>
    cells
      .map((cell, i) => (align[i] === 'r' ? padLeft(cell, widths[i]!) : padRight(cell, widths[i]!)))
      .join('  ');
  const sep = widths.map((w) => '-'.repeat(w)).join('  ');
  return [line(headers), sep, ...rows.map(line)].join('\n');
}

export function formatLots(report: LedgerReport): string {
  const open = report.lots.filter((l) => !l.closed);
  const rows = open.map((l: Lot) => [
    l.security,
    String(l.lotIndex),
    l.buyTradeId,
    String(l.buySeq),
    l.remainingQty.toString(),
    l.remainingCost.toString(),
    formatCents(l.remainingCost),
  ]);
  const head = ['证券', '批次', '买入编号', '序号', '剩余数量', '剩余成本(分)', '剩余金额'];
  const out =
    rows.length > 0
      ? table(head, rows, ['l', 'r', 'l', 'r', 'r', 'r', 'r'])
      : '（无未清空批次）';

  const sumRows = report.summaries.map((s) => [
    s.security,
    s.remainingQty.toString(),
    s.remainingCost.toString(),
    formatCents(s.remainingCost),
    s.costCarried.toString(),
    formatCents(s.costCarried),
    s.realizedPnl.toString(),
    formatCents(s.realizedPnl),
  ]);
  const sumTable = table(
    ['证券', '持仓数量', '剩余成本(分)', '剩余金额', '已结转成本(分)', '已结转金额', '已实现盈亏(分)', '盈亏金额'],
    sumRows,
    ['l', 'r', 'r', 'r', 'r', 'r', 'r', 'r'],
  );

  const t = report.totals;
  const conserve = t.totalBuyCost === t.costCarried + t.remainingCost ? '成立' : '不成立（异常）';
  return [
    '== 未清空批次（FIFO 明细，不合并同价批次）==',
    out,
    '',
    '== 分证券汇总 ==',
    sumTable,
    '',
    '== 全局合计 ==',
    `买入总成本: ${t.totalBuyCost} 分 (${formatCents(t.totalBuyCost)})`,
    `已结转成本: ${t.costCarried} 分 (${formatCents(t.costCarried)})`,
    `剩余成本:   ${t.remainingCost} 分 (${formatCents(t.remainingCost)})`,
    `已实现盈亏: ${t.realizedPnl} 分 (${formatCents(t.realizedPnl)})`,
    `守恒校验 买入总成本 = 已结转 + 剩余: ${conserve}`,
  ].join('\n');
}

export function formatSale(sale: SaleResult): string {
  const head = ['命中批次', '买入编号', '序号', '消耗数量', '分摊前成本', '带走成本', '分摊后成本', '本笔贡献盈亏'];
  const rows = sale.hits.map((h) => [
    String(h.lotIndex),
    h.buyTradeId,
    String(h.buySeq),
    h.consumedQty.toString(),
    h.costBefore.toString(),
    h.costTaken.toString(),
    h.costAfter.toString(),
    `${h.pnlContribution.toString()} (${formatCents(h.pnlContribution)})`,
  ]);
  const hitSum = sale.hits.reduce((s, h) => s + h.consumedQty, 0n);
  const pnlSum = sale.hits.reduce((s, h) => s + h.pnlContribution, 0n);
  const costSum = sale.hits.reduce((s, h) => s + h.costTaken, 0n);
  return [
    `卖出 ${sale.tradeId} (seq=${sale.seq}) 证券 ${sale.security} 数量 ${sale.qty} 单价 ${sale.price} 手续费 ${sale.fee}`,
    table(head, rows, ['r', 'l', 'r', 'r', 'r', 'r', 'r', 'r']),
    `消耗数量合计: ${hitSum}（应等于卖出数量 ${sale.qty}：${hitSum === sale.qty ? '是' : '否'}）`,
    `成交收入(毛): ${sale.grossRevenue} 分 (${formatCents(sale.grossRevenue)})`,
    `净收入 = 毛收入 - 手续费(只扣一次): ${sale.netRevenue} 分 (${formatCents(sale.netRevenue)})`,
    `消耗成本合计: ${costSum} 分；已实现盈亏: ${sale.realizedPnl} 分 (${formatCents(sale.realizedPnl)})`,
    `片段贡献盈亏合计: ${pnlSum}（应等于整笔盈亏：${pnlSum === sale.realizedPnl ? '是' : '否'}）`,
  ].join('\n');
}

export function formatAllSales(report: LedgerReport): string {
  if (report.sales.length === 0) return '（无卖出）';
  return report.sales.map((s) => formatSale(s)).join('\n\n');
}
