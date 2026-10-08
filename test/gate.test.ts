import assert from 'node:assert/strict';
import { test } from 'node:test';

import { gate } from '../src/gate.ts';
import type { Request } from '../src/intake.ts';
import { Refused } from '../src/protocol.ts';
import { DEFAULT_SETTINGS } from '../src/settings.ts';
import { key } from './helpers.ts';

const request = (count: number): Request => ({
    kind: 'transaction',
    origin: 'https://jup.ag',
    account: key(1),
    chain: null,
    send: false,
    transactions: Array.from({ length: count }, () => new Uint8Array([1])),
});

test('one transaction per call unless sign all is on', () => {
    assert.equal(gate(request(1), DEFAULT_SETTINGS).kind, 'transaction');
    assert.throws(() => gate(request(2), DEFAULT_SETTINGS), Refused);
    assert.equal(gate(request(2), { ...DEFAULT_SETTINGS, signAll: true }).kind, 'transaction');
});
