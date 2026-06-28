// A pure app-lib helper — the generator must INLINE this into the output
// (no import left behind), the way @/lib helpers get inlined.
export type Cents = number;

export function usd(cents: Cents): string {
  return "$" + (cents / 100).toFixed(2);
}
