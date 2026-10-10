import assert from 'node:assert/strict';
import { test } from 'node:test';

import { TOKEN_PROGRAM_ADDRESS } from '@solana-program/token';

import { holdings } from '../src/holdings.ts';
import { key } from './helpers.ts';

test('a token account whose mint is no address is no token', async (t) => {
    const GOOD = key(70);
    const account = (mint: string, amount: string) => ({
        pubkey: key(71),
        account: { data: { parsed: { info: { mint, owner: key(72), tokenAmount: { amount, decimals: 0 } }, type: 'account' }, program: 'spl-token', space: 165 }, executable: false, lamports: 1, owner: TOKEN_PROGRAM_ADDRESS, rentEpoch: 0, space: 165 },
    });
    t.mock.method(globalThis, 'fetch', async (_: string, init: { body: string }) => {
        const call = JSON.parse(init.body);
        const tokens = call.params[1]?.programId === TOKEN_PROGRAM_ADDRESS ? [account('x#', '100'), account('', '5'), account(GOOD, '7')] : [];
        const result = call.method === 'getBalance' ? { context: { slot: 1 }, value: 5 } : { context: { slot: 1 }, value: tokens };
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: call.id, result }));
    });
    const held = await holdings('http://127.0.0.1:1', key(72), false);
    assert.deepEqual(held.assets.filter((a) => !a.native).map((a) => a.mint), [GOOD]);
});
