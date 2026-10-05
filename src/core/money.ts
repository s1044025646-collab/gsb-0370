/**
 * 金额以「分」为单位的非负/可负整数（BigInt）。
 * 所有乘法、除法都在 BigInt 上完成，绝不经过 Number 浮点。
 */

/** 把整数分格式化为人民币风格字符串，如 -1234n -> "-12.34"。仅用于展示，不参与计算。 */
export function formatFen(fen: bigint): string {
  const negative = fen < 0n;
  const abs = negative ? -fen : fen;
  const yuan = abs / 100n;
  const cents = abs % 100n;
  const centsText = cents < 10n ? `0${cents.toString()}` : cents.toString();
  return `${negative ? "-" : ""}${yuan.toString()}.${centsText}`;
}

/** 把字符串形式的十进制整数解析为 bigint，拒绝小数、科学计数法与空白。 */
export function parseIntegerText(text: string): bigint {
  if (!/^-?\d+$/.test(text)) {
    throw new Error(`非法整数: ${JSON.stringify(text)}`);
  }
  return BigInt(text);
}
