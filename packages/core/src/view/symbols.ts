// What a token is called in words. A verified one by its symbol. One no list vouches for by its maker's, as people
// know it by that name, unless the name is one people know of another token (anyone can call a token USDC: then it is
// "fake USDC"), or reads as a link or an address (then its mint).
import { latin } from '@otus-wallet/sdk/review/sites';
import type { TokenInfo } from '../tokens.ts';
import { nameOr } from './names.ts';

/** Symbols scams like to give their own tokens. */
export const IMITATED: ReadonlySet<string> = new Set(['SOL', 'WSOL', 'USDC', 'USDT', 'JUP', 'BONK', 'JTO', 'PYTH', 'RAY', 'ORCA', 'MSOL', 'JITOSOL', 'BSOL', 'JUPSOL', 'INF', 'WIF', 'TRUMP', 'ETH', 'WETH', 'BTC', 'WBTC', 'CBBTC', 'PYUSD', 'USDS', 'USDE', 'EURC', 'PENGU', 'POPCAT', 'RENDER', 'HNT']);

// A maker's name that would take the reader somewhere: a link, a domain, a handle.
const LINKISH = /[/:@\\]|\.[a-z]{2,}/i;
// Longer than any symbol: a message in its place.
const LONGEST = 16;

/** The symbol words give `mint`, from what Jupiter said of it (`t`), or the mint when there is none to give. `known`:
 *  the symbols of the verified tokens in view, as `latin` reads them, upper case. */
export function symbolOf(mint: string, t: TokenInfo | null | undefined, known: ReadonlySet<string> = new Set()): string {
    const symbol = t?.symbol.trim() ?? '';
    if (!t || !symbol) return mint;
    if (t.verified) return nameOr(symbol, mint);
    if (symbol.length > LONGEST || LINKISH.test(symbol) || nameOr(symbol, mint) === mint) return mint;
    const read = latin(symbol).toUpperCase();
    return IMITATED.has(read) || known.has(read) ? `fake ${symbol}` : symbol;
}
