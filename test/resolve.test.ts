import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { Address } from '@solana/kit';

import type { Chain } from '../src/chain.ts';
import { Refused } from '../src/protocol.ts';
import { decode } from '../src/review/decode.ts';
import { LOOKUP_TABLE_PROGRAM, resolve, type Resolved } from '../src/review/resolve.ts';
import { account, fakeChain, lookupTable, PAYER, RECIPIENT, SYSTEM, TABLE, transfer, transferWithTable } from './helpers.ts';

const roles = (r: Resolved) => r.accounts.map((a) => [a.address, a.signer, a.writable, a.table]);
const table = (entries: Address[], owner: Address = LOOKUP_TABLE_PROGRAM) => account(TABLE, owner, 1n, lookupTable(entries));

test('static accounts take their roles from the header and their state from the chain', async () => {
    const r = await resolve(await decode(transfer()), fakeChain([account(PAYER, SYSTEM, 5_000_000n)]));
    assert.deepEqual(roles(r), [
        [PAYER, true, true, null],
        [RECIPIENT, false, true, null],
        [SYSTEM, false, false, null],
    ]);
    assert.equal(r.slot, 1n);
    assert.equal(r.accounts[0].state.exists, true);
    assert.equal(r.accounts[1].state.exists, false);
});

test('accounts from a lookup table follow the static ones', async () => {
    const r = await resolve(await decode(transferWithTable()), fakeChain([table([RECIPIENT])]));
    assert.deepEqual(roles(r), [
        [PAYER, true, true, null],
        [SYSTEM, false, false, null],
        [RECIPIENT, false, true, TABLE],
    ]);
});

test('refuses missing tables, missing entries and accounts loaded twice', async () => {
    const tx = await decode(transferWithTable());
    const cases: [Chain, RegExp][] = [
        [fakeChain([]), /not found/],
        [fakeChain([table([RECIPIENT], SYSTEM)]), /not found/],
        [fakeChain([table([])]), /no entry 0/],
        [fakeChain([table([PAYER])]), /appears twice/],
    ];
    for (const [chain, reason] of cases) {
        await assert.rejects(resolve(tx, chain), (e) => e instanceof Refused && reason.test(e.message), String(reason));
    }
});
