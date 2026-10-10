import assert from 'node:assert/strict';
import { test } from 'node:test';

import { OTUS_RPC } from '../src/settings.ts';
import { cachedToken, search, tokens } from '../src/tokens.ts';
import { key } from './helpers.ts';

// Jupiter, as a stub: it knows a fake "USDC" and nothing else.
const FAKE_USDC = 'Fake1111111111111111111111111111111111111111';
const OTHER = key(43);

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
    t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify([key(41), key(42)].map((id, i) => ({ id, name: 'USD Coin', symbol: ['USDC ', 'USDС'][i], isVerified: true })))));
    const read = await tokens([key(41), key(42)], true);
    assert.deepEqual([...read.values()].map((x) => x?.verified), [false, false]);
});

test("Otus's server is asked only while mainnet is read through it; otherwise Jupiter itself, keyless", async (t) => {
    const asked: string[] = [];
    t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => (asked.push(`${init.method} ${new URL(url).origin}${new URL(url).pathname}`), new Response('[]')));
    await tokens(['Through111111111111111111111111111111111111'], true);
    await tokens([key(44)], false);
    await search('bonk', true);
    // Posted to Otus's server: an extension's page sends its Origin, which the server asks for, with a POST only.
    assert.deepEqual(asked, [`POST ${OTUS_RPC}/tokens`, 'GET https://api.jup.ag/tokens/v2/search', `POST ${OTUS_RPC}/tokens`]);
});

test('a search by words asks for them as typed, reads each answer with care, and keeps what it found', async (t) => {
    const asked: string[] = [];
    const FOUND = 'Found111111111111111111111111111111111111111';
    t.mock.method(globalThis, 'fetch', async (url: string) => {
        asked.push(new URL(url).searchParams.get('query') ?? '');
        return new Response(JSON.stringify([{ id: FOUND, name: 'Jito‮ Staked SOL', symbol: 'JitoSOL', isVerified: true, decimals: 9 }, { name: 'no id' }, { id: 'not a mint', symbol: 'X' }, 7]));
    });
    assert.deepEqual(await search('   ', true), []);
    const found = await search(' jito sol ', true);
    assert.deepEqual(asked, ['jito sol']);
    assert.equal(found.length, 1);
    assert.equal(found[0].name, 'Jito Staked SOL');
    assert.equal(cachedToken(FOUND)?.symbol, 'JitoSOL');
});

test('a search answered with anything but a list is an error, never read', async (t) => {
    t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ tokens: [] })));
    await assert.rejects(search('bonk', true), /something else/);
});

test("a verified token's icon comes through Otus's server while mainnet is read through it, as Jupiter gave it otherwise", async (t) => {
    const VERIFIED = key(45);
    const OTHER_WAY = key(46);
    t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify([VERIFIED, OTHER_WAY, key(47)].map((id, i) => ({ id, symbol: 'T', isVerified: i < 2, icon: 'https://example.com/t.png' })))));
    assert.equal((await tokens([VERIFIED], true)).get(VERIFIED)?.icon, `${OTUS_RPC}/icon/${VERIFIED}`);
    assert.equal((await tokens([OTHER_WAY], false)).get(OTHER_WAY)?.icon, 'https://example.com/t.png');
    assert.equal((await search('t', true)).find((x) => x.id === key(47))?.icon, 'https://example.com/t.png', 'unverified: left as it is, and never shown');
});

test('a supply is kept only when both counts are numbers and no more circulates than there is', async (t) => {
    const ids = [key(48), key(49), key(50), key(51)];
    const supplies = [{ totalSupply: 635_536_709.6, circSupply: 588_792_064.7 }, { totalSupply: 10, circSupply: 11 }, { totalSupply: '10', circSupply: 5 }, { totalSupply: 10 }];
    t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify(ids.map((id, i) => ({ id, symbol: 'T', isVerified: true, ...supplies[i] })))));
    const read = await tokens(ids, true);
    assert.deepEqual(ids.map((id) => read.get(id)?.supply), [{ total: 635_536_709.6, circulating: 588_792_064.7 }, null, null, null]);
});

test('a market is kept count by count: a cap not below 0, whole holders, a share from 0 to 100, liquidity not below 0, a pool since Solana began', async (t) => {
    const ids = [key(52), key(53), key(54)];
    const answers = [
        { mcap: 1_241_445_666.9, holderCount: 838_628, liquidity: 5_602_336.3, audit: { topHoldersPercentage: 15.44 }, firstPool: { createdAt: '2024-01-29T17:33:29Z' } },
        { mcap: -5, holderCount: 1.5, liquidity: -1, audit: { topHoldersPercentage: 101 }, firstPool: { createdAt: '2019-01-01T00:00:00Z' } },
        { mcap: Infinity, holderCount: '9', liquidity: 'lots', audit: 'none', firstPool: { createdAt: 'yesterday' } },
    ];
    t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify(ids.map((id, i) => ({ id, symbol: 'T', isVerified: true, ...answers[i] })))));
    const read = await tokens(ids, true);
    assert.deepEqual(read.get(ids[0])?.market, { cap: 1_241_445_666.9, holders: 838_628, topHolders: 15.44, liquidity: 5_602_336.3, firstPool: Date.UTC(2024, 0, 29, 17, 33, 29) });
    assert.equal(read.get(ids[1])?.market, null); // none of it fits
    assert.equal(read.get(ids[2])?.market, null);
});
