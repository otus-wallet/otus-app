// What Otus builds to take access back, for the same review as any transaction: a delegate revoked, or a nonce moved on
// so that a transaction signed on it can no longer run. A v0 message with its Compute Budget limit first, which Otus
// fits when it prepares it; first, it also keeps a nonce's advance from reading as a durable nonce of its own.
import { MAX_COMPUTE_UNIT_LIMIT, getSetComputeUnitLimitInstruction } from '@solana-program/compute-budget';
import { getAdvanceNonceAccountInstruction } from '@solana-program/system';
import { getRevokeInstruction } from '@solana-program/token';
import {
    appendTransactionMessageInstructions,
    compileTransaction,
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

/** What can be taken back: a token account's delegate (of its token program), or a nonce of yours. */
export type Fix = { kind: 'revoke'; account: Address; program: Address } | { kind: 'cancel'; nonce: Address };

/** The unsigned transaction, as wire bytes, that `owner` signs and pays for. */
export function fix(owner: Address, what: Fix, lifetime: Lifetime): Uint8Array {
    const me = createNoopSigner(owner);
    const taken: Instruction =
        what.kind === 'revoke'
            ? getRevokeInstruction({ source: what.account, owner: me }, { programAddress: what.program })
            : getAdvanceNonceAccountInstruction({ nonceAccount: what.nonce, nonceAuthority: me });
    const message = pipe(
        createTransactionMessage({ version: 0 }),
        (m) => setTransactionMessageFeePayer(owner, m),
        (m) => setTransactionMessageLifetimeUsingBlockhash(lifetime, m),
        (m) => appendTransactionMessageInstructions([getSetComputeUnitLimitInstruction({ units: MAX_COMPUTE_UNIT_LIMIT }), taken], m),
    );
    return new Uint8Array(getTransactionEncoder().encode(compileTransaction(message)));
}
