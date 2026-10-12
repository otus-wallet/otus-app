import assert from 'node:assert/strict';
import { test } from 'node:test';

import { isAddress, type Address } from '@solana/kit';

import type { Activity, Told } from '@otus-wallet/sdk/activity/summary';
import { short } from '@otus-wallet/sdk/format';
import { cuts } from '../src/view/activity.ts';
import { apart } from '../src/view/names.ts';
import { key } from './helpers.ts';

// What the words say is the SDK's (rows(), tested there); here, how the page cuts the addresses in them.
const WALLET = key(31);
const FRIEND = key(32);
const base = { signatures: {}, slot: 1n, time: 1_791_236_675, error: null, fee: 5000n, payer: WALLET, rent: { yours: 0n, theirs: 0n, opened: 0n }, created: [] as Address[], instructions: [] as Told[], held: [], fresh: [] as Address[], staked: 0n, signed: true, programs: [] as Address[], main: null, squads: [], memo: null, moves: [] };

test('a copy of an address, on the page or known: both cut as far as where they part', () => {
    // A copy: the real address's first and last four characters around another's middle, as poisoners grind them.
    const real = key(60);
    const copy = Array.from({ length: 30 }, (_, i) => `${real.slice(0, 4)}${key(61 + i).slice(4, -4)}${real.slice(-4)}`).find((a) => a !== real && isAddress(a)) as Address;
    const dust: Activity = { ...base, signature: 'dust', kind: 'receive', other: copy, payer: copy };
    const paid: Activity = { ...base, signature: 'paid', kind: 'receive', other: real, payer: real };
    const cut = cuts([dust, paid], []);
    assert.equal(short(copy), short(real)); // where four a side gives both the same
    assert.deepEqual([cut(copy), cut(real), cut(FRIEND)], [apart(copy, real), apart(real, copy), short(FRIEND)]);
    assert.equal(cuts([dust], [real])(copy), apart(copy, real)); // like one known
    assert.equal(cuts([dust, { unreadable: 'no meta' }], [])(copy), short(copy)); // alike nothing
});

test('several copies of one address: each cut as far as where it parts from every one alike', () => {
    const real = key(60);
    const made = (head: number, from: number) => Array.from({ length: 40 }, (_, i) => `${real.slice(0, head)}${key(from + i).slice(head, -4)}${real.slice(-4)}`).find((a) => a !== real && isAddress(a)) as Address;
    const [near, far] = [made(7, 100), made(4, 200)]; // one shares seven characters at the head, one four
    const cut = cuts([], [real, far, near]); // the one sharing less first, as the page may list them
    const shared = (a: string, b: string) => {
        let h = 0;
        while (a[h] === b[h]) h++;
        let t = 0;
        while (a[a.length - 1 - t] === b[b.length - 1 - t]) t++;
        return [h, t];
    };
    for (const a of [real, near, far]) {
        const [head, tail] = cut(a).split('…');
        for (const b of [real, near, far].filter((x) => x !== a)) {
            const [h, t] = shared(a, b);
            assert.ok(head.length > h && tail.length > t, `${cut(a)} must part from ${b}`); // where they part, shown
        }
    }
    assert.equal(new Set([real, near, far].map(cut)).size, 3);
    assert.equal(cuts([], [key(5)])(near), short(near)); // alike nothing known or on the page: four a side
});
