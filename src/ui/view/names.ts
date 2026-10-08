// How the transaction's accounts and tokens read in the window: names for addresses, symbols and decimals for mints,
// and what happened to each account, in words.
import { SYSTEM_PROGRAM_ADDRESS } from '@solana-program/system';
import type { Address } from '@solana/kit';

import { amount, cap, quantity, short, SOL_DECIMALS } from '../../format.ts';
import { STAKE_PROGRAM, USDC, USDT, WSOL } from '../../programs/addresses.ts';
import { PROGRAM_NAMES } from '../../programs/known.ts';
import { SYSVARS } from '../../review/assess.ts';
import { defaultUnits, lamportsFor, unitLimit, unitPrice } from '../../review/budget.ts';
import { read } from '../../review/changes.ts';
import type { Names } from '../../review/effects.ts';
import type { Review } from '../../review/review.ts';
import type { Known } from '../view.ts';

const SYMBOLS: Record<string, string> = { [USDC]: 'USDC', [USDT]: 'USDT' };

// How the transaction's accounts and tokens read: names for addresses, symbols and decimals for mints. A symbol only
// for a verified token: anyone can call a token "USDC", so any other goes by its address.
/** How a line marks an address as yours, for the window to tag: "FioY…KWv1 (you)". */
export const YOU = ' (you)';

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
        const symbol = mint === WSOL ? 'wSOL' : verified ? t?.symbol || SYMBOLS[mint] || short(mint) : short(mint);
        const places = known.decimals.get(mint) ?? t?.decimals ?? null;
        return { symbol, decimals: places !== null && Number.isInteger(places) && places >= 0 && places <= 255 ? places : null, verified };
    };
    const who = (a: Address): string => {
        if (a === wallet) return tagged ? `${short(wallet)}${YOU}` : 'you';
        const t = tokenOf(a);
        if (mine.has(a)) {
            if (t) return `your ${t.native ? 'wrapped SOL' : token(t.mint).symbol} account`;
            const s = stateOf(a);
            return `your ${s?.program === STAKE_PROGRAM ? 'stake account' : s?.program === SYSTEM_PROGRAM_ADDRESS && s.space === 80 ? 'nonce account' : 'account'} ${short(a)}`;
        }
        return PROGRAM_NAMES.get(a) ?? (SYSVARS.has(a) ? 'a sysvar' : short(a));
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
            if (from && to && from.owner !== to.owner) out.push(`${cap(who(a))} now belongs to ${short(to.owner)}`);
            if (to?.delegate && to.delegate !== from?.delegate) out.push(`${short(to.delegate)} may move the tokens in ${who(a)}`);
        } else {
            const lamports = (c.after?.lamports ?? 0n) - (c.before?.lamports ?? 0n);
            if (lamports !== 0n) out.push(`${amount(lamports, SOL_DECIMALS)} SOL ${lamports < 0n ? 'from' : 'to'} ${who(a)}`);
        }
        if (c.before && c.after && c.before.program !== c.after.program) out.push(`${cap(who(a))} now belongs to ${PROGRAM_NAMES.get(c.after.program) ?? short(c.after.program)}`);
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
        program: (a) => PROGRAM_NAMES.get(a) ?? short(a),
        priorityFee: price === null ? null : lamportsFor(price, unitLimit(r.message) ?? defaultUnits(r.message)),
        payer: r.signers[0],
        changes: changesOf,
        icon: (mint) => {
            const t = known.tokens.get(mint);
            return t?.verified ? t.icon : null; // an unverified token's image could be its maker's tracker
        },
    };
}
