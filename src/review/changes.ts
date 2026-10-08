import { SYSTEM_PROGRAM_ADDRESS } from '@solana-program/system';
import { TOKEN_PROGRAM_ADDRESS } from '@solana-program/token';
import { getAddressDecoder, getU32Decoder, getU64Decoder, type Address, type MaybeEncodedAccount, type ReadonlyUint8Array } from '@solana/kit';

import { TOKEN_2022_PROGRAM_ADDRESS, TOKEN_PROGRAMS } from '../programs/addresses.ts';
import { fee } from './budget.ts';
import type { Simulated } from './simulate.ts';

/** An SPL token account's fields. Amounts in base units. `native`: wrapped SOL, whose amount is the account's own lamports. */
export type Token = { mint: Address; owner: Address; amount: bigint; delegate: Address | null; delegated: bigint; closer: Address | null; native: boolean };

/** An account as the review reads it; null when there is none. */
export type State = { lamports: bigint; program: Address; space: number; data: ReadonlyUint8Array; token: Token | null } | null;

/** One account the transaction can write, before and after it. */
export type Change = { address: Address; before: State; after: State };

/** What the transaction does: the fee its payer pays, and every account it can write. */
export type Changes = { fee: bigint; accounts: Change[] };

/** Simulated → Changes. Before is what resolve read, after what the simulation left. A failed transaction changes nothing but the fee. */
export function changes(s: Simulated): Changes {
    const failed = s.simulation.error !== null;
    return {
        fee: s.simulation.fee ?? fee(s.message),
        accounts: s.accounts
            .filter((a) => a.writable)
            .map((a, i) => {
                const before = read(a.state);
                return { address: a.address, before, after: failed ? before : read(s.simulation.after[i]) };
            }),
    };
}

/** An account's lamports, owning program and data and, for an SPL token account, its fields. No lamports: no account, as the runtime purges it. */
export function read(a: MaybeEncodedAccount): State {
    if (!a.exists || a.lamports === 0n) return null;
    return { lamports: a.lamports, program: a.programAddress, space: a.data.length, data: a.data, token: token(a.programAddress, a.data) };
}

/** Where a key sits in an account's data, at any offset. */
export function offsetsOf(key: ReadonlyUint8Array, state: State): number[] {
    const d = state?.data;
    if (!d) return [];
    const found: number[] = [];
    for (let i = d.indexOf(key[0]); i >= 0 && i + 32 <= d.length; i = d.indexOf(key[0], i + 1)) {
        if (key.every((b, j) => d[i + j] === b)) found.push(i);
    }
    return found;
}

/** Your holdings before and after, by asset: 'SOL' across all your accounts, the fee given back, and each token by mint.
 *  Wrapped SOL counts once, as the SOL its account holds: wrapping your own SOL gains you nothing. */
export function holdings(yours: Changes): Map<string, [bigint, bigint]> {
    const out = new Map<string, [bigint, bigint]>([['SOL', [0n, yours.fee]]]);
    const add = (asset: string, before: bigint, after: bigint) => {
        const [b, a] = out.get(asset) ?? [0n, 0n];
        out.set(asset, [b + before, a + after]);
    };
    for (const { before, after } of yours.accounts) {
        add('SOL', before?.lamports ?? 0n, after?.lamports ?? 0n);
        for (const mint of new Set([before?.token, after?.token].flatMap((t) => (t && !t.native ? [t.mint] : [])))) add(mint, units(before, mint), units(after, mint));
    }
    return out;
}

/** The units of this mint an account holds as a token account; 0 for any other account, and for wrapped SOL. */
export const units = (s: State, mint: string) => (s?.token?.mint === mint && !s.token.native ? s.token.amount : 0n);

/** A plain wallet: owned by the System Program, holding no data. */
export const plain = (s: State) => s !== null && s.program === SYSTEM_PROGRAM_ADDRESS && s.space === 0;


// A token account is 165 bytes: mint, owner, amount, delegate (COption), state, is_native (COption, at 109), delegated
// amount, close authority (COption). Token-2022 may add extensions after a type byte at 165 (2: account, 1: mint); at 355 bytes it is
// a multisig. State 0 means not initialized yet.
function token(program: Address, d: ReadonlyUint8Array): Token | null {
    const extended = program === TOKEN_2022_PROGRAM_ADDRESS && d.length > 165 && d.length !== 355 && d[165] === 2;
    if (!TOKEN_PROGRAMS.includes(program) || !(d.length === 165 || extended) || d[108] === 0) return null;
    const at = (offset: number) => getAddressDecoder().decode(d, offset);
    const option = (offset: number) => (getU32Decoder().decode(d, offset) === 1 ? at(offset + 4) : null);
    const u64 = (offset: number) => getU64Decoder().decode(d, offset);
    return { mint: at(0), owner: at(32), amount: u64(64), delegate: option(72), delegated: u64(121), closer: option(129), native: getU32Decoder().decode(d, 109) === 1 };
}
