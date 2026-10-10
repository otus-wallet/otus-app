import assert from 'node:assert/strict';
import { test } from 'node:test';

import { address } from '@solana/kit';

import { atAddresses } from '../src/view/names.ts';

const A = address('2apBGMsS6ti9RyF5TwQTDswXBWskiJP2LD4cUEDqYJjk');
const B = address('AxJkHRY3puoofyj7Pn512M1SGBgWroXMkEdNPQypkzbu');
const SYSTEM = address('11111111111111111111111111111111'); // 32 characters, the shortest

test('words split around each whole address, the addresses at the odd places', () => {
    assert.deepEqual(atAddresses(`Only ${A} (you) can withdraw from ${B}`), ['Only ', A, ' (you) can withdraw from ', B, '']);
    assert.deepEqual(atAddresses(A), ['', A, '']);
    assert.deepEqual(atAddresses(`(${A}), ${SYSTEM}.`), ['(', A, '), ', SYSTEM, '.']); // punctuation around is not the address
    assert.deepEqual(atAddresses('Fee 0.000005 SOL, paid by Ana'), ['Fee 0.000005 SOL, paid by Ana']);
    assert.deepEqual(atAddresses(''), ['']);
});

test('what only looks like an address stays in the words', () => {
    const signature = '5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUW';
    assert.deepEqual(atAddresses(`Signature ${signature}`), [`Signature ${signature}`]); // longer than 44: no address inside it
    assert.deepEqual(atAddresses(`x${A}`), [`x${A}`]); // part of a longer word
    assert.deepEqual(atAddresses(A.slice(0, 31)), [A.slice(0, 31)]); // too short
    assert.deepEqual(atAddresses('1'.repeat(44)), ['1'.repeat(44)]); // base58, but not 32 bytes
    assert.deepEqual(atAddresses(`${A.slice(0, 20)}0${A.slice(21)}`), [`${A.slice(0, 20)}0${A.slice(21)}`]); // a character base58 has not
    assert.deepEqual(atAddresses(`${A}…`), ['', A, '…']);
});

test('hostile words: long, with no address, or with many', () => {
    const long = 'z'.repeat(100_000);
    const at = Date.now();
    assert.deepEqual(atAddresses(long), [long]);
    assert.ok(Date.now() - at < 1000);
    const many = Array.from({ length: 1000 }, () => A).join(' ');
    assert.equal(atAddresses(many).filter((_, i) => i % 2).length, 1000);
    assert.deepEqual(atAddresses(`${A}‮${B}`), ['', A, '‮', B, '']); // split as given; what the words hold is the words' own business
});
