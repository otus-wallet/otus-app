// A transfer the wallet makes on its own, built for the same review as any site's: SOL, or a token sent to the
// recipient's associated account (opened when it is not there yet), or to a token account given directly. A v1 message,
// the newest format: its limits are in the message itself, the most there is for its review to simulate it, and
// Otus fits them to what it uses when it prepares it. A v0 one for a Ledger, whose Solana app cannot read v1: Otus
// sets its limits in Compute Budget instructions then.
import { MAX_COMPUTE_UNIT_LIMIT } from '@solana-program/compute-budget';
import { getTransferSolInstruction } from '@solana-program/system';
import { findAssociatedTokenPda, getCreateAssociatedTokenIdempotentInstruction, getTransferCheckedInstruction } from '@solana-program/token';
import {
    appendTransactionMessageInstructions,
    compileTransaction,
    createNoopSigner,
    createTransactionMessage,
    getTransactionEncoder,
    pipe,
    setTransactionMessageFeePayer,
    setTransactionMessageConfig,
    setTransactionMessageLifetimeUsingBlockhash,
    type Address,
    type Blockhash,
    type ReadonlyUint8Array,
} from '@solana/kit';

import { MAX_ROOM } from '../review/budget.ts';

/** What is sent: SOL, or a token from one of your token accounts. */
export type Asset = { kind: 'sol' } | { kind: 'token'; mint: Address; program: Address; source: Address; decimals: number };

/** Where it goes: a wallet (its associated account for a token), or a token account of the same mint. */
export type Recipient = { kind: 'wallet'; address: Address } | { kind: 'token-account'; address: Address };

export type Lifetime = { blockhash: Blockhash; lastValidBlockHeight: bigint };

/** The unsigned transaction, as wire bytes. */
export async function transfer(from: Address, to: Recipient, asset: Asset, units: bigint, lifetime: Lifetime, version: 0 | 1 = 1): Promise<Uint8Array> {
    const me = createNoopSigner(from);
    let instructions;
    if (asset.kind === 'sol') {
        instructions = [getTransferSolInstruction({ source: me, destination: to.address, amount: units })];
    } else if (to.kind === 'token-account') {
        instructions = [getTransferCheckedInstruction({ source: asset.source, mint: asset.mint, destination: to.address, authority: me, amount: units, decimals: asset.decimals }, { programAddress: asset.program })];
    } else {
        const [ata] = await findAssociatedTokenPda({ owner: to.address, mint: asset.mint, tokenProgram: asset.program });
        instructions = [
            getCreateAssociatedTokenIdempotentInstruction({ payer: me, ata, owner: to.address, mint: asset.mint, tokenProgram: asset.program }),
            getTransferCheckedInstruction({ source: asset.source, mint: asset.mint, destination: ata, authority: me, amount: units, decimals: asset.decimals }, { programAddress: asset.program }),
        ];
    }
    if (version === 0) {
        const message = pipe(
            createTransactionMessage({ version: 0 }),
            (m) => setTransactionMessageFeePayer(from, m),
            (m) => setTransactionMessageLifetimeUsingBlockhash(lifetime, m),
            (m) => appendTransactionMessageInstructions(instructions, m),
        );
        return new Uint8Array(getTransactionEncoder().encode(compileTransaction(message)));
    }
    const message = pipe(
        createTransactionMessage({ version: 1 }),
        (m) => setTransactionMessageFeePayer(from, m),
        (m) => setTransactionMessageLifetimeUsingBlockhash(lifetime, m),
        (m) => appendTransactionMessageInstructions(instructions, m),
        (m) => setTransactionMessageConfig({ computeUnitLimit: MAX_COMPUTE_UNIT_LIMIT, loadedAccountsDataSizeLimit: MAX_ROOM }, m),
    );
    return new Uint8Array(getTransactionEncoder().encode(compileTransaction(message)));
}

// A Token-2022 mint with extensions: the base mint, padding to 165 bytes, its account type (1), then each extension as
// type (u16), length (u16) and value.
const EXTENSIONS = 166;
const TRANSFER_FEE = 1; // value: two authorities, what it withheld, then the older and the newer fee: epoch, most, basis points
const NON_TRANSFERABLE = 9;
const TRANSFER_HOOK = 14; // value: its authority, then the program it runs (zeros: none)

// A Token-2022 mint's extensions, each as its type and value.
function* extensions(mint: ReadonlyUint8Array): Generator<[number, ReadonlyUint8Array]> {
    if (mint.length <= EXTENSIONS || mint[EXTENSIONS - 1] !== 1) return;
    const view = new DataView(mint.buffer, mint.byteOffset, mint.byteLength);
    for (let at = EXTENSIONS; at + 4 <= mint.length; ) {
        const [type, length] = [view.getUint16(at, true), view.getUint16(at + 2, true)];
        if (type === 0) return; // the rest is unused
        yield [type, mint.subarray(at + 4, at + 4 + length)];
        at += 4 + length;
    }
}

/** Why a Token-2022 mint's tokens can't go in a plain transfer, in words; null when they can. Otus sends plain
 *  transfers only: no program of the token's own runs in them. */
export function unplain(mint: ReadonlyUint8Array): string | null {
    for (const [type, value] of extensions(mint)) {
        if (type === NON_TRANSFERABLE) return 'This token cannot be transferred';
        if (type === TRANSFER_HOOK && value.subarray(32, 64).some((b) => b !== 0)) return 'This token runs a program of its own on every transfer: Otus sends plain transfers only';
    }
    return null;
}

/** What a Token-2022 mint's transfer fee keeps of this many units, at most: the larger of its fee now and the one it
 *  set for later, each its basis points rounded up, up to its most. The recipient gets the rest. */
export function feeOn(mint: ReadonlyUint8Array, units: bigint): bigint {
    let kept = 0n;
    for (const [type, value] of extensions(mint)) {
        if (type !== TRANSFER_FEE || value.length < 108) continue;
        const view = new DataView(value.buffer, value.byteOffset, value.byteLength);
        for (const at of [72, 90]) {
            const [most, bps] = [view.getBigUint64(at + 8, true), BigInt(view.getUint16(at + 16, true))];
            const fee = (units * bps + 9_999n) / 10_000n;
            const capped = fee < most ? fee : most;
            if (capped > kept) kept = capped;
        }
    }
    return kept;
}

/** A decimal as typed → base units; null when it is not a positive number with at most `decimals` places. A point
 *  marks decimals; a comma is refused, as it means a decimal in some places and thousands in others. */
export function units(text: string, decimals: number): bigint | null {
    const t = text.trim();
    const m = /^(\d*)(?:\.(\d*))?$/.exec(t);
    if (!t || !m || (m[1] === '' && !m[2]) || (m[2]?.length ?? 0) > decimals) return null;
    const value = BigInt(m[1] || '0') * 10n ** BigInt(decimals) + BigInt((m[2] ?? '').padEnd(decimals, '0') || '0');
    return value > 0n ? value : null;
}
