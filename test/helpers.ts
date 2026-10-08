import {
    AccountRole,
    address,
    appendTransactionMessageInstruction,
    appendTransactionMessageInstructions,
    blockhash,
    compileTransaction,
    compressTransactionMessageUsingAddressLookupTables,
    createTransactionMessage,
    getAddressDecoder,
    getAddressEncoder,
    getTransactionEncoder,
    lamports,
    pipe,
    setTransactionMessageConfig,
    setTransactionMessageFeePayer,
    setTransactionMessageLifetimeUsingBlockhash,
    type Address,
    type Instruction,
    type MaybeEncodedAccount,
    type V1TransactionConfig,
} from '@solana/kit';

import { TOKEN_PROGRAM_ADDRESS } from '@solana-program/token';

import type { Chain, Simulation } from '@otus-wallet/sdk/chain';

/** A valid address made of one repeated byte. */
export const key = (n: number): Address => getAddressDecoder().decode(new Uint8Array(32).fill(n));

export const PAYER = key(1);
export const RECIPIENT = key(2);
export const TABLE = key(7);
export const SYSTEM = address('11111111111111111111111111111111');
export const TRANSFER_DATA = new Uint8Array([2, 0, 0, 0, 0x40, 0x42, 0x0f, 0, 0, 0, 0, 0]); // 0.001 SOL
const LIFETIME = { blockhash: blockhash(key(9)), lastValidBlockHeight: 0n };

const instruction = (data: Uint8Array): Instruction => ({
    programAddress: SYSTEM,
    accounts: [
        { address: PAYER, role: AccountRole.WRITABLE_SIGNER },
        { address: RECIPIENT, role: AccountRole.WRITABLE },
    ],
    data,
});

const wire = (message: Parameters<typeof compileTransaction>[0]) =>
    new Uint8Array(getTransactionEncoder().encode(compileTransaction(message)));

/** Wire bytes of an unsigned System transfer from PAYER to RECIPIENT. */
export function transfer(version: 'legacy' | 0 | 1 = 'legacy', data = TRANSFER_DATA): Uint8Array {
    return wire(
        pipe(
            createTransactionMessage({ version }),
            (m) => setTransactionMessageFeePayer(PAYER, m),
            (m) => setTransactionMessageLifetimeUsingBlockhash(LIFETIME, m),
            (m) => appendTransactionMessageInstruction(instruction(data), m),
        ),
    );
}

/** The same transfer as a v1 transaction with a config. */
export function transferV1(config: V1TransactionConfig): Uint8Array {
    return wire(
        pipe(
            createTransactionMessage({ version: 1 }),
            (m) => setTransactionMessageFeePayer(PAYER, m),
            (m) => setTransactionMessageLifetimeUsingBlockhash(LIFETIME, m),
            (m) => appendTransactionMessageInstruction(instruction(TRANSFER_DATA), m),
            (m) => setTransactionMessageConfig(config, m),
        ),
    );
}

/** The same transfer as v0, with RECIPIENT loaded from TABLE. */
export const transferWithTable = () => transactionWithTable([instruction(TRANSFER_DATA)], [RECIPIENT]);

/** Wire bytes of an unsigned v0 transaction paid by PAYER, loading what it can from TABLE holding `table`. */
export function transactionWithTable(instructions: Instruction[], table: Address[]): Uint8Array {
    const message = pipe(
        createTransactionMessage({ version: 0 }),
        (m) => setTransactionMessageFeePayer(PAYER, m),
        (m) => setTransactionMessageLifetimeUsingBlockhash(LIFETIME, m),
        (m) => appendTransactionMessageInstructions(instructions, m),
    );
    return wire(compressTransactionMessageUsingAddressLookupTables(message, { [TABLE]: table }));
}

/** Account data of an active lookup table holding these addresses. */
export function lookupTable(addresses: Address[]): Uint8Array {
    const data = new Uint8Array(56 + 32 * addresses.length);
    data.set([1, 0, 0, 0]); // type: lookup table
    data.fill(0xff, 4, 12); // never deactivated
    addresses.forEach((a, i) => data.set(getAddressEncoder().encode(a), 56 + 32 * i));
    return data;
}

export function account(address: Address, owner: Address, balance: bigint, data: Uint8Array = new Uint8Array()): MaybeEncodedAccount {
    return { exists: true, address, programAddress: owner, lamports: lamports(balance), data, executable: false, space: BigInt(data.length) };
}

