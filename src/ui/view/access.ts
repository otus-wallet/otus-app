// Who besides the wallet has access to what it holds, as the Access screen says it: a line for each grant, worst first,
// with the site behind it when Otus kept that, and how many others that comes to. An issuer's power to freeze a token is
// said apart and quietly: it moves nothing, and the tokens most people hold come with one.
import type { Address } from '@solana/kit';

import type { Grant } from '@otus-wallet/sdk/access/access';
import { amount, short, sol } from '@otus-wallet/sdk/format';
import type { Given, Signed } from '../../shell/state.ts';

/** What the words need: a token's symbol and decimals when known, a name for an address, and what Otus kept of the
 *  sites behind delegates and transactions waiting on a nonce. */
export type AccessNaming = {
    wallet: Address;
    program(address: Address): string;
    symbol(mint: Address): string;
    decimals(mint: Address): number | null;
    who(address: Address): string;
    given: Given[];
    waiting: Signed[];
};

/** A grant in words. `fix`: what you can do about it yourself: revoke a delegate, or cancel a transaction by moving
 *  its nonce on, which only the nonce's authority can. */
export type AccessRow = { grant: Grant; title: string; sub: string; fix: 'revoke' | 'cancel' | null };

const day = (at: number) => new Date(at * 1000).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });

/** The grants that let someone else move or close what you hold, in words, worst first. */
export function accessRows(grants: Grant[], n: AccessNaming): AccessRow[] {
    return grants.flatMap((g): AccessRow[] => {
        switch (g.kind) {
            case 'taken':
                return [{ grant: g, title: `Your wallet belongs to ${n.program(g.program)}`, sub: 'That program decides what leaves it, all it holds included', fix: null }];
            case 'delegate': {
                const symbol = n.symbol(g.mint);
                const decimals = n.decimals(g.mint);
                const what = g.all ? `all your ${symbol}` : `up to ${decimals === null ? `${g.allowance} units of` : amount(g.allowance, decimals, false)} ${symbol}`;
                const given = n.given.find((x) => x.account === g.account && x.to === g.to);
                return [{ grant: g, title: `${n.who(g.to)} can move ${what}`, sub: given ? `Approved on ${given.host} · ${day(given.at)}` : `A delegate on your ${symbol} account`, fix: 'revoke' }];
            }
            case 'permanent':
                return [{ grant: g, title: `The issuer of ${n.symbol(g.mint)} can move or burn yours`, sub: `Its permanent delegate ${short(g.to)}, at any time`, fix: null }];
            case 'nonce': {
                const signed = n.waiting.find((w) => w.account === g.account && w.nonce === g.nonce);
                const where = signed ? ` on ${signed.host}` : '';
                const yours = g.authority === n.wallet;
                return [{ grant: g, title: `A transaction you signed${where} can still run`, sub: yours ? 'It waits on a nonce of yours, not a blockhash: it never expires' : `It waits on a nonce, not a blockhash: only ${short(g.authority)} can cancel it`, fix: yours ? 'cancel' : null }];
            }
            case 'closer':
                if (g.sol > 0n) return [{ grant: g, title: `${n.who(g.to)} can close your wrapped SOL account`, sub: `And take the ${sol(g.sol)} SOL in it, at any time`, fix: null }];
                return [{ grant: g, title: `${n.who(g.to)} can close your ${n.symbol(g.mint)} account`, sub: 'Only once it holds 0 tokens: they keep its rent, about 0.002 SOL', fix: null }];
            case 'freeze':
                return [];
        }
    });
}

/** The tokens whose issuer can freeze yours, by symbol. */
export const freezable = (grants: Grant[], n: Pick<AccessNaming, 'symbol'>): string[] => grants.flatMap((g) => (g.kind === 'freeze' ? [n.symbol(g.mint)] : []));

/** How many others can move or close what you hold: each delegate, issuer and closer once, and each transaction that
 *  can still run. */
export function others(grants: Grant[]): number {
    const who = new Set(grants.flatMap((g) => (g.kind === 'freeze' ? [] : [g.kind === 'nonce' ? `nonce ${g.account} ${g.nonce}` : g.kind === 'taken' ? g.program : g.to])));
    return who.size;
}

/** Who else has access, in a few words: none, someone, or how many; never "only you" while some issuers went unread. */
export function accessWords(n: number, unchecked = 0): string {
    if (n === 0) return unchecked > 0 ? 'No one else, among what Otus could check' : 'Only you can move your funds';
    return n === 1 ? 'Someone else can move your funds' : `${n} others can move your funds`;
}
