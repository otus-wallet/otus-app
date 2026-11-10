import assert from 'node:assert/strict';
import { test } from 'node:test';

import { amount } from '../src/money.ts';

test('a balance is cut to six decimals, never rounded up to more than is held', () => {
    const shown = (units: bigint, decimals: number) => amount({ units, decimals });
    assert.equal(shown(999_999_600n, 9), '0.999999');
    assert.equal(shown(1_999_999_999n, 9), '1.999999');
    assert.equal(shown(1_234_567n, 6), '1.234567'); // exact, whatever a float would make of it
    assert.equal(shown(1_500_000_000n, 9), '1.5');
    assert.equal(shown(1_234_567_000_000n, 6), '1,234,567');
    assert.equal(shown(100n, 9), '0'); // under what is shown
    assert.equal(shown(0n, 9), '0');
    assert.equal(shown(42n, 0), '42');
    assert.equal(shown(18_446_744_073_709_551_615n, 0), '18,446,744,073,709,551,615'); // a u64 whole, past what a float holds
    assert.equal(shown(18_446_744_073_709_551_615n, 9), '18,446,744,073.709551');
});
