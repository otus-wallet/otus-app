// An address's transactions, newest first, a page at a time: Helius' getTransactionsForAddress, one request a page,
// gives each whole with what it changed (its meta), the transactions of the token accounts the address owns included.
// Nothing else is asked for. The answer is read with care, as data from the network: whole numbers exactly, every
// list bounded, every index in range; a transaction that does not hold comes back as unreadable, not as something it
// is not.
import { getBase58Decoder, getBase64Encoder, getTransactionDecoder, isAddress, type Address } from '@solana/kit';

import { told } from '../format.ts';
import { RPC_WAIT } from '../rpc.ts';
import { decode, type Message } from '../review/decode.ts';

export const PAGE = 10; // transactions a request

/** A token balance a transaction shows, before or after it: of the account at `account`, among its accounts. */
export type TokenBalance = { account: number; mint: Address; owner: Address | null; units: bigint; decimals: number };

/** A transaction as it landed: its message, every account it used (lookup tables' included, in the runtime's order),
 *  and what it changed. `time`: seconds since 1970, when the node knows. */
export type Landed = {
    signature: string;
    slot: bigint;
    time: number | null;
    message: Message;
    accounts: Address[];
    error: string | null; // why it failed, in short; null when it worked
    fee: bigint;
    lamports: { before: bigint[]; after: bigint[] };
    tokens: { before: TokenBalance[]; after: TokenBalance[] };
};

/** One page: what was read, each in its place, and where the next one starts (null: no more). */
export type Page = { items: (Landed | { unreadable: string })[]; next: string | null };

/** The RPC has no getTransactionsForAddress: it is Helius' own. */
export class NoHistory extends Error {}

const MAX_BYTES = 4096; // a transaction, v1's limit
const MAX_BALANCES = 512; // token balances listed a side

/** The page of `address`'s transactions after `from` (a page's `next`), or the newest; `stop` gives up on it. Throws
 *  NoHistory, or as the network does. */
