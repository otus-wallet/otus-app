// A token's terms as its details in the lobby say them: who can mint more, freeze, move or burn it, take a fee or
// pause it, and whether its name and logo can still change; then its supply and its token program.
import type { Address } from '@solana/kit';

import type { Fee, MetadataState, MintTerms } from '@otus-wallet/sdk/access/mint';
import { amount } from '@otus-wallet/sdk/format';
import { TOKEN_2022_PROGRAM_ADDRESS } from '@otus-wallet/sdk/programs/addresses';
import type { Market, Supply } from '../tokens.ts';

/** One line: its name, what it says, the address it names (to copy), and `warn` when someone else can take yours, it
 *  is stopped now, or Otus cannot tell. What can stop it later (a freeze or pause authority, a hook) is said plainly:
 *  most tokens come with some. */
export type TokenFact = { name: string; value: string; address?: Address; warn?: boolean };

/** How a token's facts are read: who an address is (its name, or the address in short), the token's symbol, the epoch
 *  (when its transfer fee is changing), and now (Unix seconds). */
export type TokenNaming = { who(a: Address): string; symbol: string; epoch: bigint | null; now: number };

const U64_MAX = 2n ** 64n - 1n;
const METADATA: Record<MetadataState, TokenFact> = {
    mutable: { name: 'Metadata', value: 'Mutable' },
    immutable: { name: 'Metadata', value: 'Immutable' },
    unreadable: { name: 'Metadata', value: 'Unreadable', warn: true },
};

/** A mint's terms, whether its metadata can change, and its market when known, in lines. */
export function tokenFacts(terms: MintTerms, metadata: MetadataState | null, n: TokenNaming, market: Market | null = null): TokenFact[] {
    const { who } = n;
    const facts: TokenFact[] = [];
    // An address's line, when there is one; `none`: what it says without.
    const by = (name: string, a: Address | null, none?: string) => void (a ? facts.push({ name, value: who(a), address: a }) : none && facts.push({ name, value: none }));
    by('Mint authority', terms.mintAuthority, 'None');
    by('Freeze authority', terms.freezeAuthority, 'None');
    if (metadata) facts.push(METADATA[metadata]);
    const others: string[] = [];
    for (const e of terms.extensions) {
        switch (e.kind) {
            case 'permanentDelegate':
                if (e.delegate) facts.push({ name: 'Permanent delegate', value: who(e.delegate), address: e.delegate, warn: true });
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
                facts.push({ name: 'Amount multiplier', value: `×${n.now >= e.nextAt ? e.next : e.multiplier}` });
                by('Multiplier authority', e.authority);
                break;
            case 'other':
                others.push(e.name);
                break;
        }
    }
    if (others.length) facts.push({ name: 'Extensions', value: others.join(', ') });
    if (terms.unknown.length) facts.push({ name: 'Unreadable', value: terms.unknown.length === 1 ? 'An extension' : `${terms.unknown.length} extensions`, warn: true });
    facts.push({ name: 'Supply', value: `${amount(terms.supply, terms.decimals, false)} ${n.symbol}` });
    if (market) facts.push(...marketFacts(market));
    facts.push({ name: 'Program', value: terms.program === TOKEN_2022_PROGRAM_ADDRESS ? 'Token-2022' : 'Token' });
    return facts;
}

/** A token's market in lines: how many hold it, its top holders' share, its pools' liquidity, when its first opened. */
export function marketFacts(m: Market): TokenFact[] {
    const facts: TokenFact[] = [];
    if (m.holders !== null) facts.push({ name: 'Holders', value: m.holders.toLocaleString('en-US') });
    if (m.topHolders !== null) facts.push({ name: 'Top holders', value: `${m.topHolders.toLocaleString('en-US', { maximumFractionDigits: 1 })}% of supply` });
    if (m.liquidity !== null) facts.push({ name: 'Liquidity', value: m.liquidity.toLocaleString('en-US', { style: 'currency', currency: 'USD', notation: 'compact', maximumFractionDigits: 1 }) });
    if (m.firstPool !== null) facts.push({ name: 'First pool', value: new Date(m.firstPool).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }) });
    return facts;
}

/** SOL's own facts: it has no mint, only a wrapped one for token programs; its supply and what circulates, when known. */
export function solFacts(supply: Supply | null): TokenFact[] {
    const facts: TokenFact[] = [{ name: 'Type', value: 'Native token' }];
    const whole = (sol: number) => `${Math.round(sol).toLocaleString('en-US')} SOL`; // decimals of hundreds of millions say nothing
    if (supply) facts.push({ name: 'Supply', value: whole(supply.total) }, { name: 'Circulating', value: whole(supply.circulating) });
    facts.push({ name: 'Program', value: 'System' });
    return facts;
}

// The fee in force, its cap when it has one, and the one to come: the older holds until the newer's epoch.
function feeWords(older: Fee, newer: Fee, decimals: number, { epoch, symbol }: TokenNaming): string {
    const pending = older.bps !== newer.bps || older.max !== newer.max;
    const capped = (f: Fee) => `${f.bps / 100}%${f.bps > 0 && f.max < U64_MAX ? `, at most ${amount(f.max, decimals, false)} ${symbol}` : ''}`; // no fee has no cap to tell
    if (!pending || (epoch !== null && epoch >= newer.epoch)) return capped(newer);
    return epoch === null ? `${capped(older)} or ${capped(newer)}` : `${capped(older)}; ${capped(newer)} from epoch ${newer.epoch}`;
}
