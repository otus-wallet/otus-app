// A token's terms as its details in the lobby say them: who can mint more, freeze, move or burn it, take a fee or
// pause it, and whether its name and logo can still change; then its supply and its token program.
import type { Address } from '@solana/kit';

import type { Fee, MetadataState, MintTerms } from '@otus-wallet/sdk/access/mint';
import { amount } from '@otus-wallet/sdk/format';
import { TOKEN_2022_PROGRAM_ADDRESS } from '@otus-wallet/sdk/programs/addresses';
import type { Market, Supply } from '../tokens.ts';

/** One line: its name, what it says (a large number in short, `full` saying it whole), the address it names (to copy),
 *  `you` when that address is your wallet's, and `warn` when someone else can take yours, it is stopped now, or Otus
 *  cannot tell. What can stop it later (a freeze or pause authority, a hook) is said plainly: most tokens come with some. */
export type TokenFact = { name: string; value: string; full?: string; address?: Address; you?: boolean; warn?: boolean };

// A large number in short, as 3.8B; and dollars so.
const short = (n: number) => n.toLocaleString('en-US', { notation: 'compact', maximumFractionDigits: 1 });
const shortUsd = (n: number) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD', notation: 'compact', maximumFractionDigits: 1 });
const fullUsd = (n: number) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 });
// Past a thousand, in short and whole on hover; below, whole: in short a small amount would read as 0.
const large = (n: number, whole: string, compact: (n: number) => string) => (Math.abs(n) >= 1000 ? { value: compact(n), full: whole } : { value: whole });
const day = (ms: number) => new Date(ms).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });

/** How a token's facts are read: who an address is (its name, or the address in short), your wallet's address, the
 *  token's symbol, the epoch (when its transfer fee is changing), and now (Unix seconds). */
export type TokenNaming = { who(a: Address): string; wallet: Address; symbol: string; epoch: bigint | null; now: number };

const U64_MAX = 2n ** 64n - 1n;
const METADATA: Record<MetadataState, TokenFact> = {
    mutable: { name: 'Onchain metadata', value: 'Mutable' },
    immutable: { name: 'Onchain metadata', value: 'Immutable' },
    unreadable: { name: 'Onchain metadata', value: 'Unreadable', warn: true },
};

/** A mint's terms, whether its metadata can change, and its market when known, in lines. */
export function tokenFacts(terms: MintTerms, metadata: MetadataState | null, n: TokenNaming, market: Market | null = null): TokenFact[] {
    const facts: TokenFact[] = [];
    const named = (name: string, a: Address, warn = false): TokenFact => ({ name, value: n.who(a), address: a, ...(a === n.wallet && { you: true }), ...(warn && { warn }) });
    // An address's line, when there is one; `none`: what it says without.
    const by = (name: string, a: Address | null, none?: string) => void (a ? facts.push(named(name, a)) : none && facts.push({ name, value: none }));
    by('Mint authority', terms.mintAuthority, 'None');
    by('Freeze authority', terms.freezeAuthority, 'None');
    if (metadata) facts.push(METADATA[metadata]);
    const others: string[] = [];
    for (const e of terms.extensions) {
        switch (e.kind) {
            case 'permanentDelegate':
                if (e.delegate) facts.push(named('Permanent delegate', e.delegate, true));
                break;
            case 'transferFee':
                facts.push({ name: 'Transfer fee', value: feeWords(e.older, e.newer, terms.decimals, n) });
                by('Fee authority', e.authority);
                break;
            case 'transferHook':
                by('Transfer hook', e.program);
                by('Hook authority', e.authority);
                break;
            case 'pausable':
                if (e.paused) facts.push({ name: 'Transfers', value: 'Paused', warn: true });
                by('Pause authority', e.authority);
                break;
            case 'defaultState':
                if (e.frozen) facts.push({ name: 'New accounts', value: 'Start frozen' });
                break;
            case 'nonTransferable':
                facts.push({ name: 'Transferable', value: 'No' });
                break;
            case 'closeAuthority':
                by('Close authority', e.authority);
                break;
            case 'permissionedBurn':
                by('Burn authority', e.authority);
                break;
            case 'interestBearing':
                facts.push({ name: 'Interest', value: `${e.bps / 100}% a year` });
                by('Rate authority', e.authority);
                break;
            case 'scaledUiAmount':
                facts.push({ name: 'Amount multiplier', value: multiplierWords(e, n.now) });
                by('Multiplier authority', e.authority);
                break;
            case 'other':
                others.push(e.name);
                break;
        }
    }
    if (others.length) facts.push({ name: 'Extensions', value: others.join(', ') });
    if (terms.unknown.length) facts.push({ name: 'Unreadable', value: terms.unknown.length === 1 ? 'An extension' : `${terms.unknown.length} extensions`, warn: true });
    facts.push({ name: 'Supply', ...large(Number(terms.supply) / 10 ** terms.decimals, `${amount(terms.supply, terms.decimals, false)} ${n.symbol}`, (x) => `${short(x)} ${n.symbol}`) });
    if (market) facts.push(...marketFacts(market));
    facts.push({ name: 'Program', value: terms.program === TOKEN_2022_PROGRAM_ADDRESS ? 'Token-2022' : 'Token' });
    return facts;
}

