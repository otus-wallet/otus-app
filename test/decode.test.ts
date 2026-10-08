import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';

import { getBase58Decoder } from '@solana/kit';

import { Refused } from '../src/protocol.ts';
import { decode, durable, encode, sanitize, type Message } from '../src/review/decode.ts';
import { key, PAYER, TABLE, TRANSFER_DATA, transfer, transferV1, transferWithTable } from './helpers.ts';

// Offsets in an unsigned legacy transfer: one signature slot, then the message.
const MESSAGE = 1 + 64;
const KEY_COUNT = MESSAGE + 3;
const RECIPIENT_KEY = KEY_COUNT + 1 + 32;
const PROGRAM_INDEX = KEY_COUNT + 1 + 3 * 32 + 32 + 1;
// A v1 transaction starts with its message: version byte, 3 header bytes, then the config mask.
const V1_CONFIG_MASK = 1 + 3;

function patch(bytes: Uint8Array, at: number, values: ArrayLike<number>): Uint8Array {
    const copy = bytes.slice();
    copy.set(values, at);
    return copy;
}

const refusedFor = (reason: RegExp) => (e: unknown) => e instanceof Refused && reason.test(e.message);

test('decodes legacy, v0 and v1 transfers into one shape', async () => {
    for (const version of ['legacy', 0, 1] as const) {
        const d = await decode(transfer(version));
        assert.equal(d.message.version, version);
        assert.deepEqual(d.message.instructions, [{ programAddressIndex: 2, accountIndices: [0, 1], data: TRANSFER_DATA }]);
        assert.deepEqual(d.message.lookups, []);
        assert.deepEqual(d.signers, [PAYER]);
        assert.deepEqual(d.signed, []);
        assert.equal(d.hash, getBase58Decoder().decode(createHash('sha256').update(d.messageBytes).digest()));
    }
});

test('reads the v1 config and accepts v1 up to 4096 bytes', async () => {
    const d = await decode(transferV1({ computeUnitLimit: 200_000, priorityFeeLamports: 5_000n, heapSize: 64 * 1024 }));
    assert.deepEqual(d.message.config, { priorityFeeLamports: 5_000n, computeUnitLimit: 200_000, heapSize: 64 * 1024 });
    assert.equal((await decode(transfer(1, new Uint8Array(3000)))).message.version, 1);
});

test('encodes a message back to the same bytes', async () => {
    const all = [transfer(), transfer(0), transferWithTable(), transferV1({ priorityFeeLamports: 7n, computeUnitLimit: 9_000, heapSize: 64 * 1024 })];
    for (const tx of all) {
        const d = await decode(tx);
        assert.deepEqual(encode(d.message), d.messageBytes);
    }
});

test('a durable transaction starts with System AdvanceNonceAccount', async () => {
    const m = (await decode(transfer())).message;
    const nonce = { ...m.instructions[0], data: new Uint8Array([4, 0, 0, 0]) };
    assert.deepEqual([durable(m), durable({ ...m, instructions: [nonce] }), durable({ ...m, instructions: [m.instructions[0], nonce] })], [false, true, false]);
});

test('lists signatures the site already filled in', async () => {
    const d = await decode(patch(transfer(), 1, new Uint8Array(64).fill(7)));
    assert.deepEqual(d.signed, [PAYER]);
});

test('refuses malformed, non-canonical and oversized transactions', async () => {
    const tx = transfer();
    const v1 = transfer(1);
    const v1Message = v1.subarray(0, v1.length - 64);
    const v1Limited = transferV1({ computeUnitLimit: 200_000 });
    const v1LimitedMessage = v1Limited.subarray(0, v1Limited.length - 64);
    const cases: [Uint8Array, RegExp][] = [
        [new Uint8Array([1, 2, 3]), /malformed transaction/],
        [Uint8Array.from([...tx, 0]), /canonical/],
        [Uint8Array.from([...tx.subarray(0, KEY_COUNT), 0x83, 0x00, ...tx.subarray(KEY_COUNT + 1)]), /canonical/],
        [Uint8Array.from([0, ...v1Message]), /malformed transaction/],
        [Uint8Array.from([1, ...new Uint8Array(64), ...v1Message]), /malformed transaction/],
        [Uint8Array.from([1, ...new Uint8Array(64), ...v1LimitedMessage]), /canonical/], // Kit alone accepts this one
        [patch(tx, MESSAGE + 1, [1]), /no writable fee payer/],
        [patch(tx, RECIPIENT_KEY, new Uint8Array(32).fill(1)), /appears twice/],
        [patch(tx, PROGRAM_INDEX, [0]), /bad program index/],
        [transfer('legacy', new Uint8Array(1300)), /over 1232 bytes/],
        [patch(v1, V1_CONFIG_MASK, [0x20]), /unknown config bits/],
    ];
    for (const [bytes, reason] of cases) await assert.rejects(decode(bytes), refusedFor(reason), String(reason));
});

test('applies the runtime limits', async () => {
    const m = (await decode(transfer(1))).message;
    const keys = (n: number) => Array.from({ length: n }, (_, i) => key(i + 10));
    const cases: [Message, RegExp][] = [
        [{ ...m, header: { ...m.header, numSignerAccounts: 13 }, staticAccounts: keys(14) }, /12 signers/],
        [{ ...m, staticAccounts: keys(65) }, /64 accounts/],
        [{ ...m, instructions: Array(65).fill(m.instructions[0]) }, /64 instructions/],
        [{ ...m, instructions: [{ ...m.instructions[0], accountIndices: Array(256).fill(0) }] }, /255 accounts/],
        [{ ...m, config: { heapSize: 1000 } }, /heap/],
        [{ ...m, version: 0, lookups: [{ lookupTableAddress: TABLE, writableIndexes: [], readonlyIndexes: [] }] }, /empty lookup/],
    ];
    for (const [message, reason] of cases) assert.throws(() => sanitize(message), refusedFor(reason), String(reason));
});
