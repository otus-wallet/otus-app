// Squads v4, the multisig most Solana programs and treasuries are held by. What its proposals do is out of sight: a
// vault transaction carries the transaction the vault will run as bytes, and voting or executing names only accounts.
// This reads them: its instructions (by their Anchor discriminators), the transaction message a proposal carries, the
// accounts that keep proposals, and the addresses they live at. Pure; layouts from its on-chain IDL (v2.0.0).
import { sha256 } from '@noble/hashes/sha2.js';
import { address, getAddressDecoder, getAddressEncoder, getProgramDerivedAddress, getU32Encoder, getU64Encoder, getU8Encoder, type Address, type ReadonlyUint8Array } from '@solana/kit';

export const SQUADS_V4 = address('SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf');

const discriminator = (kind: 'global' | 'account', name: string) => sha256(new TextEncoder().encode(`${kind}:${name}`)).slice(0, 8);
const snake = (name: string) => name.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

/** What a Squads instruction does: to a proposal, to the multisig (setup), or closing a done proposal's accounts. */
export type Step = 'setup' | 'create' | 'propose' | 'activate' | 'approve' | 'reject' | 'cancel' | 'execute' | 'spend' | 'close';

const STEPS: Record<string, Step> = {
    multisigCreateV2: 'setup',
    batchCreate: 'create',
    vaultTransactionAccountsClose: 'close',
    configTransactionAccountsClose: 'close',
    vaultBatchTransactionAccountClose: 'close',
    batchAccountsClose: 'close',
    vaultTransactionCreate: 'create',
    configTransactionCreate: 'create',
    batchAddTransaction: 'create',
    proposalCreate: 'propose',
    proposalActivate: 'activate',
    proposalApprove: 'approve',
    proposalReject: 'reject',
    proposalCancel: 'cancel',
    proposalCancelV2: 'cancel',
    vaultTransactionExecute: 'execute',
    configTransactionExecute: 'execute',
    batchExecuteTransaction: 'execute',
    spendingLimitUse: 'spend',
};
const BY_DISCRIMINATOR = new Map(Object.keys(STEPS).map((name) => [hex(discriminator('global', snake(name))), name]));

/** A transaction a vault is to run, as a proposal keeps it: the accounts it names (and the lookup tables that add
 *  more), and its instructions, each by indexes into those accounts. */
export type Inner = {
    signers: number;
    writableSigners: number;
    writableNonSigners: number;
    keys: Address[];
    instructions: { program: number; accounts: number[]; data: Uint8Array }[];
    lookups: { table: Address; writable: number[]; readonly: number[] }[];
};

/** A change to the multisig itself, as a config transaction keeps it. */
export type ConfigAction =
    | { kind: 'addMember'; member: Address; permissions: number }
    | { kind: 'removeMember'; member: Address }
    | { kind: 'threshold'; threshold: number }
    | { kind: 'timeLock'; seconds: number }
    | { kind: 'addSpendingLimit'; vaultIndex: number; mint: Address; amount: bigint; period: 'once' | 'day' | 'week' | 'month'; members: Address[]; destinations: Address[] }
    | { kind: 'removeSpendingLimit'; spendingLimit: Address }
    | { kind: 'rentCollector'; collector: Address | null };

/** One Squads instruction, read: what it does, the multisig, and what it names of the proposal. Accounts by the
 *  names Squads' IDL gives them. */
export type Call = {
    name: string;
    step: Step;
    multisig: Address;
    proposal?: Address;
    transaction?: Address; // the vault, config or batch transaction it creates or runs
    batch?: Address;
    index?: bigint; // the transaction's index in the multisig, when the instruction says it
    vaultIndex?: number;
    inner?: Inner; // the transaction a vault transaction carries, when the instruction carries it
    actions?: ConfigAction[];
    spend?: { amount: bigint; decimals: number; mint: Address | null; vault: Address; destination: Address }; // mint: null for SOL
    setup?: { threshold: number; members: { key: Address; permissions: number }[]; timeLock: number };
    rentCollector?: Address; // where closing a done proposal's accounts sends their rent
    memo?: string;
};

