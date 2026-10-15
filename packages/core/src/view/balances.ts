// Your balances as the window lists them: each asset of yours that moves, what it comes to, and under it each thing
// that moves it, saying where it goes or comes from.
import { isOffCurveAddress, type Address } from '@solana/kit';

import { amount, cap, quantity, SOL_DECIMALS } from '@otus-wallet/sdk/format';
import { LIGHTHOUSE, STAKE_PROGRAM, TOKEN_PROGRAMS, USDC, USDT, WSOL } from '@otus-wallet/sdk/programs/addresses';
import { CORE_PROGRAMS } from '@otus-wallet/sdk/programs/core';
import { PROGRAM_NAMES } from '@otus-wallet/sdk/programs/known';
import { HIGH_FEE, type Tone, type Verdict } from '@otus-wallet/sdk/review/assess';
import { plain, units as unitsIn, type Change } from '@otus-wallet/sdk/review/changes';
import type { Names } from '@otus-wallet/sdk/review/effects';
import type { Review } from '@otus-wallet/sdk/review/review';
import type { Prepared } from '@otus-wallet/sdk/prepare/prepare';
import type { AssetChange, Logo } from '../view.ts';

const LOGOS: Record<string, Logo> = { [WSOL]: 'sol', [USDC]: 'usdc', [USDT]: 'usdt' };

// One thing that moves an asset of yours, before the asset's lines are put together. `key`: the asset, SOL by name.
type Moved = { key: string; asset: string; logo: Logo; icon: string | null; verified: boolean; note: string; units: bigint; places: number | null; tone?: Tone };

// Your balances: your wallet's SOL, with the network fee and the rent of the token accounts it opens or closes on lines
// of their own; each token account of yours; your stake accounts' SOL, as staked SOL; your other accounts. Each line says where its asset goes or comes from,
// by its own direction: a wallet that is not yours first, as that is where a drainer sends, then program accounts by
// the program the transaction gives them to, then your own. A trade out to a program reads "Via". The lines are then
// put under their asset, which says what they come to.
export const balances = (r: Review, p: Prepared | null, wallet: Address, n: Names, verdict: Verdict): AssetChange[] => grouped(moves(r, p, wallet, n), verdict);

/** Your balances across transactions signed together: what each asset comes to with all of them, and under it each
 *  line of each, by its number. */
export function batchBalances(items: { r: Review; p: Prepared | null; n: Names }[], wallet: Address, verdict: Verdict): AssetChange[] {
    return grouped(
        items.flatMap(({ r, p, n }, i) => moves(r, p, wallet, n).map((m) => ({ ...m, note: m.note ? `${i + 1} · ${m.note}` : `${i + 1}` }))),
        verdict,
    );
}

