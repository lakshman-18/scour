import { BudgetExceeded, type BudgetLedger } from './types.js';

/**
 * The cost governor. Every paid call must pass through here first.
 * Default cap is $0, which makes "accidentally expensive" structurally
 * impossible rather than a matter of discipline.
 */
export class Ledger implements BudgetLedger {
  private _spent = 0;
  private _entries: { label: string; amountUsd: number; at: number }[] = [];

  constructor(private _cap: number) {}

  get spentUsd(): number {
    return this._spent;
  }
  get capUsd(): number {
    return this._cap;
  }
  get entries(): { label: string; amountUsd: number; at: number }[] {
    return [...this._entries];
  }

  canAfford(amount: number): boolean {
    return this._spent + amount <= this._cap + 1e-9;
  }

  charge(amount: number, label: string): void {
    if (amount <= 0) return; // free tiers never touch the ledger
    if (!this.canAfford(amount)) throw new BudgetExceeded(amount, this._cap, this._spent);
    this._spent += amount;
    this._entries.push({ label, amountUsd: amount, at: Date.now() });
  }

  /** Human-readable receipt, printed by `--stats`. */
  summary(): string {
    if (this._entries.length === 0) return 'spent $0.0000 (everything came from free tiers)';
    const byLabel = new Map<string, number>();
    for (const e of this._entries) byLabel.set(e.label, (byLabel.get(e.label) ?? 0) + e.amountUsd);
    const lines = [...byLabel.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([l, a]) => `  ${l}: $${a.toFixed(4)}`);
    return `spent $${this._spent.toFixed(4)} of $${this._cap.toFixed(2)} cap\n${lines.join('\n')}`;
  }
}

/** Published per-call prices for the paid fallbacks, used for estimates. */
export const PRICES = {
  firecrawlScrape: 0.001,
  jinaReader: 0.0002,
  // Brave and Tavily are metered by monthly allowance in core/usage.ts.
  exaSearch: 0.0025,
  apifyActorRun: 0.005,
} as const;
