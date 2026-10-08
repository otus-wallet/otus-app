import { SYSTEM_PROGRAM_ADDRESS } from '@solana-program/system';
import {
    getBase58Decoder,
    getCompiledTransactionMessageDecoder,
    getCompiledTransactionMessageEncoder,
    getTransactionDecoder,
    getTransactionEncoder,
    TRANSACTION_CONFIG_COMPUTE_UNIT_LIMIT_BIT_MASK,
    TRANSACTION_CONFIG_HEAP_SIZE_BIT_MASK,
    TRANSACTION_CONFIG_LOADED_ACCOUNTS_DATA_SIZE_LIMIT_BIT_MASK,
    TRANSACTION_CONFIG_PRIORITY_FEE_LAMPORTS_BIT_MASK,
    type Address,
    type CompiledTransactionMessage,
    type CompiledTransactionMessageWithLifetime,
    type ReadonlyUint8Array,
    type TransactionMessageBytes,
    type V1TransactionConfig,
} from '@solana/kit';

import { Refused } from '../protocol.ts';

/** One shape for every version. Legacy and v0 set fees with Compute Budget instructions, v1 in `config`. */
export type Message = {
    version: 'legacy' | 0 | 1;
    header: CompiledTransactionMessage['header'];
    staticAccounts: Address[];
    lookups: { lookupTableAddress: Address; writableIndexes: readonly number[]; readonlyIndexes: readonly number[] }[];
    lifetimeToken: string;
    instructions: { programAddressIndex: number; accountIndices: readonly number[]; data: ReadonlyUint8Array }[];
    config: V1TransactionConfig;
};

/** A transaction as the site sent it, decoded and checked like the runtime checks it. */
export type Decoded = {
    bytes: Uint8Array; // the wire transaction as the site sent it
    hash: string; // base58 SHA-256 of the message: the hash Ledger and Otus show
    messageBytes: Uint8Array;
    message: Message;
    signers: Address[]; // required signers in order; the first pays the fee
    signed: Address[]; // signers whose signature the site already filled in
};

const SIZE_LIMIT = { legacy: 1232, v1: 4096 };

/** Wire transaction → Decoded. Throws Refused. */
export async function decode(bytes: Uint8Array): Promise<Decoded> {
    const { tx, compiled } = parse(bytes);
    const limit = compiled.version === 1 ? SIZE_LIMIT.v1 : SIZE_LIMIT.legacy;
    if (bytes.length > limit) throw new Refused(`transaction over ${limit} bytes`);
    const message = normalize(compiled);
    sanitize(message);
    const messageBytes = new Uint8Array(tx.messageBytes);
    const signers = message.staticAccounts.slice(0, message.header.numSignerAccounts);
    const digest = await crypto.subtle.digest('SHA-256', messageBytes);
    return {
        bytes: bytes.slice(),
        hash: getBase58Decoder().decode(new Uint8Array(digest)),
        messageBytes,
        message,
        signers,
        signed: signers.filter((a) => tx.signatures[a] != null),
    };
}

// Encoding the result again must give back the same bytes. That refuses trailing bytes,
// overlong lengths and an envelope that does not fit the message version.
function parse(bytes: Uint8Array) {
    try {
        const tx = getTransactionDecoder().decode(bytes);
        const compiled = getCompiledTransactionMessageDecoder().decode(tx.messageBytes);
        const canonical =
            same(getTransactionEncoder().encode(tx), bytes) &&
            same(getCompiledTransactionMessageEncoder().encode(compiled), tx.messageBytes);
        if (canonical) return { tx, compiled };
    } catch (cause) {
        throw new Refused('malformed transaction', { cause });
    }
    throw new Refused('malformed transaction: not in canonical form');
}

const same = (a: ReadonlyUint8Array, b: ReadonlyUint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);

function normalize(m: CompiledTransactionMessage & CompiledTransactionMessageWithLifetime): Message {
    const common = { version: m.version, header: m.header, staticAccounts: m.staticAccounts, lifetimeToken: m.lifetimeToken };
    if (m.version !== 1) {
        return {
            ...common,
            lookups: m.version === 0 ? (m.addressTableLookups ?? []) : [],
            instructions: m.instructions.map((ix) => ({
                programAddressIndex: ix.programAddressIndex,
                accountIndices: ix.accountIndices ?? [],
                data: ix.data ?? new Uint8Array(),
            })),
            config: {},
        };
    }
    return {
        ...common,
        lookups: [],
        instructions: m.instructionHeaders.map((h, i) => ({
            programAddressIndex: h.programAccountIndex,
            accountIndices: m.instructionPayloads[i].instructionAccountIndices,
            data: m.instructionPayloads[i].instructionData,
        })),
        config: v1Config(m.configMask, m.configValues),
    };
}

