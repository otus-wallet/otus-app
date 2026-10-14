import assert from 'node:assert/strict';
import { test } from 'node:test';

import { gate } from '../src/gate.ts';
import type { Request } from '@otus-wallet/core/intake.ts';
import { Refused } from '@otus-wallet/core/protocol.ts';
import { key } from '@otus-wallet/core/test/helpers.ts';

const request = (count: number): Request => ({
    kind: 'transaction',
    origin: 'https://jup.ag',
    account: key(1),
    chain: null,
    send: false,
    transactions: Array.from({ length: count }, () => new Uint8Array([1])),
});

test('up to ten transactions in one call, as one asks for one; eleven are refused', () => {
    for (const n of [1, 2, 10]) assert.equal(gate(request(n)).kind, 'transaction');
    assert.throws(() => gate(request(11)), new Refused('Otus signs at most 10 transactions in one request'));
});
