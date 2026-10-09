import assert from 'node:assert/strict';
import { test } from 'node:test';

import { OTUS_RPC } from '../src/settings.ts';
import { cachedToken, search, tokens } from '../src/tokens.ts';

// Jupiter, as a stub: it knows a fake "USDC" and nothing else.
const FAKE_USDC = 'Fake1111111111111111111111111111111111111111';
const OTHER = 'Other111111111111111111111111111111111111111';

test('each lookup answers only for the mints it asks about, though earlier ones are kept', async (t) => {
    const asked: string[] = [];
    t.mock.method(globalThis, 'fetch', async (url: string) => {
        asked.push(new URL(url).searchParams.get('query') ?? '');
        return new Response(JSON.stringify([{ id: FAKE_USDC, name: 'USD Coin', symbol: 'USDC', isVerified: false }]));
    });
    const first = await tokens([FAKE_USDC], true);
    assert.equal(first.get(FAKE_USDC)?.symbol, 'USDC');
    // A later transaction's tokens: the fake one seen before is not among them, so it cannot warn about it.
    const later = await tokens([OTHER], true);
    assert.deepEqual([...later.keys()], [OTHER]);
    assert.equal(later.get(OTHER), null);
    // Asked again, the fake one comes from what was kept, without asking Jupiter twice.
    assert.equal((await tokens([FAKE_USDC], true)).get(FAKE_USDC)?.symbol, 'USDC');
    assert.deepEqual(asked, [FAKE_USDC, OTHER]);
});

test('a token named as a well-known one at another address is never verified, whatever Jupiter says; the real one is', async (t) => {
    const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
    const FORGED = 'Forged11111111111111111111111111111111111111';
    t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify([USDC, FORGED].map((id) => ({ id, name: 'USD Coin', symbol: 'usdc', isVerified: true })))));
    const found = await tokens([USDC, FORGED], true);
    assert.deepEqual([found.get(USDC)?.verified, found.get(FORGED)?.verified], [true, false]);
    // As it reads: with a space after it, or a Cyrillic С.
    t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify(['Spaced1111111111111111111111111111111111111', 'Cyrillic111111111111111111111111111111111111'].map((id, i) => ({ id, name: 'USD Coin', symbol: ['USDC ', 'USDС'][i], isVerified: true })))));
    const read = await tokens(['Spaced1111111111111111111111111111111111111', 'Cyrillic111111111111111111111111111111111111'], true);
    assert.deepEqual([...read.values()].map((x) => x?.verified), [false, false]);
});

test("Otus's server is asked only while mainnet is read through it; otherwise Jupiter itself, keyless", async (t) => {
    const asked: string[] = [];
    t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => (asked.push(`${init.method} ${new URL(url).origin}${new URL(url).pathname}`), new Response('[]')));
    await tokens(['Through111111111111111111111111111111111111'], true);
    await tokens(['Own11111111111111111111111111111111111111111'], false);
    await search('bonk', true);
    // Posted to Otus's server: an extension's page sends its Origin, which the server asks for, with a POST only.
    assert.deepEqual(asked, [`POST ${OTUS_RPC}/tokens`, 'GET https://api.jup.ag/tokens/v2/search', `POST ${OTUS_RPC}/tokens`]);
});

test('a search by words asks for them as typed, reads each answer with care, and keeps what it found', async (t) => {
    const asked: string[] = [];
    const FOUND = 'Found111111111111111111111111111111111111111';
    t.mock.method(globalThis, 'fetch', async (url: string) => {
        asked.push(new URL(url).searchParams.get('query') ?? '');
        return new Response(JSON.stringify([{ id: FOUND, name: 'Jito‮ Staked SOL', symbol: 'JitoSOL', isVerified: true, decimals: 9 }, { name: 'no id' }, 7]));
    });
    assert.deepEqual(await search('   ', true), []);
    const found = await search(' jito sol ', true);
    assert.deepEqual(asked, ['jito sol']);
    assert.equal(found.length, 1);
    assert.equal(found[0].name, 'Jito Staked SOL');
    assert.equal(cachedToken(FOUND)?.symbol, 'JitoSOL');
});
