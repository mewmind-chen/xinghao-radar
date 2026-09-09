/** Compare nullable numeric import fields without narrowing a decimal to an integer. */
export function sameNullableNumber(left: unknown, right: unknown): boolean {
  const a = left == null || left === "" ? null : Number(left);
  const b = right == null || right === "" ? null : Number(right);
  return Number.isFinite(a) && Number.isFinite(b) ? a === b : a === b;
}
