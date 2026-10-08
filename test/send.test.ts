import assert from 'node:assert/strict';
import { test } from 'node:test';

import { getAdvanceNonceAccountInstruction } from '@solana-program/system';
import { createNoopSigner, getBase58Decoder, SOLANA_ERROR__JSON_RPC__SERVER_ERROR_SEND_TRANSACTION_PREFLIGHT_FAILURE, SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR, SolanaError, type TransactionError } from '@solana/kit';

import type { Chain, Status } from '../src/chain.ts';
import { send } from '../src/send/send.ts';
import { fakeChain, key, PAYER, transaction, transfer } from './helpers.ts';

const SIGNATURE = new Uint8Array(64).fill(7);
const signed = (tx: Uint8Array) => Uint8Array.from([...tx.subarray(0, 1), ...SIGNATURE, ...tx.subarray(65)]);
const instantly = async () => {};

/** A chain that answers status checks in turn, and records whether each send asked for a preflight. */
function network(statuses: Status[], valid: (checks: number) => boolean = () => true) {
    const sent: boolean[] = [];
    let checks = 0;
    const chain: Chain = fakeChain([], [], {}, {
        send: async (_tx, preflight) => void sent.push(preflight),
        status: async () => statuses.shift() ?? null,
        valid: async () => valid(++checks),
    });
    return { chain, sent };
}

const unseen = (checks: number): Status[] => Array<Status>(checks).fill(null);

test('sends with a preflight, asks every 200 ms, sends again after a round unseen, and returns once confirmed', async () => {
    const quick = network([null, null, { error: null, confirmed: false }, { error: null, confirmed: true }]);
    const s = await send(signed(transfer()), quick.chain, instantly);
    assert.deepEqual(s, { signature: getBase58Decoder().decode(SIGNATURE), outcome: 'confirmed', error: null });
    assert.deepEqual(quick.sent, [true]); // confirmed within the first round: never sent again
    // Unseen a whole round (10 checks, 2 s): sent again; seen in the next, not again.
    const slow = network([...unseen(10), { error: null, confirmed: false }, ...unseen(9), ...unseen(3), { error: null, confirmed: true }]);
    assert.equal((await send(signed(transfer()), slow.chain, instantly)).outcome, 'confirmed');
    assert.deepEqual(slow.sent, [true, false]);
});

test('waits 200 ms between checks', async () => {
    const waits: number[] = [];
    await send(signed(transfer()), network([null, { error: null, confirmed: true }]).chain, async (ms) => void waits.push(ms));
    assert.deepEqual(waits, [200, 200]);
});

test('preflight skipped (the setting): the first send asks for none either', async () => {
    const { chain, sent } = network([...unseen(10), { error: null, confirmed: true }]);
    const s = await send(signed(transfer()), chain, instantly, false);
    assert.equal(s.outcome, 'confirmed');
    assert.deepEqual(sent, [false, false]);
});

test('returns the error of a transaction that failed onchain', async () => {
    const error: TransactionError = { InstructionError: [0, { Custom: 1 }] };
    const s = await send(signed(transfer()), network([null, { error, confirmed: true }]).chain, instantly);
    assert.deepEqual([s.outcome, s.error], ['failed', error]);
});

test('expires once its blockhash is too old twice in a row, unless it landed just before', async () => {
    const late = await send(signed(transfer()), network([], (n) => n < 2).chain, instantly);
    assert.equal(late.outcome, 'expired');
    const landed = await send(signed(transfer()), network([null, null, null, { error: null, confirmed: true }], (n) => n < 2).chain, instantly);
    assert.equal(landed.outcome, 'confirmed');
    const lagging = network([...unseen(30), { error: null, confirmed: true }], (n) => n !== 2); // one node behind, once
    assert.equal((await send(signed(transfer()), lagging.chain, instantly)).outcome, 'confirmed');
    assert.deepEqual(lagging.sent, [true, false, false, false]);
    // Seen by a node, never confirmed, and its blockhash gone: it may have landed where that node was, so not expired.
    const seen = await send(signed(transfer()), network([{ error: null, confirmed: false }], (n) => n < 2).chain, instantly);
    assert.equal(seen.outcome, 'unknown');
});

test('a durable transaction does not expire: it is watched a while, never by its blockhash, and stays unknown', async () => {
    const nonce = transaction([getAdvanceNonceAccountInstruction({ nonceAccount: key(40), nonceAuthority: createNoopSigner(PAYER) })]);
    const n = network([], () => assert.fail('a nonce is not a blockhash'));
    assert.equal((await send(signed(nonce), n.chain, instantly)).outcome, 'unknown');
    assert.equal(n.sent.length, 45);
});

test('a result counts once confirmed, and a check that fails does not stop the watch', async () => {
    const error: TransactionError = { InstructionError: [0, { Custom: 1 }] };
    let calls = 0;
    const flaky = fakeChain([], [], {}, {
        status: async () => [null, undefined, { error, confirmed: false }, { error: null, confirmed: true }][calls++] ?? Promise.reject(new Error('down')),
        valid: async () => Promise.reject(new Error('down')),
    });
    // An error seen only as processed may be dropped with its block; the transaction can land after all.
    assert.equal((await send(signed(transfer()), flaky, instantly)).outcome, 'confirmed');
});

test('refuses to send what is not fully signed, and passes on a preflight refusal', async () => {
    await assert.rejects(send(transfer(), network([]).chain, instantly), /missing signatures/);
    const preflight = new SolanaError(SOLANA_ERROR__JSON_RPC__SERVER_ERROR_SEND_TRANSACTION_PREFLIGHT_FAILURE, {} as never); // as the RPC answers it
    const refusing = fakeChain([], [], {}, { send: async () => { throw preflight; } });
    await assert.rejects(send(signed(transfer()), refusing, instantly), (e) => e === preflight);
});

test('a first send the RPC never answered may have gone out: it is watched, and lands; the RPC’s own refusal is final', async () => {
    const failing = (error: unknown) => {
        const sent: boolean[] = [];
        const chain: Chain = fakeChain([], [], {}, {
            send: async (_tx, preflight) => {
                sent.push(preflight);
                if (sent.length === 1) throw error;
            },
            status: async () => (sent.length > 1 ? { error: null, confirmed: true } : null),
            valid: async () => true,
        });
        return send(signed(transfer()), chain, instantly);
    };
    assert.equal((await failing(new DOMException('signal timed out', 'TimeoutError'))).outcome, 'confirmed');
    assert.equal((await failing(new TypeError('Failed to fetch'))).outcome, 'confirmed');
    assert.equal((await failing(new SolanaError(SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR, { headers: new Headers(), message: '', statusCode: 503 }))).outcome, 'confirmed');
    await assert.rejects(failing(new SolanaError(SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR, { headers: new Headers(), message: '', statusCode: 429 })));
    await assert.rejects(failing(new SolanaError(SOLANA_ERROR__JSON_RPC__SERVER_ERROR_SEND_TRANSACTION_PREFLIGHT_FAILURE, {} as never)));
});
