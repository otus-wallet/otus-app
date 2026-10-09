// What Otus builds for native staking, for the same review as any transaction: a stake account of the wallet's own, at
// an address its seed derives from the wallet (so no other key signs), answering to the wallet alone and delegated to a
// validator; then unstaked, and withdrawn whole once its stake is off. A v0 message with its Compute Budget limit
// first, which Otus fits when it prepares it: a Ledger's Solana app cannot read v1.
import { MAX_COMPUTE_UNIT_LIMIT, getSetComputeUnitLimitInstruction } from '@solana-program/compute-budget';
import { STAKE_PROGRAM_ADDRESS, getDeactivateInstruction, getDelegateStakeInstruction, getInitializeInstruction, getWithdrawInstruction } from '@solana-program/stake';
import { SYSTEM_PROGRAM_ADDRESS, getCreateAccountWithSeedInstruction } from '@solana-program/system';
import {
    appendTransactionMessageInstructions,
    compileTransaction,
    createAddressWithSeed,
    createNoopSigner,
    createTransactionMessage,
    getTransactionEncoder,
    pipe,
    setTransactionMessageFeePayer,
    setTransactionMessageLifetimeUsingBlockhash,
    type Address,
    type Instruction,
} from '@solana/kit';

import type { Lifetime } from './transfer.ts';

/** A stake account's size: what its rent is counted on. */
export const STAKE_SPACE = 200n;

/** What Otus does with stake: a new stake of `lamports` (its rent included) delegated to a vote account, at the address
 *  the seed derives; a stake unstaked; or a stake withdrawn whole to the wallet. */
export type StakeJob = { kind: 'stake'; seed: string; lamports: bigint; vote: Address } | { kind: 'unstake'; stake: Address } | { kind: 'withdraw'; stake: Address; lamports: bigint };

/** The seeds Otus derives stake accounts with, in order: the first whose account is not there is the next one's. */
export const seedOf = (n: number) => `stake:${n}`;

/** The stake account a seed derives from the wallet. */
export const stakeAt = (owner: Address, seed: string) => createAddressWithSeed({ baseAddress: owner, programAddress: STAKE_PROGRAM_ADDRESS, seed });

/** The unsigned transaction, as wire bytes, that `owner` signs and pays for. */
export async function staking(owner: Address, job: StakeJob, lifetime: Lifetime): Promise<Uint8Array> {
    const me = createNoopSigner(owner);
    let done: Instruction[];
    if (job.kind === 'stake') {
        const stake = await stakeAt(owner, job.seed);
        done = [
            getCreateAccountWithSeedInstruction({ payer: me, newAccount: stake, baseAccount: me, base: owner, seed: job.seed, amount: job.lamports, space: STAKE_SPACE, programAddress: STAKE_PROGRAM_ADDRESS }),
            // The wallet both stakes and withdraws it, with no lockup: no one else can ever hold it back.
            getInitializeInstruction({ stake, arg0: { staker: owner, withdrawer: owner }, arg1: { unixTimestamp: 0n, epoch: 0n, custodian: SYSTEM_PROGRAM_ADDRESS } }),
            getDelegateStakeInstruction({ stake, vote: job.vote, stakeAuthority: me }),
        ];
    } else if (job.kind === 'unstake') {
        done = [getDeactivateInstruction({ stake: job.stake, stakeAuthority: me })];
    } else {
        done = [getWithdrawInstruction({ stake: job.stake, recipient: owner, withdrawAuthority: me, args: job.lamports })];
    }
    const message = pipe(
        createTransactionMessage({ version: 0 }),
        (m) => setTransactionMessageFeePayer(owner, m),
        (m) => setTransactionMessageLifetimeUsingBlockhash(lifetime, m),
        (m) => appendTransactionMessageInstructions([getSetComputeUnitLimitInstruction({ units: MAX_COMPUTE_UNIT_LIMIT }), ...done], m),
    );
    return new Uint8Array(getTransactionEncoder().encode(compileTransaction(message)));
}
