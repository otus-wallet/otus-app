import {
    address,
    getBase58Encoder,
    getBase64Decoder,
    getBase64Encoder,
    isAddress,
    parseBase64RpcAccount,
    type Address,
    type Base64EncodedWireTransaction,
    type Blockhash,
    type MaybeEncodedAccount,
    type Signature,
    type TransactionError,
} from '@solana/kit';

import type { OtusRpc } from './rpc.ts';

/** What the network says a transaction would do, all read at one slot. */
export type Simulation = {
    error: TransactionError | null;
    logs: string[];
    fee: bigint | null;
    unitsConsumed: bigint | null;
    loaded: Address[] | null; // accounts it loaded from lookup tables, writable first; null when the RPC does not say
    loadedBytes?: number | null; // the account data it loaded, as the runtime counts it against a v1 limit; null when the RPC does not say
    after: MaybeEncodedAccount[]; // the watched accounts after the transaction; empty when it fails
    inner: { index: number; calls: { program: Address; type: string | null; depth?: number; closes?: [Address, Address] }[] }[]; // calls made inside each top-level instruction, in order; depth: 2 for one the instruction's program makes, 3 for one that one makes…; closes: a token account closed, and where its SOL goes
    innerListed: boolean; // whether the RPC listed the calls made inside, each with its program: without that, `inner` may miss some
};

/** Where a sent transaction stands; null while the network has not seen it. */
export type Status = { error: TransactionError | null; confirmed: boolean } | null;

/** What the wallet reads from the network and sends to it. */
export type Chain = {
    accounts(addresses: readonly Address[]): Promise<{ slot: bigint; accounts: MaybeEncodedAccount[] }>;
    simulate(transaction: Uint8Array, watch: readonly Address[], minContextSlot: bigint): Promise<Simulation>;
    fees(writable: readonly Address[]): Promise<bigint[]>; // what recent blocks took to write these accounts, micro-lamports per unit
    recommended(writable: readonly Address[]): Promise<bigint | null>; // the price per unit the RPC recommends to write them, Helius' alone; null without one
    send(transaction: Uint8Array, preflight: boolean): Promise<void>;
    status(signature: Signature): Promise<Status>;
    valid(blockhash: string, commitment?: 'processed' | 'confirmed'): Promise<boolean>; // whether a transaction with this blockhash can still land
    heads(addresses: readonly Address[], length: number): Promise<MaybeEncodedAccount[]>; // the first bytes of each account's data
    blockTime(slot: bigint): Promise<number | null>; // when a slot was made, in seconds since 1970; null when the node no longer knows
    age(blockhash: string): Promise<number | null>; // blocks made since this blockhash, as the RecentBlockhashes sysvar lists them; null when it no longer does
    blockRate(): Promise<number>; // blocks a second, about: slots a second in the network's recent samples
    latest(): Promise<string>; // a blockhash just made (confirmed), for a transaction Otus builds
};

// The last 150 blockhashes, newest first: a count (u64), then each one and its fee calculator (40 bytes).
const RECENT_BLOCKHASHES = address('SysvarRecentB1ockHashes11111111111111111111');

const BATCH = 100; // getMultipleAccounts takes at most 100 addresses

