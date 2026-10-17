import assert from 'node:assert/strict';
import { test } from 'node:test';

import { accepted, accepting, TERMS } from '../src/terms.ts';

test('the terms are accepted only by a stored record of the current version or a later one', () => {
    assert.ok(accepted(accepting()));
    assert.ok(accepted({ version: TERMS + 1, at: 0 }));
    for (const stored of [null, undefined, {}, { version: TERMS - 1, at: 0 }, { version: String(TERMS) }, { version: NaN }, 'yes', TERMS, []]) assert.ok(!accepted(stored), JSON.stringify(stored));
});

test('accepting records the current version and the time in seconds', () => {
    assert.deepEqual(accepting(1_760_000_000_999), { version: TERMS, at: 1_760_000_000 });
});