// The lines of one transaction, before they are put under their assets.
function moves(r: Review, p: Prepared | null, wallet: Address, n: Names): Moved[] {
    const moved: Moved[] = [];
    const all = r.changes.accounts;
    const yours = r.assessment.yours.accounts;
    const lamports = (c: Change) => (c.after?.lamports ?? 0n) - (c.before?.lamports ?? 0n);
    const trade = r.assessment.flows.some((f) => f.change < 0n) && r.assessment.flows.some((f) => f.change > 0n);
    const closes = closings(r);
    const handled = new Set<Address>(); // accounts whose SOL a rent row already tells
    const programOf = firstPrograms(r);

    const party = (c: Change, moved: bigint, inSol: boolean) => {
        const state = c.after ?? c.before;
        const holder = state?.token?.owner ?? c.address;
        const size = moved < 0n ? -moved : moved;
        // An account of yours whose part no longer is when it ends: whoever controls it then.
        const left = r.assessment.leaves.get(c.address)?.[inSol ? 'sol' : 'tokens'];
        if (left !== undefined) return { rank: 0, size, text: left === null ? 'an account no one owns' : n.who(left), via: null, opened: false };
        if (n.mine(c.address)) return { rank: 2, size, text: n.who(c.address), via: null, opened: false };
        if (state?.token ? !isOffCurveAddress(holder) : plain(state)) return { rank: 0, size, text: n.who(holder), via: null, opened: inSol && !!state?.token && !c.before };
        const via = programOf.get(c.address) ?? (holder !== c.address ? (programOf.get(holder) ?? null) : null);
        return { rank: 1, size, text: via ?? `${n.who(holder)} (program)`, via, opened: false };
    };
    // Where what moves in this account goes, or comes from: the accounts where the same asset moved the other way.
    const toward = (asset: 'SOL' | Address, from: Address, delta: bigint): string | null => {
        const inSol = asset === 'SOL';
        const moved = (c: Change) => (inSol ? lamports(c) : unitsIn(c.after, asset) - unitsIn(c.before, asset));
        const others = all
            .filter((c) => c.address !== from && !(inSol && handled.has(c.address)) && moved(c) !== 0n && moved(c) > 0n !== delta > 0n)
            .map((c) => party(c, moved(c), inSol))
            .toSorted((a, b) => a.rank - b.rank || (b.size > a.size ? 1 : b.size < a.size ? -1 : 0));
        if (!others.length) return null;
        const [first, ...more] = others;
        const text = first.opened ? 'Rent for new account' : first.via && trade && delta < 0n ? `Via ${first.via}` : `${delta < 0n ? 'To' : 'From'} ${first.text}`;
        return more.length ? `${text} +${more.length}` : text;
    };
    // A part of an account of yours that is no longer yours when it ends: who controls it then, as the SDK reads it.
    const leaving = (address: Address, part: 'sol' | 'tokens'): string | null => {
        const left = r.assessment.leaves.get(address);
        if (!left || left[part] === undefined) return null;
        const holder = left[part];
        return holder === null ? 'Anyone can take it' : `To ${n.who(holder)}`;
    };
    const row = (key: string, asset: string, logo: Logo, note: string, units: bigint, places: number | null, verified: boolean, icon: string | null = null) =>
        units !== 0n && moved.push({ key, asset, logo, icon, verified, note, units, places });
    const solRow = (note: string, units: bigint) => row('SOL', 'SOL', 'sol', note, units, SOL_DECIMALS, true);

    // Rent your wallet puts in token accounts of yours it opens, or gets back from those it closes to itself. A failed
    // transaction changes nothing but the fee, which has a row of its own.
    const walletChange = yours.find((c) => c.address === wallet);
    let rest = walletChange && r.simulation.error === null ? lamports(walletChange) + r.assessment.yours.fee : 0n;
    const rents: [string, bigint][] = [];
    for (const c of yours) {
        const t = c.after?.token ?? c.before?.token;
        const moved = lamports(c);
        if (c.address === wallet || !t || t.native || moved === 0n) continue;
        if (!c.before && moved > 0n && rest <= -moved) rents.push(['Rent for new account', -moved]);
        else if (!c.after && moved < 0n && closes.get(c.address) === wallet) rents.push(['Rent back', -moved]);
        else continue;
        rest += moved;
        handled.add(c.address);
    }
    solRow(leaving(wallet, 'sol') ?? toward('SOL', wallet, rest) ?? 'Your wallet', rest);

    for (const c of yours) {
        if (c.address === wallet) continue;
        const t = c.after?.token ?? c.before?.token;
        const moved = lamports(c);
        if (!t) {
            // SOL moving in an account of yours other than the wallet: which one is said too. In a stake account it is
            // staked SOL, an asset apart from the wallet's, so staking shows what it moves without opening the lines.
            const where = leaving(c.address, 'sol') ?? toward('SOL', c.address, moved);
            const note = [where, cap(n.who(c.address))].filter(Boolean).join(' · ');
            // Staked SOL says itself what it is: no note. Where it goes shows on the SOL lines.
            if ((c.after ?? c.before)?.program === STAKE_PROGRAM) row('staked', 'Staked SOL', 'sol', '', moved, SOL_DECIMALS, true);
            else solRow(note, moved);
            continue;
        }
        if (t.native) {
            // Wrapped SOL: what moves is its account's SOL, and it is named as what it is, wSOL.
            const where = leaving(c.address, 'sol') ?? toward('SOL', c.address, moved);
            row('wSOL', 'wSOL', 'sol', where === 'From you' ? 'Wrapped from wallet' : (where ?? 'Wrapped SOL'), moved, SOL_DECIMALS, true);
            continue;
        }
        const { symbol, decimals, verified } = n.token(t.mint);
        const units = unitsIn(c.after, t.mint) - unitsIn(c.before, t.mint);
        const hold = p?.holds.find((h) => h.kind === 'token' && h.account === c.address);
        const floor = hold?.kind === 'token' ? hold.atLeast - (c.before?.token?.amount ?? 0n) : 0n;
        const held = units > 0n && floor > 0n && decimals !== null ? amount(floor, decimals, false) : null;
        row(t.mint, symbol, verified ? (LOGOS[t.mint] ?? 'chain') : 'chain', tokenNote(c, held, verified, leaving(c.address, 'tokens') ?? toward(t.mint, c.address, units)), units, decimals, verified, verified && !LOGOS[t.mint] ? (n.icon?.(t.mint) ?? null) : null);
        if (!handled.has(c.address)) solRow(rentNote(c, leaving(c.address, 'sol') ?? toward('SOL', c.address, moved)), moved);
    }
    for (const [note, units] of rents) solRow(note, units);
    // The fee once prepared: Otus sets its priority part. Not guessed before.
    if (p && r.signers[0] === wallet && p.fee > 0n) moved.push({ key: 'SOL', asset: 'SOL', logo: 'sol', icon: null, verified: true, note: p.fee > HIGH_FEE ? 'High network fee' : 'Network fee', units: -p.fee, places: SOL_DECIMALS, tone: p.fee > HIGH_FEE ? 'warn' : 'plain' });
    return moved;
}

