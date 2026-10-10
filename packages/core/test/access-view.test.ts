import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { Address } from '@solana/kit';

import { accessRows, type AccessNaming } from '../src/view/access.ts';
import { key } from './helpers.ts';

const [WALLET, MINT, DELEGATE, AUTHORITY, NONCE] = [key(1), key(2), key(3), key(4), key(5)];
const naming: AccessNaming = { wallet: WALLET, program: (a) => a, symbol: () => 'USDC', decimals: () => 6, who: (a: Address) => a, given: [], waiting: [] };

test('access in words: who has it named whole, for the screen to cut short', () => {
    const [permanent, nonce] = accessRows(
        [
            { kind: 'permanent', mint: MINT, to: DELEGATE },
            { kind: 'nonce', account: NONCE, nonce: 'n', authority: AUTHORITY },
        ],
        naming,
    );
    assert.equal(permanent.sub, `Its permanent delegate ${DELEGATE}, at any time`);
    assert.equal(nonce.sub, `It waits on a nonce, not a blockhash: only ${AUTHORITY} can cancel it`);
});
