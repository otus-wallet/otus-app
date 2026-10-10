// How the transaction's accounts and tokens read in the window: names for addresses, symbols and decimals for mints,
// and what happened to each account, in words.
import { SYSTEM_PROGRAM_ADDRESS } from '@solana-program/system';
import { isAddress, type Address } from '@solana/kit';

import { amount, cap, quantity, SOL_DECIMALS } from '@otus-wallet/sdk/format';
import { STAKE_PROGRAM, USDC, USDT, WSOL } from '@otus-wallet/sdk/programs/addresses';
import { PROGRAM_NAMES } from '@otus-wallet/sdk/programs/known';
import { SYSVARS } from '@otus-wallet/sdk/review/assess';
import { defaultUnits, lamportsFor, unitLimit, unitPrice } from '@otus-wallet/sdk/review/budget';
import { read } from '@otus-wallet/sdk/review/changes';
import type { Names } from '@otus-wallet/sdk/review/effects';
import type { Review } from '@otus-wallet/sdk/review/review';
import type { Known } from '../view.ts';

const SYMBOLS: Record<string, string> = { [USDC]: 'USDC', [USDT]: 'USDT' };

// How the transaction's accounts and tokens read: names for addresses, symbols and decimals for mints. A symbol only
// for a verified token: anyone can call a token "USDC", so any other goes by its address.
/** How a line marks an address as yours, for the window to tag: "<your address> (you)". */
export const YOU = ' (you)';

// A whole address in words: base58, 32 to 44 characters, a word of its own (not the start of a signature), and not cut
// short by an ellipsis (words cut to fit end in one: what is left of an address may still read as another).
const WHOLE = /(?<![1-9A-HJ-NP-Za-km-z])([1-9A-HJ-NP-Za-km-z]{32,44})(?![1-9A-HJ-NP-Za-km-z…])/;

// Bytes as Otus writes them, hex: base58 has every one of its characters, and no address is made of them alone (but the
// System Program's, all ones: hex has a letter).
const HEX = /^[0-9]*[a-f][0-9a-f]*$/;

/** Words split around each whole address in them, for the window to cut short: the addresses at the odd places. A word
 *  that only looks like one (not 32 bytes, or hex) stays in the words. */
export function atAddresses(words: string): string[] {
    const out = [''];
    for (const [i, w] of words.split(WHOLE).entries()) {
        if (i % 2 && isAddress(w) && !HEX.test(w)) out.push(w, '');
        else out[out.length - 1] += w;
    }
    return out;
}

/** Someone else's name for an address (a token's symbol, a validator's name), or the address when there is none, or
 *  when the name holds an address of its own: cut short, it would pass for the one it names. */
export const nameOr = (name: string | null | undefined, address: string): string => (name && atAddresses(name).length === 1 ? name : address);

/** Whether words end with the wallet's own address, whole: what " (you)" after them may tag. Words a program or a
 *  token's maker wrote can say " (you)" too, but not after your address. */
export function endsYours(words: string, wallet: string | null): boolean {
    const at = atAddresses(words);
    return wallet !== null && at.length > 1 && at[at.length - 1] === '' && at[at.length - 2] === wallet;
}

/** `tagged`: you named by your address, marked yours, where the window has room for no more than a line. */
export function names(r: Review, known: Known, wallet: Address, mainnet: boolean, tagged = false): Names {
    const { mine } = r.assessment;
    const loaded = new Map(r.accounts.map((a) => [a.address, a.state]));
    const changed = new Map(r.changes.accounts.map((c) => [c.address, c]));
    const asLoaded = (a: Address) => {
        const state = loaded.get(a);
        return state ? read(state) : null;
    };
    const stateOf = (a: Address) => changed.get(a)?.after ?? changed.get(a)?.before ?? asLoaded(a);
    const tokenOf = (a: Address) => changed.get(a)?.after?.token ?? changed.get(a)?.before?.token ?? asLoaded(a)?.token ?? null;
    const token = (mint: Address | null) => {
        if (!mint) return { symbol: 'tokens', decimals: null, verified: false };
        const t = known.tokens.get(mint);
        const verified = mint === WSOL || (mainnet && (SYMBOLS[mint] !== undefined || t?.verified === true));
        const symbol = mint === WSOL ? 'wSOL' : verified ? t?.symbol || SYMBOLS[mint] || mint : mint;
        const places = known.decimals.get(mint) ?? t?.decimals ?? null;
        return { symbol, decimals: places !== null && Number.isInteger(places) && places >= 0 && places <= 255 ? places : null, verified };
    };
    const who = (a: Address): string => {
        if (a === wallet) return tagged ? `${wallet}${YOU}` : 'you';
        const t = tokenOf(a);
        if (mine.has(a)) {
            if (t) return `your ${t.native ? 'wrapped SOL' : token(t.mint).symbol} account`;
            const s = stateOf(a);
            return `your ${s?.program === STAKE_PROGRAM ? 'stake account' : s?.program === SYSTEM_PROGRAM_ADDRESS && s.space === 80 ? 'nonce account' : 'account'} ${a}`;
        }
        return PROGRAM_NAMES.get(a) ?? (SYSVARS.has(a) ? 'a sysvar' : a);
    };
    // What happened to an account, in words: its tokens, its SOL, a new owner or delegate, a close.
    const changesOf = (a: Address): string[] => {
        const c = changed.get(a);
        if (!c) return [];
        const out: string[] = [];
        const [from, to] = [c.before?.token ?? null, c.after?.token ?? null];
        const held = to ?? from;
        if (held) {
            const delta = (to?.amount ?? 0n) - (from?.amount ?? 0n);
            const t = token(held.mint);
            if (delta !== 0n) out.push(`${quantity(delta, t.decimals)} ${t.symbol} ${delta < 0n ? 'from' : 'to'} ${who(a)}`);
            if (from && to && from.owner !== to.owner) out.push(`${cap(who(a))} now belongs to ${to.owner}`);
            if (to?.delegate && to.delegate !== from?.delegate) out.push(`${to.delegate} may move the tokens in ${who(a)}`);
        } else {
            const lamports = (c.after?.lamports ?? 0n) - (c.before?.lamports ?? 0n);
            if (lamports !== 0n) out.push(`${amount(lamports, SOL_DECIMALS)} SOL ${lamports < 0n ? 'from' : 'to'} ${who(a)}`);
        }
        if (c.before && c.after && c.before.program !== c.after.program) out.push(`${cap(who(a))} now belongs to ${PROGRAM_NAMES.get(c.after.program) ?? c.after.program}`);
        if (c.before && !c.after) out.push(`${cap(who(a))} is closed`);
        return out;
    };
    const price = unitPrice(r.message);
    return {
        wallet,
        who,
        mine: (a) => mine.has(a),
        existed: (a) => loaded.get(a)?.exists === true,
        mintOf: (a) => tokenOf(a)?.mint ?? null,
        token,
        program: (a) => PROGRAM_NAMES.get(a) ?? a,
        priorityFee: price === null ? null : lamportsFor(price, unitLimit(r.message) ?? defaultUnits(r.message)),
        payer: r.signers[0],
        changes: changesOf,
        icon: (mint) => {
            const t = known.tokens.get(mint);
            return t?.verified ? t.icon : null; // an unverified token's image could be its maker's tracker
        },
        holds: (a) => (changed.get(a)?.before?.token ?? asLoaded(a)?.token)?.amount ?? null,
    };
}