/** A Chain over a Solana JSON-RPC endpoint: `rpcChain(rpcAt(url))`. */
export function rpcChain(rpc: OtusRpc): Chain {
    const wire = (transaction: Uint8Array) => getBase64Decoder().decode(transaction) as Base64EncodedWireTransaction;
    return {
        async accounts(addresses) {
            let slot = 0n;
            const accounts: MaybeEncodedAccount[] = [];
            for (let i = 0; i < addresses.length; i += BATCH) {
                const batch = addresses.slice(i, i + BATCH);
                const { context, value } = await rpc
                    .getMultipleAccounts(batch, { encoding: 'base64', commitment: 'confirmed' })
                    .send();
                if (value.length !== batch.length) throw new Error('RPC answered for a different number of accounts');
                if (context.slot > slot) slot = context.slot;
                accounts.push(...value.map((a, j) => parseBase64RpcAccount(batch[j], a)));
            }
            return { slot, accounts };
        },

        async simulate(transaction, watch, minContextSlot) {
            const { value: v } = await rpc
                .simulateTransaction(wire(transaction), {
                    encoding: 'base64',
                    sigVerify: false,
                    replaceRecentBlockhash: true,
                    innerInstructions: true,
                    commitment: 'confirmed',
                    minContextSlot,
                    accounts: { addresses: watch, encoding: 'base64' },
                })
                .send();
            if (!('err' in v)) throw new Error('RPC sent a simulation without its result');
            return {
                error: v.err,
                logs: v.logs ?? [],
                fee: v.fee ?? null,
                unitsConsumed: v.unitsConsumed ?? null,
                loaded: v.loadedAddresses ? [...v.loadedAddresses.writable, ...v.loadedAddresses.readonly] : null,
                loadedBytes: v.loadedAccountsDataSize ?? null,
                // A failed transaction changes nothing but the fee, so what the RPC sends after it is not read.
                after: v.err === null ? (v.accounts ?? []).map((a, i) => parseBase64RpcAccount(watch[i], a)) : [],
                // The RPC names the program of each inner call, and parses the ones it knows.
                inner: (v.innerInstructions ?? []).map((group) => ({
                    index: group.index,
                    calls: group.instructions.flatMap((ix) => ('programId' in ix ? [{ program: ix.programId, type: 'parsed' in ix ? ix.parsed.type : null, ...(typeof ix.stackHeight === 'number' && { depth: ix.stackHeight }), ...closing(ix) }] : [])),
                })),
                innerListed: v.innerInstructions != null && v.innerInstructions.every((group) => group.instructions.every((ix) => 'programId' in ix)),
            };
        },

        async fees(writable) {
            const recent = await rpc.getRecentPrioritizationFees(writable).send();
            return recent.map((f) => f.prioritizationFee);
        },

        async recommended(writable) {
            const { priorityFeeEstimate } = await rpc.getPriorityFeeEstimate({ accountKeys: writable, options: { recommended: true } }).send();
            return microLamports(priorityFeeEstimate);
        },

        async send(transaction, preflight) {
            await rpc
                .sendTransaction(wire(transaction), { encoding: 'base64', skipPreflight: !preflight, preflightCommitment: 'confirmed', maxRetries: 0n })
                .send();
        },

        async status(signature) {
            const { value: [s] } = await rpc.getSignatureStatuses([signature]).send();
            // No commitment at all means rooted, as older nodes answer.
            return s ? { error: s.err, confirmed: s.confirmationStatus !== 'processed' } : null;
        },

        async latest() {
            return (await rpc.getLatestBlockhash({ commitment: 'confirmed' }).send()).value.blockhash;
        },

        async valid(blockhash, commitment = 'confirmed') {
            return (await rpc.isBlockhashValid(blockhash as Blockhash, { commitment }).send()).value;
        },

        async age(blockhash) {
            const { value } = await rpc.getAccountInfo(RECENT_BLOCKHASHES, { encoding: 'base64', commitment: 'processed' }).send();
            if (!value) return null;
            const data = new Uint8Array(getBase64Encoder().encode(value.data[0]));
            const want = new Uint8Array(getBase58Encoder().encode(blockhash));
            const listed = Math.min(Number(new DataView(data.buffer).getBigUint64(0, true)), Math.floor((data.length - 8) / 40));
            for (let i = 0; i < listed; i++) if (want.every((b, j) => data[8 + 40 * i + j] === b)) return i;
            return null;
        },

        async blockRate() {
            const samples = await rpc.getRecentPerformanceSamples(5).send();
            const seconds = samples.reduce((n, s) => n + s.samplePeriodSecs, 0);
            return seconds > 0 ? samples.reduce((n, s) => n + Number(s.numSlots), 0) / seconds : 0;
        },

        async heads(addresses, length) {
            const heads: MaybeEncodedAccount[] = [];
            for (let i = 0; i < addresses.length; i += BATCH) {
                const batch = addresses.slice(i, i + BATCH);
                const { value } = await rpc.getMultipleAccounts(batch, { encoding: 'base64', commitment: 'confirmed', dataSlice: { offset: 0, length } }).send();
                if (value.length !== batch.length) throw new Error('RPC answered for a different number of accounts');
                heads.push(...value.map((a, j) => parseBase64RpcAccount(batch[j], a)));
            }
            return heads;
        },

        async blockTime(slot) {
            const time = await rpc.getBlockTime(slot).send();
            return time === null ? null : Number(time);
        },
    };
}

// A token account an inner call closes, and where its SOL goes, as the RPC parsed it.
function closing(ix: object): { closes?: [Address, Address] } {
    const parsed = (ix as { parsed?: { type?: unknown; info?: { account?: unknown; destination?: unknown } } }).parsed;
    const { account, destination } = parsed?.info ?? {};
    return parsed?.type === 'closeAccount' && typeof account === 'string' && typeof destination === 'string' && isAddress(account) && isAddress(destination) ? { closes: [account, destination] } : {};
}

// A price as an RPC writes it, whole or with a fraction, up to the next micro-lamport; null when it is not one.
function microLamports(price: unknown): bigint | null {
    if (typeof price === 'bigint') return price >= 0n ? price : null;
    if (typeof price !== 'number' || !Number.isFinite(price) || price < 0) return null;
    return BigInt(Math.ceil(price));
}
