import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { Address } from '@solana/kit';

import { key } from '@otus-wallet/core/test/helpers.ts';

// Session storage, played here: what the worker kept survives it, as the browser's does while it runs.
let stored: Record<string, unknown> = {};
let failing = false;
const chrome = {
    storage: {
        session: {
            get: async (k: string) => (failing ? Promise.reject(new Error('storage')) : { [k]: stored[k] }),
            set: async (part: Record<string, unknown>) => (failing ? Promise.reject(new Error('storage')) : void Object.assign(stored, structuredClone(part))),
        },
    },
};
Object.assign(globalThis, { chrome });
let restarts = 0;
const worker = async () => (await import(`../src/shell/tables.ts?worker=${restarts++}`)).mainnetTables as typeof import('../src/shell/tables.ts').mainnetTables;
const settle = () => new Promise((r) => setTimeout(r, 5));

test('a table kept outlives the worker; what storage holds that is not a table of addresses is left out', async () => {
    stored = {};
    const tables = await worker();
    assert.equal(await tables.get(key(1)), undefined);
    tables.set(key(1), [key(2), key(3)]);
    await settle();
    assert.deepEqual(await (await worker()).get(key(1)), [key(2), key(3)]);
    stored = { mainnetTables: [[key(4), [key(5)]], ['nope', [key(5)]], [key(6), ['nope']], [key(7), key(8)], 'garbage', [key(9), Array(257).fill(key(5))]] };
    const fresh = await worker();
    assert.deepEqual(await Promise.all([4, 6, 7, 9].map((n) => fresh.get(key(n)))), [[key(5)], undefined, undefined, undefined]);
    stored = { mainnetTables: 'garbage' };
    assert.equal(await (await worker()).get(key(4)), undefined);
});

test('at most 64 kept, the latest read or used; storage failing, they are kept in memory', async () => {
    stored = {};
    const tables = await worker();
    for (let n = 1; n <= 64; n++) tables.set(key(n), [key(200)]);
    await settle();
    await tables.get(key(1)); // used: no longer the oldest
    tables.set(key(65), [key(200)]);
    await settle();
    const kept = (stored.mainnetTables as [Address, Address[]][]).map(([t]) => t);
    assert.deepEqual([kept.length, kept.includes(key(1)), kept.includes(key(2)), kept.at(-1)], [64, true, false, key(65)]);
    failing = true;
    const memory = await worker();
    memory.set(key(70), [key(71)]);
    await settle();
    assert.deepEqual(await memory.get(key(70)), [key(71)]);
    failing = false;
});