/** A token's market in lines: its market cap, how many hold it, its top holders' share, its pools' liquidity, when its
 *  first pool opened. */
export function marketFacts(m: Market): TokenFact[] {
    const facts: TokenFact[] = [];
    if (m.cap !== null) facts.push({ name: 'Market cap', ...large(m.cap, fullUsd(m.cap), shortUsd) });
    if (m.holders !== null) facts.push({ name: 'Holders', value: m.holders.toLocaleString('en-US') });
    if (m.topHolders !== null) facts.push({ name: 'Top holders', value: `${m.topHolders.toLocaleString('en-US', { maximumFractionDigits: 1 })}% of supply` });
    if (m.liquidity !== null) facts.push({ name: 'Liquidity', ...large(m.liquidity, fullUsd(m.liquidity), shortUsd) });
    if (m.firstPool !== null) facts.push({ name: 'First pool', value: day(m.firstPool) });
    return facts;
}

/** SOL's own facts: it has no mint, only a wrapped one for token programs; its supply and what circulates, when known. */
export function solFacts(supply: Supply | null): TokenFact[] {
    const facts: TokenFact[] = [{ name: 'Type', value: 'Native token' }];
    const sol = (n: number) => large(n, `${n.toLocaleString('en-US', { maximumFractionDigits: 9 })} SOL`, (x) => `${short(x)} SOL`);
    if (supply) facts.push({ name: 'Supply', ...sol(supply.total) }, { name: 'Circulating', ...sol(supply.circulating) });
    facts.push({ name: 'Program', value: 'System' });
    return facts;
}

// The multiplier in force, and the next one while it is still to come (from a date a calendar can say).
function multiplierWords({ multiplier, next, nextAt }: { multiplier: number; next: number; nextAt: bigint }, now: number): string {
    const x = (m: number) => `×${m.toLocaleString('en-US', { maximumSignificantDigits: 6 })}`;
    if (now >= nextAt) return x(next);
    const from = Number(nextAt) * 1000;
    return next === multiplier || Number.isNaN(new Date(from).getTime()) ? x(multiplier) : `${x(multiplier)}; ${x(next)} from ${day(from)}`;
}

// The fee in force, its cap when it has one, and the one to come: the older holds until the newer's epoch.
function feeWords(older: Fee, newer: Fee, decimals: number, { epoch, symbol }: TokenNaming): string {
    const pending = older.bps !== newer.bps || older.max !== newer.max;
    const capped = (f: Fee) => `${f.bps / 100}%${f.bps > 0 && f.max < U64_MAX ? `, at most ${amount(f.max, decimals, false)} ${symbol}` : ''}`; // no fee has no cap to tell
    if (!pending || (epoch !== null && epoch >= newer.epoch)) return capped(newer);
    return epoch === null ? `${capped(older)} or ${capped(newer)}` : `${capped(older)}; ${capped(newer)} from epoch ${newer.epoch}`;
}
