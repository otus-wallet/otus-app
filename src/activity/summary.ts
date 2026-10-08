// What one landed transaction did for a wallet, read from the transaction alone: no account, table or name is asked
// for. What the wallet gained and lost comes from the balances the transaction itself lists, before and after, so it
// is what happened, not a guess; the fee and the rent of token accounts it opened or closed are set apart. Its kind
// (a send, a receipt, a swap), the other side, the programs, Squads steps and a memo come from its own instructions.
import { LEGACY_MEMO_PROGRAM_ADDRESS_V1, LEGACY_MEMO_PROGRAM_ADDRESS_V3, MEMO_PROGRAM_ADDRESS } from '@solana-program/memo';
import { isOffCurveAddress, type Address } from '@solana/kit';

import { told } from '../format.ts';
import { LIGHTHOUSE, WSOL } from '../programs/addresses.ts';
import { CORE_PROGRAMS } from '../programs/core.ts';
import { readCall, SQUADS_V4, type Step } from '../programs/squads.ts';
import type { Landed } from './history.ts';

/** A change in one of the wallet's balances: SOL (mint null) or a token, in its base units, gained (+) or lost (−). */
export type Move = { mint: Address | null; units: bigint; decimals: number };

export type Kind = 'send' | 'receive' | 'swap' | 'other';

/** A transaction for the wallet, in short. `moves`: SOL first, then each token; SOL without the fee the wallet paid
 *  and the rent of token accounts. `rent.yours`: the rent its own token accounts gained (+, opened) or lost (−,
 *  closed); `rent.theirs`: what it put in others' token accounts it opened for them. `signed`: whether the wallet
 *  signed it, or is a program's address (a Squads vault), which never signs: its program moves it; what left a wallet
 *  that did not, a delegate of its tokens moved. `other`: who got what a send sent, or sent what a
 *  receipt got. `main`: its first program that is not one of Solana's own. */
export type Activity = {
    signature: string;
    time: number | null;
    error: string | null;
    kind: Kind;
    moves: Move[];
    fee: bigint;
    payer: Address;
    rent: { yours: bigint; theirs: bigint };
    signed: boolean;
    other: Address | null;
    programs: Address[];
    main: Address | null;
    squads: Step[];
    memo: string | null;
};

const MEMOS: readonly Address[] = [MEMO_PROGRAM_ADDRESS, LEGACY_MEMO_PROGRAM_ADDRESS_V1, LEGACY_MEMO_PROGRAM_ADDRESS_V3];