/** A Squads v4 instruction (its data, and its accounts in order) → what it does; null for one Otus does not read. */
export function readCall(data: ReadonlyUint8Array, accounts: readonly Address[]): Call | null {
    const name = BY_DISCRIMINATOR.get(hex(data.subarray(0, 8)));
    if (!name) return null;
    const r = new Reader(data, 8);
    const at = (i: number) => accounts[i] ?? null;
    if (name === 'multisigCreateV2') {
        if (!at(2)) return null;
        r.option(() => r.address()); // config authority
        const threshold = r.u16();
        const members = r.vec(() => ({ key: r.address(), permissions: r.u8() }));
        return { name, step: 'setup', multisig: at(2)!, setup: { threshold, members, timeLock: r.u32() } };
    }
    const base = { name, step: STEPS[name], multisig: at(0)! };
    if (!base.multisig) return null;
    switch (name) {
        case 'batchCreate':
            return { ...base, batch: at(1)!, vaultIndex: r.u8() };
        case 'vaultTransactionAccountsClose':
        case 'configTransactionAccountsClose':
            return { ...base, proposal: at(1)!, transaction: at(2)!, rentCollector: at(3)! };
        case 'vaultBatchTransactionAccountClose':
            return { ...base, proposal: at(1)!, batch: at(2)!, transaction: at(3)!, rentCollector: at(4)! };
        case 'batchAccountsClose':
            return { ...base, proposal: at(1)!, batch: at(2)!, rentCollector: at(3)! };
        case 'vaultTransactionCreate': {
            const vaultIndex = r.u8();
            r.u8(); // ephemeral signers
            const inner = compact(r.bytes());
            return { ...base, transaction: at(1)!, vaultIndex, inner, memo: r.option(() => r.string()) ?? undefined };
        }
        case 'batchAddTransaction': {
            r.u8(); // ephemeral signers
            return { ...base, proposal: at(1)!, batch: at(2)!, transaction: at(3)!, inner: compact(r.bytes()) };
        }
        case 'configTransactionCreate':
            return { ...base, transaction: at(1)!, actions: r.vec(() => configAction(r)), memo: r.option(() => r.string()) ?? undefined };
        case 'proposalCreate':
            return { ...base, proposal: at(1)!, index: r.u64() };
        case 'proposalActivate':
        case 'proposalApprove':
        case 'proposalReject':
        case 'proposalCancel':
        case 'proposalCancelV2':
            return { ...base, proposal: at(2)!, memo: name === 'proposalActivate' ? undefined : (r.option(() => r.string()) ?? undefined) };
        case 'vaultTransactionExecute':
            return { ...base, proposal: at(1)!, transaction: at(2)! };
        case 'configTransactionExecute':
            return { ...base, proposal: at(2)!, transaction: at(3)! };
        case 'batchExecuteTransaction':
            return { ...base, proposal: at(2)!, batch: at(3)!, transaction: at(4)! };
        case 'spendingLimitUse': {
            const amount = r.u64();
            const decimals = r.u8();
            const mint = at(6); // an optional account left out is passed as the program itself: SOL
            return { ...base, spend: { amount, decimals, mint: mint === SQUADS_V4 ? null : mint, vault: at(3)!, destination: at(4)! }, memo: r.option(() => r.string()) ?? undefined };
        }
    }
    return null;
}

/** A proposal as its account keeps it: the transaction it is for, where it stands, and who voted. */
export type Proposal = { multisig: Address; index: bigint; status: 'draft' | 'active' | 'rejected' | 'approved' | 'executing' | 'executed' | 'cancelled'; approved: Address[]; rejected: Address[]; cancelled: Address[] };

/** What a proposal's transaction account holds: a vault transaction (from which vault, what it runs), a config one
 *  (what it changes), or a batch (how many it runs). */
export type Kept = { kind: 'vault'; vaultIndex: number; inner: Inner } | { kind: 'config'; actions: ConfigAction[] } | { kind: 'batch'; vaultIndex: number; size: number } | { kind: 'batchTransaction'; inner: Inner };

/** The multisig's own settings: how many approvals a proposal needs, and its members. */
export type Multisig = { threshold: number; members: Address[]; transactionIndex: bigint };

const ACCOUNT = {
    proposal: hex(discriminator('account', 'Proposal')),
    vault: hex(discriminator('account', 'VaultTransaction')),
    config: hex(discriminator('account', 'ConfigTransaction')),
    batch: hex(discriminator('account', 'Batch')),
    batchTransaction: hex(discriminator('account', 'VaultBatchTransaction')),
    multisig: hex(discriminator('account', 'Multisig')),
};
const STATUSES = ['draft', 'active', 'rejected', 'approved', 'executing', 'executed', 'cancelled'] as const;

