// Amounts, prices and balances as the popup shows them.
import { USDC, USDT, WSOL, type Holding, type Holdings } from '../holdings.ts';

export const dollars = (n: number) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: n !== 0 && Math.abs(n) < 0.01 ? 6 : 2 });
export const amount = (a: Pick<Holding, 'units' | 'decimals'>) => (Number(a.units) / 10 ** a.decimals).toLocaleString('en-US', { maximumFractionDigits: Math.min(a.decimals, 6) });

/** A price as people read it: cents from about a dollar up, then four decimals, then a few significant digits. */
export const price = (n: number) =>
    n >= 0.995 ? dollars(n) : n >= 0.01 ? `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 4 })}` : `$${n.toLocaleString('en-US', { maximumSignificantDigits: 3 })}`;

/** The balance's font size: as large as the popup's width lets it be, the font's figures 0.6 of its size wide. */
export const balanceSize = (total: string) => Math.min(46, Math.floor(336 / (0.6 * Math.max(total.length, 1))));

/** How a price moved: its percent with two decimals, and whether up, down or flat at that precision. */
export function trendOf(change: number): { shown: string; way: 'up' | 'down' | 'flat' } {
    const shown = Math.abs(change).toFixed(2);
    return { shown, way: shown === '0.00' ? 'flat' : change > 0 ? 'up' : 'down' };
}

/** The total's move over 24 hours: what the verified, priced tokens held now were worth a day ago, by their price change. */
export function dayChange(held: Holdings): { delta: number; percent: number } | null {
    const priced = held.assets.filter((a) => a.verified && a.usd !== null && a.usd > 0 && a.change !== null && a.change > -100);
    if (!priced.length) return null;
    const delta = priced.reduce((sum, a) => sum + (a.usd! * a.change!) / (100 + a.change!), 0);
    const before = held.usd - delta;
    return { delta, percent: before > 0 ? (delta / before) * 100 : 0 };
}

/** Base units as a plain decimal, as an input takes it: "1.5", never "1,500.00". */
export function decimal(units: bigint, decimals: number): string {
    const digits = units.toString().padStart(decimals + 1, '0');
    const fraction = digits.slice(digits.length - decimals).replace(/0+$/, '');
    return `${digits.slice(0, digits.length - decimals)}${fraction ? `.${fraction}` : ''}`;
}

/** What the lobby lists while it cannot read the wallet yet, or at all: SOL, USDC and USDT at 0. */
export const NOTHING: Holdings = {
    usd: 0,
    sol: 0n,
    assets: [
        { mint: WSOL, symbol: 'SOL', name: 'Solana', icon: null, verified: true, native: true, units: 0n, decimals: 9, usd: 0, price: null, change: null, source: null },
        { mint: USDC, symbol: 'USDC', name: 'USD Coin', icon: null, verified: true, native: false, units: 0n, decimals: 6, usd: 0, price: null, change: null, source: null },
        { mint: USDT, symbol: 'USDT', name: 'USDT', icon: null, verified: true, native: false, units: 0n, decimals: 6, usd: 0, price: null, change: null, source: null },
    ],
};