/** A landed transaction → what it did for `wallet`. Pure. */
export function summarize(t: Landed, wallet: Address): Activity {
    const { accounts, lamports, tokens } = t;
    const payer = accounts[0];
    const change = (i: number) => lamports.after[i] - lamports.before[i] + (i === 0 ? t.fee : 0n); // as if no fee
    const yours = (owner: Address | null) => owner === wallet;
    const listed = (side: 'before' | 'after', i: number) => tokens[side].filter((b) => b.account === i);
    // The wallet's SOL counts the rent in its own token accounts as still its own: rent put in one it opens is not
    // spent, rent back from one it closes is not received, rent that one sends elsewhere is. Wrapped SOL in them is a
    // token, apart from their rent.
    const rentIn = (side: 'before' | 'after', i: number) => lamports[side][i] - listed(side, i).reduce((n, b) => n + (b.mint === WSOL ? b.units : 0n), 0n);
    const own = [...new Set([...tokens.before, ...tokens.after].filter((b) => yours(b.owner)).map((b) => b.account))];
    const rent = own.reduce((n, i) => n + rentIn('after', i) - rentIn('before', i), 0n);
    const at = accounts.indexOf(wallet);
    const spent = at < 0 ? 0n : change(at);
    // Rent others put in a token account of the wallet's is no SOL of its own: only what the wallet paid counts.
    let sol = spent + (rent > 0n ? min(rent, spent < 0n ? -spent : 0n) : rent);
    // What it paid to open others' token accounts is rent of theirs, not SOL sent: up to what the wallet lost.
    const given = accounts.reduce((n, _, i) => {
        const [before, after] = [listed('before', i), listed('after', i)];
        return lamports.before[i] === 0n && after.length && !before.length && !after.every((b) => yours(b.owner)) ? n + lamports.after[i] : n;
    }, 0n);
    const theirs = sol < 0n ? min(given, -sol) : 0n;
    sol += theirs;
    const moves: Move[] = [...(sol !== 0n ? [{ mint: null, units: sol, decimals: 9 }] : []), ...tokenMoves(t, (owner) => yours(owner))];
    const signed = isOffCurveAddress(wallet) || t.message.staticAccounts.slice(0, t.message.header.numSignerAccounts).includes(wallet);
    const gains = moves.some((m) => m.units > 0n);
    const losses = moves.some((m) => m.units < 0n);
    const kind: Kind = gains && losses ? 'swap' : losses ? 'send' : gains ? 'receive' : 'other';
    const programs = [...new Set(t.message.instructions.map((ix) => accounts[ix.programAddressIndex]))];
    return {
        signature: t.signature,
        time: t.time,
        error: t.error,
        kind,
        moves,
        fee: t.fee,
        payer,
        rent: { yours: rent, theirs },
        signed,
        other: kind === 'send' || kind === 'receive' ? otherSide(t, wallet, moves, kind === 'send' ? 1n : -1n, change) : null,
        programs,
        main: programs.find((p) => !CORE_PROGRAMS.has(p) && p !== LIGHTHOUSE) ?? null,
        squads: [...new Set(squadsSteps(t))],
        memo: memo(t),
    };
}

const min = (a: bigint, b: bigint) => (a < b ? a : b);

// What an owner gained or lost of each token, by mint, as the token balances show: those it changed.
function tokenMoves(t: Landed, ownerIs: (owner: Address | null) => boolean): Move[] {
    const by = new Map<Address, Move>();
    for (const [side, sign] of [['before', -1n], ['after', 1n]] as const) {
        for (const b of t.tokens[side]) {
            if (!ownerIs(b.owner)) continue;
            const m = by.get(b.mint) ?? { mint: b.mint, units: 0n, decimals: b.decimals };
            by.set(b.mint, { ...m, units: m.units + sign * b.units });
        }
    }
    return [...by.values()].filter((m) => m.units !== 0n);
}

// The other side of a send (what it lost went to them: `sign` 1) or a receipt (−1): for the first token moved, the
// owner whose balance of it moved most the other way; for SOL alone, the account whose lamports did.
function otherSide(t: Landed, wallet: Address, moves: Move[], sign: bigint, change: (i: number) => bigint): Address | null {
    const token = moves.find((m) => m.mint !== null);
    let best: { who: Address; by: bigint } | null = null;
    const consider = (who: Address | null, by: bigint) => void (who && who !== wallet && by * sign > 0n && (!best || by * sign > best.by * sign) && (best = { who, by }));
    if (token) {
        const owners = new Set(t.tokens.after.concat(t.tokens.before).map((b) => b.owner));
        for (const owner of owners) consider(owner, tokenMoves(t, (o) => o === owner).find((m) => m.mint === token.mint)?.units ?? 0n);
    } else {
        t.accounts.forEach((a, i) => consider(a, change(i)));
    }
    return (best as { who: Address } | null)?.who ?? null;
}

function squadsSteps(t: Landed): Step[] {
    return t.message.instructions.flatMap((ix) => {
        if (t.accounts[ix.programAddressIndex] !== SQUADS_V4) return [];
        try {
            const call = readCall(ix.data, ix.accountIndices.map((i) => t.accounts[i]));
            return call ? [call.step] : [];
        } catch {
            return [];
        }
    });
}

// The first memo it carries, as text.
function memo(t: Landed): string | null {
    const ix = t.message.instructions.find((i) => MEMOS.includes(t.accounts[i.programAddressIndex]));
    if (!ix || !ix.data.length) return null;
    return told(new TextDecoder('utf-8', { fatal: false }).decode(new Uint8Array(ix.data)), 160) || null;
}