/** A Proposal account's data → the proposal; null for any other. */
export function readProposal(data: ReadonlyUint8Array): Proposal | null {
    if (hex(data.subarray(0, 8)) !== ACCOUNT.proposal) return null;
    const r = new Reader(data, 8);
    const multisig = r.address();
    const index = r.u64();
    const status = STATUSES[r.u8()];
    if (!status) return null;
    if (status !== 'executing') r.skip(8); // its timestamp
    r.u8(); // bump
    return { multisig, index, status, approved: r.vec(() => r.address()), rejected: r.vec(() => r.address()), cancelled: r.vec(() => r.address()) };
}

/** A transaction account's data (vault, config, batch, or one of a batch) → what it keeps; null for any other. */
export function readKept(data: ReadonlyUint8Array): Kept | null {
    const kind = hex(data.subarray(0, 8));
    const r = new Reader(data, 8);
    if (kind === ACCOUNT.vault) {
        r.skip(32 + 32 + 8 + 1); // multisig, creator, index, bump
        const vaultIndex = r.u8();
        r.u8(); // vault bump
        r.bytes(); // ephemeral signer bumps
        return { kind: 'vault', vaultIndex, inner: stored(r) };
    }
    if (kind === ACCOUNT.config) {
        r.skip(32 + 32 + 8 + 1);
        return { kind: 'config', actions: r.vec(() => configAction(r)) };
    }
    if (kind === ACCOUNT.batch) {
        r.skip(32 + 32 + 8 + 1);
        const vaultIndex = r.u8();
        r.u8();
        return { kind: 'batch', vaultIndex, size: r.u32() };
    }
    if (kind === ACCOUNT.batchTransaction) {
        r.u8(); // bump
        r.bytes(); // ephemeral signer bumps
        return { kind: 'batchTransaction', inner: stored(r) };
    }
    return null;
}

/** A Multisig account's data → its threshold and members; null for any other. */
export function readMultisig(data: ReadonlyUint8Array): Multisig | null {
    if (hex(data.subarray(0, 8)) !== ACCOUNT.multisig) return null;
    const r = new Reader(data, 8);
    r.skip(32 + 32); // create key, config authority
    const threshold = r.u16();
    r.u32(); // time lock
    const transactionIndex = r.u64();
    r.u64(); // stale transaction index
    r.option(() => r.address()); // rent collector
    r.u8(); // bump
    const members = r.vec(() => {
        const key = r.address();
        r.u8(); // permissions
        return key;
    });
    return { threshold, members, transactionIndex };
}

/** Where Squads keeps a multisig's transaction `index`, its proposal, and its vault `index`. */
export const transactionAt = (multisig: Address, index: bigint) => pda([text('multisig'), key(multisig), text('transaction'), getU64Encoder().encode(index)]);
export const proposalAt = (multisig: Address, index: bigint) => pda([text('multisig'), key(multisig), text('transaction'), getU64Encoder().encode(index), text('proposal')]);
export const vaultAt = (multisig: Address, index: number) => pda([text('multisig'), key(multisig), text('vault'), getU8Encoder().encode(index)]);
/** Where Squads keeps transaction `i` (from 1) of the batch of proposal `index`. */
export const batchTransactionAt = (multisig: Address, index: bigint, i: number) => pda([text('multisig'), key(multisig), text('transaction'), getU64Encoder().encode(index), text('batch_transaction'), getU32Encoder().encode(i)]);

async function pda(seeds: ReadonlyUint8Array[]): Promise<Address> {
    return (await getProgramDerivedAddress({ programAddress: SQUADS_V4, seeds })).at(0) as Address;
}
const text = (s: string) => new TextEncoder().encode(s);
const key = (a: Address) => getAddressEncoder().encode(a);

// The message as vaultTransactionCreate carries it: Squads' compact form, its lists counted by a u8, an instruction's
// data by a u16. Bytes after it are not read, as Squads does not read them.
function compact(bytes: Uint8Array): Inner {
    const r = new Reader(bytes, 0);
    const [signers, writableSigners, writableNonSigners] = [r.u8(), r.u8(), r.u8()];
    const keys = r.list(1, () => r.address());
    const instructions = r.list(1, () => ({ program: r.u8(), accounts: r.list(1, () => r.u8()), data: r.take(r.u16()) }));
    const lookups = r.list(1, () => ({ table: r.address(), writable: r.list(1, () => r.u8()), readonly: r.list(1, () => r.u8()) }));
    return checked({ signers, writableSigners, writableNonSigners, keys, instructions, lookups });
}

