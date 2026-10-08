import assert from 'node:assert/strict';
import { test } from 'node:test';

import { DEFAULT_SETTINGS, explorerOf, type Settings } from '../src/settings.ts';

const SIGNATURE = '5WX9C5kCQNULGGrSHJBR1WDFyetVyekbUpe1KQ45p3zEBe6jVgSsJuMqLWijjTDcnaAK2518ZriktRMCNycnsNAG';

test('a transaction opens in the explorer chosen; Solscan when none is, or what is stored is not one', () => {
    const at = (explorer: unknown) => explorerOf({ ...DEFAULT_SETTINGS, explorer } as Settings).tx(SIGNATURE);
    assert.equal(at('solscan'), `https://solscan.io/tx/${SIGNATURE}`);
    assert.equal(at('solana'), `https://explorer.solana.com/tx/${SIGNATURE}`);
    assert.equal(at('orb'), `https://orbmarkets.io/tx/${SIGNATURE}`);
    for (const stored of [undefined, 'etherscan', 'toString', '__proto__', 7]) assert.equal(at(stored), `https://solscan.io/tx/${SIGNATURE}`);
});