// v1 config values follow the mask bits in this order.
const V1_CONFIG: [keyof V1TransactionConfig, number][] = [
    ['priorityFeeLamports', TRANSACTION_CONFIG_PRIORITY_FEE_LAMPORTS_BIT_MASK],
    ['computeUnitLimit', TRANSACTION_CONFIG_COMPUTE_UNIT_LIMIT_BIT_MASK],
    ['loadedAccountsDataSizeLimit', TRANSACTION_CONFIG_LOADED_ACCOUNTS_DATA_SIZE_LIMIT_BIT_MASK],
    ['heapSize', TRANSACTION_CONFIG_HEAP_SIZE_BIT_MASK],
];
const KNOWN_CONFIG_BITS = V1_CONFIG.reduce((all, [, bits]) => all | bits, 0);

function v1Config(mask: number, values: readonly { value: number | bigint }[]): V1TransactionConfig {
    if ((mask & ~KNOWN_CONFIG_BITS) !== 0) throw new Refused('malformed transaction: unknown config bits');
    const config: Record<string, number | bigint> = {};
    let next = 0;
    for (const [name, bits] of V1_CONFIG) {
        if ((mask & bits) === bits) config[name] = values[next++].value;
    }
    return config as V1TransactionConfig;
}

/** Message → message bytes: the inverse of what decode reads. */
export function encode(m: Message): TransactionMessageBytes {
    const common = { header: m.header, staticAccounts: m.staticAccounts, lifetimeToken: m.lifetimeToken };
    const instructions = m.instructions.map((ix) => ({ ...ix, accountIndices: [...ix.accountIndices] }));
    const encoder = getCompiledTransactionMessageEncoder();
    if (m.version === 'legacy') return encoder.encode({ ...common, version: 'legacy', instructions }) as TransactionMessageBytes;
    if (m.version === 0) {
        const lookups = m.lookups.map((l) => ({ ...l, writableIndexes: [...l.writableIndexes], readonlyIndexes: [...l.readonlyIndexes] }));
        return encoder.encode({ ...common, version: 0, instructions, addressTableLookups: lookups }) as TransactionMessageBytes;
    }
    const present = V1_CONFIG.filter(([name]) => m.config[name] !== undefined);
    return encoder.encode({
        ...common,
        version: 1,
        numStaticAccounts: m.staticAccounts.length,
        numInstructions: m.instructions.length,
        instructionHeaders: instructions.map((ix) => ({
            programAccountIndex: ix.programAddressIndex,
            numInstructionAccounts: ix.accountIndices.length,
            numInstructionDataBytes: ix.data.length,
        })),
        instructionPayloads: instructions.map((ix) => ({ instructionAccountIndices: ix.accountIndices, instructionData: ix.data })),
        configMask: present.reduce((mask, [, bits]) => mask | bits, 0),
        configValues: present.map(([name]) => {
            const value = m.config[name]!;
            return typeof value === 'bigint' ? { kind: 'u64' as const, value } : { kind: 'u32' as const, value };
        }),
    }) as TransactionMessageBytes;
}

/** Durable: the first instruction is System AdvanceNonceAccount, as the runtime reads it, so the transaction never expires. */
export function durable(m: Message): boolean {
    const first = m.instructions[0];
    return first !== undefined && m.staticAccounts[first.programAddressIndex] === SYSTEM_PROGRAM_ADDRESS && [4, 0, 0, 0].every((b, i) => first.data[i] === b);
}

const KIB = 1024;

/** The runtime's sanitize rules (Agave; v1 as SIMD-0385 sets them). Throws Refused. */
export function sanitize(m: Message) {
    const h = m.header;
    const keys = m.staticAccounts;
    const v1 = m.version === 1;
    const heap = m.config.heapSize;
    const total = m.lookups.reduce((n, l) => n + l.writableIndexes.length + l.readonlyIndexes.length, keys.length);
    const rules: [boolean, string][] = [
        [h.numReadonlySignerAccounts < h.numSignerAccounts, 'no writable fee payer'],
        [h.numSignerAccounts + h.numReadonlyNonSignerAccounts <= keys.length, 'header overlaps'],
        [new Set(keys).size === keys.length, 'an account appears twice'],
        [m.lookups.every((l) => l.writableIndexes.length + l.readonlyIndexes.length > 0), 'empty lookup'],
        [total <= 256, 'over 256 accounts'],
        [!v1 || (h.numSignerAccounts <= 12 && keys.length <= 64), 'over 12 signers or 64 accounts'],
        [m.instructions.length <= 64, 'over 64 instructions'],
        [m.instructions.every((ix) => ix.accountIndices.length <= 255), 'over 255 accounts in an instruction'],
        [m.instructions.every((ix) => ix.programAddressIndex > 0 && ix.programAddressIndex < keys.length), 'bad program index'],
        [m.instructions.every((ix) => ix.accountIndices.every((i) => i < total)), 'bad account index'],
        [heap === undefined || (heap % KIB === 0 && heap >= 32 * KIB && heap <= 256 * KIB), 'bad heap size'],
    ];
    const broken = rules.find(([ok]) => !ok);
    if (broken) throw new Refused(`malformed transaction: ${broken[1]}`);
}