export async function historyPage(rpcUrl: string, address: Address, from?: string, stop?: AbortSignal): Promise<Page> {
    const options = {
        transactionDetails: 'full',
        limit: PAGE,
        sortOrder: 'desc',
        encoding: 'base64',
        maxSupportedTransactionVersion: 1,
        commitment: 'confirmed',
        filters: { tokenAccounts: 'balanceChanged' },
        ...(from && { paginationToken: from }),
    };
    const response = await fetch(rpcUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getTransactionsForAddress', params: [address, options] }),
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
        signal: stop ? AbortSignal.any([stop, AbortSignal.timeout(RPC_WAIT)]) : AbortSignal.timeout(RPC_WAIT),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return readPage(exactJson(await response.text()));
}

/** JSON with every whole number past 2^53 as a bigint, read from its digits: lamports run past it. */
export const exactJson = (text: string): unknown =>
    (JSON.parse as (text: string, reviver: (key: string, value: unknown, context: { source?: string }) => unknown) => unknown)(text, (_, value, context) =>
        typeof value === 'number' && !Number.isSafeInteger(value) && /^\d+$/.test(context.source ?? '') ? BigInt(context.source!) : value,
    );

/** The RPC's answer → a page. Pure; throws NoHistory, or an Error with the RPC's words. */
export async function readPage(reply: unknown): Promise<Page> {
    const r = reply as { error?: { code?: unknown; message?: unknown }; result?: { data?: unknown; paginationToken?: unknown } };
    if (r?.error) {
        const message = typeof r.error.message === 'string' ? told(r.error.message, 120) : 'the RPC refused';
        if (r.error.code === -32601 || /method not found/i.test(message)) throw new NoHistory(message);
        throw new Error(message);
    }
    const data = r?.result?.data;
    if (!Array.isArray(data)) throw new Error('the RPC answered without transactions');
    const token = r.result?.paginationToken;
    const next = typeof token === 'string' && /^\d{1,20}:\d{1,10}$/.test(token) && data.length > 0 ? token : null;
    const items = await Promise.all(data.slice(0, PAGE).map((item) => landed(item).catch((e: unknown) => ({ unreadable: e instanceof Error ? e.message : 'unreadable' }))));
    return { items, next };
}

// One transaction of the answer, checked whole. Throws.
async function landed(item: unknown): Promise<Landed> {
    const t = item as { transaction?: unknown; meta?: Record<string, unknown>; slot?: unknown; blockTime?: unknown };
    const [base64, encoding] = Array.isArray(t?.transaction) ? t.transaction : [];
    if (typeof base64 !== 'string' || encoding !== 'base64' || base64.length > Math.ceil(MAX_BYTES / 3) * 4) throw new Error('no transaction');
    const bytes = new Uint8Array(getBase64Encoder().encode(base64));
    const decoded = await decode(bytes);
    const signature = getTransactionDecoder().decode(bytes).signatures[decoded.signers[0]];
    if (!signature) throw new Error('unsigned');
    const meta = t.meta;
    if (!meta || typeof meta !== 'object') throw new Error('no meta');
    const loaded = meta.loadedAddresses as { writable?: unknown; readonly?: unknown } | undefined;
    const lookups = decoded.message.lookups;
    const writable = addresses(loaded?.writable ?? [], lookups.reduce((n, l) => n + l.writableIndexes.length, 0));
    const readonly = addresses(loaded?.readonly ?? [], lookups.reduce((n, l) => n + l.readonlyIndexes.length, 0));
    const accounts = [...decoded.message.staticAccounts, ...writable, ...readonly];
    const lamports = (list: unknown) => {
        if (!Array.isArray(list) || list.length !== accounts.length) throw new Error('balances do not match the accounts');
        return list.map(u64);
    };
    return {
        signature: getBase58Decoder().decode(signature),
        slot: u64(t.slot),
        time: typeof t.blockTime === 'number' && Number.isSafeInteger(t.blockTime) && t.blockTime > 0 ? t.blockTime : null,
        message: decoded.message,
        accounts,
        error: meta.err == null ? null : failure(meta.err),
        fee: u64(meta.fee),
        lamports: { before: lamports(meta.preBalances), after: lamports(meta.postBalances) },
        tokens: { before: balances(meta.preTokenBalances, accounts.length), after: balances(meta.postTokenBalances, accounts.length) },
    };
}

// The accounts a lookup table gave: as many as the message asks for, each an address.
function addresses(list: unknown, count: number): Address[] {
    if (!Array.isArray(list) || list.length !== count || !list.every((a) => typeof a === 'string' && isAddress(a))) throw new Error('lookup accounts do not match the message');
    return list as Address[];
}

function balances(list: unknown, accounts: number): TokenBalance[] {
    if (list == null) return [];
    if (!Array.isArray(list) || list.length > MAX_BALANCES) throw new Error('bad token balances');
    return list.map((b: { accountIndex?: unknown; mint?: unknown; owner?: unknown; uiTokenAmount?: { amount?: unknown; decimals?: unknown } }) => {
        const { accountIndex, mint, owner } = b ?? {};
        const { amount, decimals } = b?.uiTokenAmount ?? {};
        if (!Number.isInteger(accountIndex) || (accountIndex as number) < 0 || (accountIndex as number) >= accounts) throw new Error('bad token account index');
        if (typeof mint !== 'string' || !isAddress(mint) || (owner != null && (typeof owner !== 'string' || !isAddress(owner)))) throw new Error('bad token balance');
        if (typeof amount !== 'string' || !/^\d{1,20}$/.test(amount) || !Number.isInteger(decimals) || (decimals as number) < 0 || (decimals as number) > 255) throw new Error('bad token amount');
        return { account: accountIndex as number, mint, owner: (owner as Address | undefined) ?? null, units: BigInt(amount), decimals: decimals as number };
    });
}

const U64_MAX = 2n ** 64n - 1n;
function u64(v: unknown): bigint {
    const n = typeof v === 'number' && Number.isSafeInteger(v) ? BigInt(v) : v;
    if (typeof n !== 'bigint' || n < 0n || n > U64_MAX) throw new Error('bad number');
    return n;
}

// Why a transaction failed, in short: the instruction and its error, as the runtime names them.
function failure(err: unknown): string {
    const e = err as { InstructionError?: [unknown, unknown] };
    if (Array.isArray(e?.InstructionError)) {
        const [at, why] = e.InstructionError;
        const what = typeof why === 'string' ? why : (why as { Custom?: unknown })?.Custom !== undefined ? `error ${String((why as { Custom: unknown }).Custom)}` : 'an error';
        return told(`instruction ${Number(at) + 1}: ${what}`, 80);
    }
    return told(typeof err === 'string' ? err : (Object.keys(err as object)[0] ?? 'failed'), 80);
}
