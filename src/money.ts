/**
 * 金额工具：全部金额使用整数“分”，内部一律 bigint，绝不使用浮点乘法生成成本。
 * 格式化金额仅用于展示，不能再用于后续计算。
 */

/** 将非负整数分金额格式化为 `元.分分`，例如 3001 -> "30.01"。 */
export function formatCents(cents: bigint): string {
  const negative = cents < 0n;
  const abs = negative ? -cents : cents;
  const yuan = abs / 100n;
  const fen = abs % 100n;
  const fenText = fen < 10n ? `0${fen.toString()}` : fen.toString();
  return `${negative ? '-' : ''}${yuan.toString()}.${fenText}`;
}

/** 解析以“分”给出的值，仅接受安全的十进制整数字符串或 number 整数。 */
export function toBigInt(value: number | string): bigint {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) {
      throw new TypeError('金额/数量必须是安全整数');
    }
    return BigInt(value);
  }
  if (!/^-?\d+$/.test(value)) {
    throw new TypeError(`非法整数: ${value}`);
  }
  return BigInt(value);
}
