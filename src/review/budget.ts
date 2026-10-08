import { COMPUTE_BUDGET_PROGRAM_ADDRESS, MAX_COMPUTE_UNIT_LIMIT } from '@solana-program/compute-budget';
import { address, getU32Decoder, getU64Decoder, type Address } from '@solana/kit';

import type { Message } from './decode.ts';

const LAMPORTS_PER_SIGNATURE = 5_000n;
const DEFAULT_UNITS = 200_000; // what each instruction gets when the message sets no limit
/** Bytes: the most account data a transaction may load. */
export const MAX_ROOM = 64 * 1024 * 1024;

// Compute Budget instructions, by discriminator and size. The runtime ignores bytes past the size.
export const SET_UNIT_LIMIT = { kind: 2, size: 5 }; // u32 units
export const SET_UNIT_PRICE = { kind: 3, size: 9 }; // u64 micro-lamports per unit
export const SET_LOADED_DATA = { kind: 4, size: 5 }; // u32 bytes of account data it may load

/** Where the message's Compute Budget instruction of this kind is; -1 when it has none. v1 keeps its budget in `config`. */
export function budgetIndex(m: Message, { kind, size }: typeof SET_UNIT_LIMIT): number {
    if (m.version === 1) return -1;
    return m.instructions.findIndex(
        (ix) => m.staticAccounts[ix.programAddressIndex] === COMPUTE_BUDGET_PROGRAM_ADDRESS && ix.data[0] === kind && ix.data.length >= size,
    );
}

/** The compute unit limit the message sets; null when it sets none. */
export function unitLimit(m: Message): number | null {
    if (m.version === 1) return m.config.computeUnitLimit ?? null;
    const i = budgetIndex(m, SET_UNIT_LIMIT);
    return i < 0 ? null : Math.min(MAX_COMPUTE_UNIT_LIMIT, getU32Decoder().decode(m.instructions[i].data, 1));
}

/** The account data the message may load, in bytes; null when it sets no limit: legacy and v0 may then load the most
 *  there is, v1 nothing. */
export function dataLimit(m: Message): number | null {
    if (m.version === 1) return m.config.loadedAccountsDataSizeLimit ?? null;
    const i = budgetIndex(m, SET_LOADED_DATA);
    return i < 0 ? null : getU32Decoder().decode(m.instructions[i].data, 1);
}

/** The limit the runtime gives a message that sets none: none at all for v1. */
export function defaultUnits(m: Message): number {
    if (m.version === 1) return 0;
    const counted = m.instructions.filter((ix) => m.staticAccounts[ix.programAddressIndex] !== COMPUTE_BUDGET_PROGRAM_ADDRESS);
    return Math.min(MAX_COMPUTE_UNIT_LIMIT, counted.length * DEFAULT_UNITS);
}

/** The compute unit price of a legacy or v0 message, in micro-lamports; null when it sets none. */
export function unitPrice(m: Message): bigint | null {
    const i = budgetIndex(m, SET_UNIT_PRICE);
    return i < 0 ? null : getU64Decoder().decode(m.instructions[i].data, 1);
}

/** Lamports for this many compute units at a price in micro-lamports, rounded up as the runtime does. */
export const lamportsFor = (price: bigint, units: number) => (price * BigInt(units) + 999_999n) / 1_000_000n;

/** The priority fee: v1 sets it as a total, legacy and v0 as a price per unit of the limit. */
export function priorityFee(m: Message): bigint {
    if (m.version === 1) return m.config.priorityFeeLamports ?? 0n;
    return lamportsFor(unitPrice(m) ?? 0n, unitLimit(m) ?? defaultUnits(m));
}

// Signature-verifying programs: the network charges for each signature they check, counted in their first byte.
const PRECOMPILES: Address[] = [
    address('Ed25519SigVerify111111111111111111111111111'),
    address('KeccakSecp256k11111111111111111111111111111'),
    address('Secp256r1SigVerify1111111111111111111111111'),
];

/** What the network charges for the message: 5,000 lamports a signature, its own and its precompiles', plus the priority fee. */
export function fee(m: Message): bigint {
    const checked = m.instructions.filter((ix) => PRECOMPILES.includes(m.staticAccounts[ix.programAddressIndex])).reduce((n, ix) => n + (ix.data[0] ?? 0), 0);
    return LAMPORTS_PER_SIGNATURE * BigInt(m.header.numSignerAccounts + checked) + priorityFee(m);
}
