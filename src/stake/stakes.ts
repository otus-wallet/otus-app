// The wallet's native stake as the network has it: each stake account it withdraws from, wherever it was made, with what
// it holds and where it stands; the epoch and about when it ends; and what a new stake account's rent is. Read strictly:
// an account of the Stake Program that is not a stake account's size or layout is shown as unreadable, never guessed.
import { STAKE_PROGRAM_ADDRESS, getStakeStateAccountDecoder } from '@solana-program/stake';
import { getBase64Encoder, type Address, type Rpc, type SolanaRpcApi } from '@solana/kit';

import { STAKE_SPACE } from '../send/stake.ts';

const WITHDRAWER = 44n; // where a stake account names who withdraws from it: after its kind (4), rent (8) and staker (32)
export const NEVER = 2n ** 64n - 1n; // the epoch a stake that is not unstaking would be unstaked at
const SYSVAR_RENT = 'SysvarRent111111111111111111111111111111111' as Address;
const OVERHEAD = 128n; // bytes rent counts for any account, besides its data

/** A stake account the wallet withdraws from. `vote`: whom it is delegated to (null: not delegated); `delegated`: how
 *  much of it is; `activation`, `deactivation`: the epochs it started and stopped (or NEVER); `lockup`: until when,
 *  by epoch and by time (s), no one but its custodian can withdraw it. */
export type StakeAccount = {
    address: Address;
    lamports: bigint;
    reserve: bigint;
    staker: Address;
    withdrawer: Address;
    vote: Address | null;
    delegated: bigint;
    activation: bigint;
    deactivation: bigint;
    lockup: { epoch: bigint; time: bigint; custodian: Address };
};

/** One the Stake Program owns that does not read as a stake account. */
export type Unreadable = { address: Address; lamports: bigint; unreadable: true };

/** Where a stake stands this epoch: not delegated; warming up; earning; cooling down; off, and withdrawable. */
export type Standing = 'idle' | 'activating' | 'active' | 'deactivating' | 'inactive';

/** The stake accounts `owner` withdraws from, largest first. */
export async function stakesOf(rpc: Rpc<SolanaRpcApi>, owner: Address): Promise<(StakeAccount | Unreadable)[]> {
    const found = await rpc
        .getProgramAccounts(STAKE_PROGRAM_ADDRESS, { encoding: 'base64', commitment: 'confirmed', filters: [{ memcmp: { offset: WITHDRAWER, bytes: owner as string as never, encoding: 'base58' } }] })
        .send();
    const read = found.map(({ pubkey, account }) => stakeOf(pubkey, account.lamports, new Uint8Array(getBase64Encoder().encode(account.data[0]))));
    // The filter matched bytes; the layout, read, must name the wallet as who withdraws.
    return read.filter((s) => 'unreadable' in s || s.withdrawer === owner).toSorted((a, b) => (b.lamports > a.lamports ? 1 : b.lamports < a.lamports ? -1 : 0));
}

/** A stake account's bytes → what it holds and where it is delegated; unreadable unless its size and layout fit. */
export function stakeOf(address: Address, lamports: bigint, data: Uint8Array): StakeAccount | Unreadable {
    const unreadable: Unreadable = { address, lamports, unreadable: true };
    if (BigInt(data.length) !== STAKE_SPACE) return unreadable;
    let state;
    try {
        state = getStakeStateAccountDecoder().decode(data).state;
    } catch {
        return unreadable;
    }
    if (state.__kind !== 'Initialized' && state.__kind !== 'Stake') return unreadable;
    const [meta] = state.fields;
    const delegation = state.__kind === 'Stake' ? state.fields[1].delegation : null;
    return {
        address,
        lamports,
        reserve: meta.rentExemptReserve,
        staker: meta.authorized.staker,
        withdrawer: meta.authorized.withdrawer,
        vote: delegation?.voterPubkey ?? null,
        delegated: delegation?.stake ?? 0n,
        activation: delegation?.activationEpoch ?? NEVER,
        deactivation: delegation?.deactivationEpoch ?? NEVER,
        lockup: { epoch: meta.lockup.epoch, time: meta.lockup.unixTimestamp, custodian: meta.lockup.custodian },
    };
}

/** Where a stake stands in `epoch`. A stake's warm-up and cool-down take an epoch, more when much of the network's stake
 *  moves at once: then the review of a withdraw says it would fail. */
export function standingOf(s: StakeAccount, epoch: bigint): Standing {
    if (s.vote === null) return 'idle';
    if (s.deactivation !== NEVER) return s.deactivation >= epoch && s.activation !== s.deactivation ? 'deactivating' : 'inactive';
    return s.activation >= epoch ? 'activating' : 'active';
}

/** Whether a lockup keeps the wallet from withdrawing it now (`now` in s). */
export const lockedOf = (s: StakeAccount, epoch: bigint, now: bigint, owner: Address) => s.lockup.custodian !== owner && (s.lockup.epoch > epoch || s.lockup.time > now);

/** The epoch, and about how many seconds are left of it, at the pace blocks were made of late. */
export async function epochOf(rpc: Rpc<SolanaRpcApi>): Promise<{ epoch: bigint; left: number | null }> {
    const [info, samples] = await Promise.all([rpc.getEpochInfo({ commitment: 'confirmed' }).send(), rpc.getRecentPerformanceSamples(5).send().catch(() => [])]);
    const slots = samples.reduce((n, s) => n + Number(s.numSlots), 0);
    const seconds = samples.reduce((n, s) => n + s.samplePeriodSecs, 0);
    const remaining = Number(info.slotsInEpoch - info.slotIndex);
    return { epoch: info.epoch, left: slots > 0 && seconds > 0 ? (remaining * seconds) / slots : null };
}

/** The lamports a new stake account keeps for its rent, as the Rent sysvar has it: its data and overhead, at the yearly
 *  rate, for the years that exempt it. */
export async function stakeRent(rpc: Rpc<SolanaRpcApi>): Promise<bigint> {
    const { value } = await rpc.getAccountInfo(SYSVAR_RENT, { encoding: 'base64', commitment: 'confirmed' }).send();
    const data = value ? new Uint8Array(getBase64Encoder().encode(value.data[0])) : null;
    if (!data || data.length !== 17) throw new Error('the network did not say what rent is');
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const [perByteYear, years] = [view.getBigUint64(0, true), view.getFloat64(8, true)];
    if (!(years > 0 && years <= 10)) throw new Error('the network did not say what rent is');
    return BigInt(Math.ceil(Number((OVERHEAD + STAKE_SPACE) * perByteYear) * years));
}

/** The first seed of Otus's whose stake account is not there: where the next stake goes. */
export async function nextSeed(rpc: Rpc<SolanaRpcApi>, at: (seed: string) => Promise<Address>, seedOf: (n: number) => string): Promise<string> {
    for (let from = 0; from < 100; from += 10) {
        const seeds = Array.from({ length: 10 }, (_, i) => seedOf(from + i));
        const addresses = await Promise.all(seeds.map(at));
        const { value } = await rpc.getMultipleAccounts(addresses, { encoding: 'base64', dataSlice: { offset: 0, length: 0 }, commitment: 'confirmed' }).send();
        const free = value.findIndex((a) => a === null);
        if (free >= 0) return seeds[free];
    }
    throw new Error('this wallet has 100 stake accounts of Otus already');
}