/** SPL token account data (165 bytes, initialized). `native`: wrapped SOL, with this rent reserve; `delegated`: the
 *  delegate's allowance; `closer`: its close authority. */
export function tokenAccountData(o: { mint: Address; owner: Address; amount: bigint; delegate?: Address; delegated?: bigint; native?: bigint; closer?: Address }): Uint8Array {
    const d = new Uint8Array(165);
    d.set(getAddressEncoder().encode(o.mint), 0);
    d.set(getAddressEncoder().encode(o.owner), 32);
    new DataView(d.buffer).setBigUint64(64, o.amount, true);
    if (o.delegate) {
        d[72] = 1;
        d.set(getAddressEncoder().encode(o.delegate), 76);
    }
    d[108] = 1;
    if (o.native !== undefined) {
        d[109] = 1;
        new DataView(d.buffer).setBigUint64(113, o.native, true);
    }
    if (o.delegated !== undefined) new DataView(d.buffer).setBigUint64(121, o.delegated, true);
    if (o.closer) {
        d[129] = 1;
        d.set(getAddressEncoder().encode(o.closer), 133);
    }
    return d;
}

/** Wire bytes of an unsigned legacy transaction paid by PAYER. */
export function transaction(instructions: Instruction[]): Uint8Array {
    return wire(
        pipe(
            createTransactionMessage({ version: 'legacy' }),
            (m) => setTransactionMessageFeePayer(PAYER, m),
            (m) => setTransactionMessageLifetimeUsingBlockhash(LIFETIME, m),
            (m) => appendTransactionMessageInstructions(instructions, m),
        ),
    );
}

/** A Chain at slot 1 whose accounts are `before`, and whose simulation leaves them as `after`. Sending succeeds by default. */
export function fakeChain(before: MaybeEncodedAccount[], after = before, simulation: Partial<Simulation> = {}, rest: Partial<Chain> = {}): Chain {
    const lookup = (list: MaybeEncodedAccount[]) => {
        const byAddress = new Map(list.map((a) => [a.address, a]));
        return (address: Address): MaybeEncodedAccount => byAddress.get(address) ?? { exists: false, address };
    };
    const [pre, post] = [lookup(before), lookup(after)];
    return {
        async accounts(addresses) {
            return { slot: 1n, accounts: addresses.map(pre) };
        },
        async simulate(_transaction, watch) {
            const base = { error: null, logs: [], fee: 5000n, unitsConsumed: null, loaded: null, inner: [], innerListed: true };
            return { ...base, after: watch.map(post), ...simulation };
        },
        fees: async () => [],
        recommended: async () => null,
        send: async () => {},
        status: async () => null,
        valid: async () => true,
        heads: async (addresses, length) => addresses.map((a) => {
            const found = pre(a);
            return found.exists ? { ...found, data: found.data.slice(0, length) } : found;
        }),
        blockTime: async () => null,
        age: async () => 0,
        blockRate: async () => 2.5,
        latest: async () => key(99),
        ...rest,
    };
}

export const MINT = key(20);
export const ATTACKER = key(21);
export const EVIL_PROGRAM = key(22);
export const USER_TOKEN = key(23);

/** A drainer: the user's wallet and token account go to an unknown program, which takes both. */
export const DRAIN = transaction([
    {
        programAddress: EVIL_PROGRAM,
        accounts: [
            { address: PAYER, role: AccountRole.WRITABLE_SIGNER },
            { address: USER_TOKEN, role: AccountRole.WRITABLE },
            { address: RECIPIENT, role: AccountRole.WRITABLE },
        ],
    },
]);
export const DRAIN_BEFORE = [
    account(PAYER, SYSTEM, 5_000_000n),
    account(USER_TOKEN, TOKEN_PROGRAM_ADDRESS, 2_039_280n, tokenAccountData({ mint: MINT, owner: PAYER, amount: 1000n })),
];
export const DRAIN_AFTER = [
    account(PAYER, EVIL_PROGRAM, 4_995_000n),
    account(USER_TOKEN, TOKEN_PROGRAM_ADDRESS, 2_039_280n, tokenAccountData({ mint: MINT, owner: ATTACKER, amount: 0n, delegate: ATTACKER })),
    account(RECIPIENT, SYSTEM, 1_000_000n),
];