// The message as a vault transaction account keeps it: Borsh, its lists counted by a u32.
function stored(r: Reader): Inner {
    const [signers, writableSigners, writableNonSigners] = [r.u8(), r.u8(), r.u8()];
    const keys = r.vec(() => r.address());
    const instructions = r.vec(() => ({ program: r.u8(), accounts: r.indexes(), data: r.bytes() }));
    const lookups = r.vec(() => ({ table: r.address(), writable: r.indexes(), readonly: r.indexes() }));
    return checked({ signers, writableSigners, writableNonSigners, keys, instructions, lookups });
}

// Every index points at an account the message has: its own, or one its lookup tables add; no more accounts than a
// transaction could take.
function checked(m: Inner): Inner {
    const count = m.keys.length + m.lookups.reduce((n, l) => n + l.writable.length + l.readonly.length, 0);
    const ok = count <= MAX_ITEMS && m.signers <= m.keys.length && m.writableSigners <= m.signers && m.instructions.every((ix) => ix.program < count && ix.accounts.every((i) => i < count));
    if (!ok) throw new Error('a Squads message that does not hold together');
    return m;
}

function configAction(r: Reader): ConfigAction {
    switch (r.u8()) {
        case 0: {
            const member = r.address();
            return { kind: 'addMember', member, permissions: r.u8() };
        }
        case 1:
            return { kind: 'removeMember', member: r.address() };
        case 2:
            return { kind: 'threshold', threshold: r.u16() };
        case 3:
            return { kind: 'timeLock', seconds: r.u32() };
        case 4: {
            r.address(); // create key
            const vaultIndex = r.u8();
            const mint = r.address();
            const amount = r.u64();
            const period = (['once', 'day', 'week', 'month'] as const)[r.u8()];
            if (!period) throw new Error('a spending limit of no period');
            return { kind: 'addSpendingLimit', vaultIndex, mint, amount, period, members: r.vec(() => r.address()), destinations: r.vec(() => r.address()) };
        }
        case 5:
            return { kind: 'removeSpendingLimit', spendingLimit: r.address() };
        case 6:
            return { kind: 'rentCollector', collector: r.option(() => r.address()) };
    }
    throw new Error('a Squads config action Otus does not know');
}

function hex(b: ReadonlyUint8Array): string {
    return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

// Reads little-endian Borsh, refusing to run past the end; lists are capped, as the data may be anyone's.
class Reader {
    #data: ReadonlyUint8Array;
    #at: number;
    constructor(data: ReadonlyUint8Array, at: number) {
        this.#data = data;
        this.#at = at;
    }
    take(n: number): Uint8Array {
        if (n < 0 || this.#at + n > this.#data.length) throw new Error('Squads data ends early');
        const out = this.#data.slice(this.#at, this.#at + n);
        this.#at += n;
        return Uint8Array.from(out);
    }
    skip(n: number) {
        this.take(n);
    }
    u8 = () => this.take(1)[0];
    u16 = () => new DataView(this.take(2).buffer).getUint16(0, true);
    u32 = () => new DataView(this.take(4).buffer).getUint32(0, true);
    u64 = () => new DataView(this.take(8).buffer).getBigUint64(0, true);
    address = () => getAddressDecoder().decode(this.take(32));
    bytes = () => this.take(this.u32());
    // A list of account indexes, Borsh bytes: no more than a list may hold.
    indexes(): number[] {
        const n = this.u32();
        if (n > MAX_ITEMS) throw new Error('a Squads list too long to be real');
        return [...this.take(n)];
    }
    string = () => new TextDecoder().decode(this.bytes());
    option<T>(read: () => T): T | null {
        const tag = this.u8();
        if (tag > 1) throw new Error('a Squads option that is neither');
        return tag ? read() : null;
    }
    vec<T>(read: () => T): T[] {
        return this.list(4, read);
    }
    // A list counted by a u8 (Squads' compact form) or a u32 (Borsh).
    list<T>(width: 1 | 4, read: () => T): T[] {
        const n = width === 1 ? this.u8() : this.u32();
        if (n > MAX_ITEMS) throw new Error('a Squads list too long to be real');
        return Array.from({ length: n }, read);
    }
}

const MAX_ITEMS = 256; // more than a transaction can hold of anything
