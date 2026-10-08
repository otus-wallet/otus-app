import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { Address } from '@solana/kit';

import type { Simulation } from '../src/chain.ts';
import { decode } from '../src/review/decode.ts';
import { LOOKUP_TABLE_PROGRAM, resolve } from '../src/review/resolve.ts';
import { simulate } from '../src/review/simulate.ts';
import { account, fakeChain, lookupTable, PAYER, RECIPIENT, TABLE, transfer, transferWithTable } from './helpers.ts';

test('watches the writable accounts, from the slot resolve read', async () => {
    const r = await resolve(await decode(transfer()), fakeChain([]));
    const asked: { watch: readonly Address[]; slot: bigint }[] = [];
    const chain = fakeChain([]);
    await simulate(r, {
        ...chain,
        simulate: (tx, watch, slot) => {
            asked.push({ watch, slot });
            return chain.simulate(tx, watch, slot);
        },
    });
    assert.deepEqual(asked, [{ watch: [PAYER, RECIPIENT], slot: 1n }]);
});

test('refuses a simulation that does not match the transaction', async () => {
    const r = await resolve(await decode(transferWithTable()), fakeChain([account(TABLE, LOOKUP_TABLE_PROGRAM, 1n, lookupTable([RECIPIENT]))]));
    const wrong: Partial<Simulation>[] = [{ after: [] }, { loaded: [PAYER] }];
    for (const simulation of wrong) await assert.rejects(simulate(r, fakeChain([], [], simulation)), /does not match/);
    await simulate(r, fakeChain([], [], { loaded: [RECIPIENT] }));
});
