// Money helpers. All internal arithmetic is done in satang (integer, 1/100 baht)
// to avoid floating point errors. Public values are returned in baht (2 decimals).

export const toSatang = (baht) => Math.round((Number(baht) || 0) * 100);
export const toBaht = (satang) => Math.round(satang) / 100;
export const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

/**
 * Split `total` (integer) across `weights` proportionally so that the parts sum exactly to total
 * (largest remainder method).
 */
export function allocate(total, weights) {
  const sum = weights.reduce((a, b) => a + Math.max(0, b), 0);
  if (!weights.length) return [];
  if (sum <= 0 || total === 0) return weights.map(() => 0);
  const raw = weights.map((w) => (Math.max(0, w) * total) / sum);
  const floored = raw.map((r) => Math.trunc(r));
  let rest = total - floored.reduce((a, b) => a + b, 0);
  const order = raw
    .map((r, i) => ({ i, frac: Math.abs(r - Math.trunc(r)) }))
    .sort((a, b) => b.frac - a.frac);
  const step = rest > 0 ? 1 : -1;
  for (let k = 0; rest !== 0 && k < order.length * 2; k++) {
    floored[order[k % order.length].i] += step;
    rest -= step;
  }
  return floored;
}

const fmt2 = new Intl.NumberFormat('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmt0 = new Intl.NumberFormat('th-TH', { maximumFractionDigits: 0 });

export const money = (n) => fmt2.format(Number(n) || 0);
export const int = (n) => fmt0.format(Number(n) || 0);
export const baht = (n, symbol = '฿') => `${symbol}${money(n)}`;
