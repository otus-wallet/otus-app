import assert from 'node:assert/strict';
import { test } from 'node:test';

import { address } from '@solana/kit';

import { addressesIn, apart, atAddresses, cutAmong, endsYours, nameOr } from '../src/view/names.ts';

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
    // Cut to fit, what is left of an address may still read as another one: one an ellipsis ends is not taken.
    assert.deepEqual(atAddresses(`${A.slice(0, 43)}…`), [`${A.slice(0, 43)}…`]);
    assert.deepEqual(atAddresses(`${A}…`), [`${A}…`]);
    // Bytes in hex: base58 has every hex character, but no address is made of them alone.
    const hex = 'c4f1b9e2d3a7568190fe2b3c4d5e6f708192a3b4c5d6e7f8';
    for (let n = 32; n <= 44; n++) assert.deepEqual(atAddresses(`data ${hex.slice(0, n)}`), [`data ${hex.slice(0, n)}`]);
});

test('" (you)" tags only your wallet\'s address, whole, right before it', () => {
    assert.equal(endsYours(`paid by ${A}`, A), true);
    assert.equal(endsYours(A, A), true);
    assert.equal(endsYours(`paid by ${B}`, A), false); // another address: words a program wrote can say " (you)" too
    assert.equal(endsYours('Refund to you', A), false);
    assert.equal(endsYours(`${A} and more`, A), false); // not right before it
    assert.equal(endsYours(`x${A}`, A), false); // part of a longer word
    assert.equal(endsYours(`paid by ${A}`, null), false); // no wallet to tag
    assert.equal(endsYours('', A), false);
});

test("someone else's name for an address, unless it holds an address of its own", () => {
    assert.equal(nameOr('PYUSD', A), 'PYUSD');
    assert.equal(nameOr('', A), A);
    assert.equal(nameOr(null, A), A);
    assert.equal(nameOr(undefined, A), A);
    assert.equal(nameOr(B, A), A); // a symbol that is an address: cut short, it would pass for one
    assert.equal(nameOr(`USD ${B}`, A), A);
    assert.equal(nameOr('11111111', A), '11111111'); // too short to be one
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

test("a view's addresses, wherever its words hold them, but where bytes are", () => {
    const view = { account: { address: A }, notes: [`to ${B}`, 'none'], deep: { more: [{ text: `${A} and ${SYSTEM}` }] }, hash: B, wire: A, count: 3 };
    assert.deepEqual(addressesIn(view, new Set(['hash', 'wire'])), [A, B, A, SYSTEM]);
    assert.deepEqual(addressesIn(null), []);
});

test('addresses that look alike, cut as far as where they part; the rest four a side', () => {
    const like = `${A.slice(0, 6)}${B.slice(6, -5)}${A.slice(-5)}`; // A's ends, another middle
    const cut = cutAmong([A, like, B]);
    assert.notEqual(cut(A), cut(like));
    assert.deepEqual([cut(A), cut(like)], [apart(A, like), apart(like, A)]);
    assert.equal(cut(B), `${B.slice(0, 4)}…${B.slice(-4)}`);
    assert.equal(cutAmong([B])(like), `${like.slice(0, 4)}…${like.slice(-4)}`); // nothing alike among them
});
