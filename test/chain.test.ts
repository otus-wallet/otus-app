import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { Signature } from '@solana/kit';

import { rpcChain } from '../src/chain.ts';
import { rpcFrom } from '../src/rpc.ts';
import { key, PAYER, RECIPIENT, SYSTEM } from './helpers.ts';

/** A Chain over an RPC that answers each method with `answer`, and records the calls. */
function chainAnswering(answer: (method: string) => unknown) {
    const calls: { method: string; params: unknown[] }[] = [];
    const transport = async <T>({ payload }: { payload: unknown }): Promise<T> => {
        const { id, method, params } = payload as { id: number; method: string; params: unknown[] };
        calls.push({ method, params });
        return { jsonrpc: '2.0', id, result: answer(method) } as T;
    };
    return { chain: rpcChain(rpcFrom(transport)), calls };
}

const simulation = (value: object) => chainAnswering(() => ({ context: { slot: 9 }, value: { logs: [], innerInstructions: [], ...value } })).chain;
const wallet = { data: ['', 'base64'], executable: false, lamports: 4_995_000, owner: SYSTEM, rentEpoch: 0, space: 0 };

test('reads a simulation: state after a success only, lookup accounts writable first', async () => {
    const ok = await simulation({ err: null, accounts: [wallet], fee: 5000, unitsConsumed: 150, loadedAddresses: { writable: [RECIPIENT], readonly: [key(9)] } })
        .simulate(new Uint8Array(), [PAYER], 1n);
    assert.deepEqual([ok.after[0].exists && ok.after[0].lamports, ok.fee, ok.unitsConsumed, ok.loaded], [4_995_000n, 5000n, 150n, [RECIPIENT, key(9)]]);
    const failed = await simulation({ err: 'AccountNotFound', accounts: [null] }).simulate(new Uint8Array(), [PAYER], 1n);
    assert.deepEqual([failed.error, failed.after, failed.fee, failed.loaded], ['AccountNotFound', [], null, null]);
});

test('refuses a simulation without its result', async () => {
    await assert.rejects(simulation({ accounts: [wallet] }).simulate(new Uint8Array(), [PAYER], 1n), /without its result/);
});

test('sends without retries by the RPC, and reads fees, statuses and blockhashes', async () => {
    const answers: Record<string, unknown> = {
        sendTransaction: 'sig',
        getRecentPrioritizationFees: [{ slot: 1, prioritizationFee: 7 }, { slot: 2, prioritizationFee: 0 }],
        getSignatureStatuses: { context: { slot: 1 }, value: [{ err: null, confirmationStatus: 'finalized', confirmations: null, slot: 1 }] },
        isBlockhashValid: { context: { slot: 1 }, value: false },
    };
    const { chain, calls } = chainAnswering((method) => answers[method]);
    await chain.send(new Uint8Array([1, 2, 3]), false);
    assert.deepEqual(calls[0].params, ['AQID', { encoding: 'base64', skipPreflight: true, preflightCommitment: 'confirmed', maxRetries: 0n }]);
    assert.deepEqual(await chain.fees([PAYER]), [7n, 0n]);
    assert.deepEqual(await chain.status('sig' as Signature), { error: null, confirmed: true });
    assert.equal(await chain.valid('hash'), false);
});

test('asks the RPC for the price it recommends, as Helius has it: a fraction rounds up; no estimate, no price', async () => {
    const { chain, calls } = chainAnswering(() => ({ priorityFeeEstimate: 10_082.4 }));
    assert.equal(await chain.recommended([PAYER, RECIPIENT]), 10_083n);
    assert.deepEqual(calls, [{ method: 'getPriorityFeeEstimate', params: [{ accountKeys: [PAYER, RECIPIENT], options: { recommended: true } }] }]);
    assert.equal(await chainAnswering(() => ({ priorityFeeEstimate: 25_000n })).chain.recommended([PAYER]), 25_000n);
    assert.equal(await chainAnswering(() => ({})).chain.recommended([PAYER]), null);
    assert.equal(await chainAnswering(() => ({ priorityFeeEstimate: -1 })).chain.recommended([PAYER]), null);
});