// Each asset's lines under it, in the order the assets first move: what they come to, and each line as it is.
function grouped(moved: Moved[], verdict: Verdict): AssetChange[] {
    const tone = (units: bigint): Tone => (units > 0n ? 'ok' : units < 0n && verdict === 'danger' ? 'danger' : 'plain');
    const assets = new Map<string, Moved[]>();
    for (const m of moved) assets.set(m.key, [...(assets.get(m.key) ?? []), m]);
    return [...assets.values()].map((lines) => {
        const [{ asset, logo, icon, verified, places }] = lines;
        const net = lines.reduce((sum, l) => sum + l.units, 0n);
        return { asset, logo, icon, verified, amount: quantity(net, places), tone: tone(net), lines: lines.map((l) => ({ note: l.note, amount: quantity(l.units, l.places), tone: l.tone ?? tone(l.units) })) };
    });
}

// A token row's note: how much of what comes in is guaranteed, or where it goes or comes from, or what the account is.
function tokenNote(c: Change, held: string | null, verified: boolean, where: string | null): string {
    if (held) return verified ? `≥ ${held} guaranteed` : `Unverified · ≥ ${held}`;
    if (where) return where;
    if (!c.before) return 'New account';
    if (!c.after) return 'Closed account';
    return 'Your account';
}

// The note of the SOL in a token account of yours: its rent when opened or closed, else where that SOL goes.
function rentNote(c: Change, where: string | null): string {
    if (!c.before) return 'Rent for new account';
    if (!c.after) return 'Closed account rent';
    return where ?? 'Token account SOL';
}

// For each account, the name of the first program the transaction gives it to, beyond Solana's own and the guards.
function firstPrograms(r: Review): Map<Address, string | null> {
    const first = new Map<Address, string | null>();
    for (const ix of r.message.instructions) {
        const program = r.accounts[ix.programAddressIndex].address;
        if (CORE_PROGRAMS.has(program) || program === LIGHTHOUSE) continue;
        for (const j of ix.accountIndices) if (!first.has(r.accounts[j].address)) first.set(r.accounts[j].address, PROGRAM_NAMES.get(program) ?? null);
    }
    return first;
}

// Token accounts the transaction closes, and where each one's SOL goes: from the instructions Otus reads, and from
// the calls inside others, as the simulation parsed them.
function closings(r: Review): Map<Address, Address> {
    const closes = new Map<Address, Address>();
    for (const e of r.explained) {
        const at = (role: string) => e.accounts.find((a) => a.role === role)?.address;
        const [account, destination] = [at('account'), at('destination')];
        if (TOKEN_PROGRAMS.includes(e.program) && e.name === 'CloseAccount' && account && destination) closes.set(account, destination);
    }
    for (const group of r.simulation.inner) for (const call of group.calls) if (call.closes) closes.set(...call.closes);
    return closes;
}
