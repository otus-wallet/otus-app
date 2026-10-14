import assert from 'node:assert/strict';
import { test } from 'node:test';

import { TOKEN_PROGRAM_ADDRESS } from '@solana-program/token';

import { read } from '@otus-wallet/sdk/review/changes';
import type { Review } from '@otus-wallet/sdk/review/review';
import { decimalsOf, disagree } from '../src/shell/transaction.ts';
import { account, fakeChain, key, SYSTEM, tokenAccountData } from '@otus-wallet/core/test/helpers.ts';

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

test('read again elsewhere, a review disagrees on whose an account is, on what yours hold, or on its tables; not on others’ balances', () => {
    const [me, mine, pool, theirs, mint] = [key(50), key(51), key(52), key(53), key(54)];
    const token = (at: typeof me, owner: typeof me, amount: bigint) => account(at, TOKEN_PROGRAM_ADDRESS, 2_039_280n, tokenAccountData({ mint, owner, amount }));
    const states = [account(me, SYSTEM, 5_000_000n), token(mine, me, 1_000n), token(pool, theirs, 50_000n)];
    const r = { accounts: states.map((state) => ({ address: state.address, writable: true, state })), assessment: { mine: new Set([me, mine]) } } as unknown as Review;
    const again = (changed: Partial<Record<number, ReturnType<typeof account>>>) => states.map((s, i) => ({ address: s.address, state: changed[i] ?? s }));
    assert.equal(disagree(r, again({}), me), false);
    assert.equal(disagree(r, again({ 2: token(pool, theirs, 49_000n) }), me), false); // a pool's balance moves by the block
    assert.equal(disagree(r, again({ 1: token(mine, me, 999_999n) }), me), true); // yours held more
    assert.equal(disagree(r, again({ 0: account(me, SYSTEM, 9_000_000n) }), me), true);
    assert.equal(disagree(r, again({ 2: token(pool, me, 50_000n) }), me), true); // the "pool" is yours
    assert.equal(disagree(r, again({ 1: account(mine, SYSTEM, 1n) }), me), true); // not a token account at all
    assert.equal(disagree(r, [...again({}).slice(0, 2), { address: theirs, state: states[2] }], me), true); // a table entry differs
    assert.equal(disagree(r, again({}).slice(0, 2), me), true);
});
