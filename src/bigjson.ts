/** bigint 的 JSON 序列化/反序列化（金额可能超过 int64，统一以字符串落库）。 */
export function encodeBigJson(value: unknown): string {
  return JSON.stringify(value, (_key, v) => (typeof v === 'bigint' ? { $bigint: v.toString() } : v));
}

export function decodeBigJson<T>(text: string): T {
  return JSON.parse(text, (_key, v) =>
    v !== null && typeof v === 'object' && typeof v.$bigint === 'string' ? BigInt(v.$bigint) : v,
  ) as T;
}
