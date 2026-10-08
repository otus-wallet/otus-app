import assert from 'node:assert/strict';
import { test } from 'node:test';

import { getSetComputeUnitLimitInstruction, getSetComputeUnitPriceInstruction } from '@solana-program/compute-budget';
import { getTransferSolInstruction } from '@solana-program/system';
import { TOKEN_PROGRAM_ADDRESS } from '@solana-program/token';
import { address, createNoopSigner, type Address } from '@solana/kit';

import type { Simulation } from '../src/chain.ts';
import { TOKEN_2022_PROGRAM_ADDRESS } from '../src/programs/core.ts';
import { changes, read, type State } from '../src/review/changes.ts';
import { decode } from '../src/review/decode.ts';
import { resolve } from '../src/review/resolve.ts';
import { simulate } from '../src/review/simulate.ts';
import {
    account,
    ATTACKER,
    DRAIN,
    DRAIN_AFTER,
    DRAIN_BEFORE,
    EVIL_PROGRAM,
    fakeChain,
    MINT,
    PAYER,
    RECIPIENT,
    SYSTEM,
    tokenAccountData,
    transaction,
    USER_TOKEN,
} from './helpers.ts';

const simulated = async (tx: Uint8Array, after = DRAIN_AFTER, simulation: Partial<Simulation> = {}) =>
    simulate(await resolve(await decode(tx), fakeChain(DRAIN_BEFORE)), fakeChain(DRAIN_BEFORE, after, simulation));

test('reads every account the transaction can write, before and after, from the accounts themselves', async () => {
    const c = changes(await simulated(DRAIN));
    const at = Object.fromEntries(c.accounts.map((x) => [x.address, x]));
    assert.equal(c.fee, 5000n);
    assert.deepEqual(Object.keys(at).sort(), [PAYER, USER_TOKEN, RECIPIENT].sort());
    const plain = (st: State) => st && { lamports: st.lamports, program: st.program, space: st.space, token: st.token };
    assert.deepEqual([plain(at[PAYER].before), plain(at[PAYER].after)], [
        { lamports: 5_000_000n, program: SYSTEM, space: 0, token: null },
        { lamports: 4_995_000n, program: EVIL_PROGRAM, space: 0, token: null },
    ]);
    assert.deepEqual([at[USER_TOKEN].before?.token, at[USER_TOKEN].after?.token], [
        { mint: MINT, owner: PAYER, amount: 1000n, delegate: null, delegated: 0n, closer: null, native: false },
        { mint: MINT, owner: ATTACKER, amount: 0n, delegate: ATTACKER, delegated: 0n, closer: null, native: false },
    ]);
    assert.deepEqual([at[RECIPIENT].before, at[RECIPIENT].after?.lamports], [null, 1_000_000n]);
});

test('an account the transaction empties is gone, as the runtime purges it', () => {
    assert.equal(read(account(USER_TOKEN, SYSTEM, 0n)), null);
});

test('a failed transaction changes nothing but the fee', async () => {
    const c = changes(await simulated(DRAIN, DRAIN_AFTER, { error: { InstructionError: [0, { Custom: 6001 }] }, after: [] }));
    assert.ok(c.accounts.every((x) => x.after === x.before));
});

test('without a fee from the RPC, the fee comes from the message', async () => {
    const pay = getTransferSolInstruction({ source: createNoopSigner(PAYER), destination: RECIPIENT, amount: 1n });
    const priced = transaction([getSetComputeUnitLimitInstruction({ units: 100_000 }), getSetComputeUnitPriceInstruction({ microLamports: 2_000_000n }), pay]);
    assert.equal(changes(await simulated(priced, DRAIN_BEFORE, { fee: null })).fee, 5_000n + 200_000n);
    const unpriced = transaction([pay]);
    assert.equal(changes(await simulated(unpriced, DRAIN_BEFORE, { fee: null })).fee, 5_000n);
    // The runtime ignores bytes past an instruction's size, and charges for each signature a precompile checks.
    const price = getSetComputeUnitPriceInstruction({ microLamports: 2_000_000n });
    const trailing = transaction([getSetComputeUnitLimitInstruction({ units: 100_000 }), { ...price, data: Uint8Array.from([...price.data, 0]) }, pay]);
    const ed25519 = { programAddress: address('Ed25519SigVerify111111111111111111111111111'), data: new Uint8Array([2, 0]) };
    assert.equal(changes(await simulated(trailing, DRAIN_BEFORE, { fee: null })).fee, 5_000n + 200_000n);
    assert.equal(changes(await simulated(transaction([ed25519, pay]), DRAIN_BEFORE, { fee: null })).fee, 3n * 5_000n);
});

test('reads token fields only from initialized token accounts', () => {
    const data = tokenAccountData({ mint: MINT, owner: PAYER, amount: 7n, delegate: ATTACKER });
    new DataView(data.buffer).setBigUint64(121, 5n, true);
    const extended = (type: number, size = 170) => Uint8Array.from({ length: size }, (_, i) => (i < 165 ? data[i] : i === 165 ? type : 0));
    const token = (owner: Address, d: Uint8Array) => read(account(USER_TOKEN, owner, 1n, d))?.token ?? null;
    assert.deepEqual(token(TOKEN_PROGRAM_ADDRESS, data), { mint: MINT, owner: PAYER, amount: 7n, delegate: ATTACKER, delegated: 5n, closer: null, native: false });
    assert.equal(token(TOKEN_2022_PROGRAM_ADDRESS, extended(2))?.amount, 7n);
    assert.deepEqual(
        [
            token(TOKEN_PROGRAM_ADDRESS, new Uint8Array(165)), // not initialized yet
            token(TOKEN_PROGRAM_ADDRESS, extended(2)), // Token has no extensions
            token(TOKEN_2022_PROGRAM_ADDRESS, extended(1)), // a mint with extensions
            token(TOKEN_2022_PROGRAM_ADDRESS, extended(2, 355)), // a multisig
            token(EVIL_PROGRAM, data), // the same bytes under another program
        ],
        [null, null, null, null, null],
    );
});
