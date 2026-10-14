import assert from 'node:assert/strict';
import { test } from 'node:test';

import { TOKEN_PROGRAM_ADDRESS } from '@solana-program/token';

import { read } from '@otus-wallet/sdk/review/changes';
import type { Review } from '@otus-wallet/sdk/review/review';
import { decimalsOf } from '../src/shell/transaction.ts';
import { account, fakeChain, key } from '@otus-wallet/core/test/helpers.ts';

// A mint's 82 bytes: what matters here are its decimals (byte 44) and whether it is initialized (byte 45).
const mint = (decimals: number, initialized = true) => {
    const data = new Uint8Array(82);
    data[44] = decimals;
    data[45] = initialized ? 1 : 0;
    return data;
};

test('decimals come from each mint as the transaction leaves it, and only from initialized mints', async () => {
    const [opened, held, notMint, fetched, blank] = [key(40), key(41), key(42), key(43), key(44)];
    const before = account(opened, TOKEN_PROGRAM_ADDRESS, 1_461_600n, mint(0, false));
    const r = {
        // The transaction initializes `opened` with 9 decimals; before it, the account says 0 and is not initialized.
        changes: { fee: 5_000n, accounts: [{ address: opened, before: read(before), after: read(account(opened, TOKEN_PROGRAM_ADDRESS, 1_461_600n, mint(9))) }] },
        accounts: [
            { address: opened, state: before },
            { address: held, state: account(held, TOKEN_PROGRAM_ADDRESS, 1_461_600n, mint(6)) },
            { address: notMint, state: account(notMint, TOKEN_PROGRAM_ADDRESS, 2_039_280n, new Uint8Array(165)) }, // a token account
        ],
    } as unknown as Review;
    const chain = fakeChain([account(fetched, TOKEN_PROGRAM_ADDRESS, 1_461_600n, mint(2)), account(blank, TOKEN_PROGRAM_ADDRESS, 1_461_600n, mint(7, false))]);
    const decimals = await decimalsOf(r, [opened, held, notMint, fetched, blank], chain);
    assert.deepEqual(Object.fromEntries(decimals), { [opened]: 9, [held]: 6, [fetched]: 2 });
});
