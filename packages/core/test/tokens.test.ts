import assert from 'node:assert/strict';
import { test } from 'node:test';

import { install, type Platform } from '../src/platform.ts';
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

test('a mint asked while another lookup asks it waits for that answer, not asking twice; one that failed is asked again', async (t) => {
    const asked: string[] = [];
    const answers: ((r: Response) => void)[] = [];
    t.mock.method(globalThis, 'fetch', (url: string) => (asked.push(new URL(url).searchParams.get('query') ?? ''), new Promise<Response>((done) => answers.push(done))));
    const early = tokens([key(70)], true);
    const later = tokens([key(70), key(71)], true);
    await new Promise((done) => setImmediate(done));
    // Its own mint answered, the later lookup still waits for the one the early lookup asks.
    answers[1](new Response('[]'));
    await new Promise((done) => setImmediate(done));
    assert.equal(await Promise.race([later.then(() => 'answered'), Promise.resolve('waiting')]), 'waiting');
    answers[0](new Response(JSON.stringify([{ id: key(70), name: 'Early', symbol: 'ERL', isVerified: false }])));
    assert.equal((await early).get(key(70))?.symbol, 'ERL');
    assert.deepEqual([...(await later)].map(([m, i]) => [m, i?.symbol ?? null]), [[key(70), 'ERL'], [key(71), null]]);
    assert.deepEqual(asked, [key(70), key(71)] as string[]);
    t.mock.method(globalThis, 'fetch', async (url: string) => (asked.push(new URL(url).searchParams.get('query') ?? ''), new Response('', { status: 500 })));
    assert.equal((await tokens([key(72)], true)).get(key(72)), null);
    await tokens([key(72)], true);
    assert.deepEqual(asked.slice(2), [key(72), key(72)]);
});

test('a mint waits only for its own search: one asked in the first of two is answered before the second is', async (t) => {
    const many = Array.from({ length: 101 }, (_, i) => `${key(73).slice(0, -4)}${String(i).padStart(4, 'A')}`).map((m) => m.replace(/[0OIl]/g, 'A'));
    const answers: ((r: Response) => void)[] = [];
    t.mock.method(globalThis, 'fetch', () => new Promise<Response>((done) => answers.push(done)));
    const all = tokens(many, true);
    const first = tokens([many[0]], true);
    await new Promise((done) => setImmediate(done));
    answers[0](new Response('[]'));
    await new Promise((done) => setImmediate(done));
    assert.equal(answers.length, 2); // the second search, once the first is answered
    assert.equal(await Promise.race([first.then(() => 'answered'), new Promise((done) => setImmediate(() => done('waiting')))]), 'answered');
    answers[1](new Response('[]'));
    assert.equal((await all).size, 101);
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

test('a market or supply past what any token reaches, -0, or odd shapes: dropped field by field, the price and name kept', async (t) => {
    const ids = [key(55), key(56), key(57), key(58), key(59), key(60)];
    // As raw text: JSON.stringify would send Infinity as null and -0 as 0.
    const answers = [
        `{ "mcap": 1e308, "holderCount": 9e15, "liquidity": 1e400, "audit": { "topHoldersPercentage": 100 }, "firstPool": { "createdAt": "2099-01-01T00:00:00Z" }, "totalSupply": 1e30, "circSupply": 1 }`,
        `{ "mcap": -0, "holderCount": -1, "liquidity": -0, "audit": { "topHoldersPercentage": 0 }, "totalSupply": 10, "circSupply": -0 }`,
        `{ "audit": null, "firstPool": [], "totalSupply": 10, "circSupply": 10.000000001 }`,
        `{ "audit": { "__proto__": { "topHoldersPercentage": 5 } }, "firstPool": { "constructor": { "createdAt": "2024-01-01T00:00:00Z" } } }`,
        `{ "holderCount": 5, "totalSupply": 10, "circSupply": 10 }`,
        `{ "mcap": "1", "holderCount": null }`,
    ];
    const body = `[${answers.map((a, i) => `{ "id": "${ids[i]}", "symbol": "T${i}", "isVerified": true, "usdPrice": 2, ${a.slice(1)}`).join(',')}]`;
    t.mock.method(globalThis, 'fetch', async () => new Response(body));
    const read = await tokens(ids, true);
    assert.deepEqual(read.get(ids[0])?.market, { cap: null, holders: null, topHolders: 100, liquidity: null, firstPool: null });
    assert.equal(read.get(ids[0])?.supply, null);
    const zero = read.get(ids[1]);
    assert.deepEqual(zero?.market, { cap: 0, holders: null, topHolders: 0, liquidity: 0, firstPool: null });
    assert.ok(Object.is(zero?.market?.cap, 0) && Object.is(zero?.market?.liquidity, 0), 'no -0');
    assert.ok(Object.is(zero?.supply?.circulating, 0));
    assert.deepEqual(read.get(ids[2])?.supply, { total: 10, circulating: 10 }); // float noise past the total: the total
    assert.equal(read.get(ids[2])?.market, null);
    assert.equal(read.get(ids[3])?.market, null);
    assert.deepEqual(read.get(ids[4])?.supply, { total: 10, circulating: 10 });
    assert.equal(read.get(ids[5])?.market, null);
    for (const [i, id] of ids.entries()) assert.deepEqual([read.get(id)?.usdPrice, read.get(id)?.symbol], [2, `T${i}`], `price and name of ${i}`);
});

test('an answer that is not a list of tokens prices none', async (t) => {
    t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ tokens: [{ id: key(61), usdPrice: 1 }] })));
    const read = await tokens([key(61)], true).catch(() => null);
    assert.equal(read?.get(key(61))?.usdPrice ?? null, null);
});

test('a worker keeps what Jupiter said a while: woken again, a fresh answer is not asked twice; an old or garbled one is', async (t) => {
    const session: Record<string, unknown> = {};
    install({ storage: { session: { get: async (k: string) => ({ [k]: session[k] }), set: async (part: object) => void Object.assign(session, structuredClone(part)) } } } as unknown as Platform);
    const asked: string[] = [];
    t.mock.method(globalThis, 'fetch', async (url: string) => {
        const query = new URL(url).searchParams.get('query') ?? '';
        asked.push(query);
        return new Response(JSON.stringify(query.split(',').filter((m) => m === key(80)).map((id) => ({ id, name: 'Kept', symbol: 'KPT', isVerified: true, icon: 'https://example.com/kpt.png' }))));
    });
    const worker = async (n: number) => (await import(`../src/tokens.ts?worker=${n}`)) as typeof import('../src/tokens.ts');
    const one = await worker(1);
    await one.keepTokens();
    await one.tokens([key(80), key(81)], true);
    await new Promise((done) => setImmediate(done));
    // Woken again: both answered from what was kept, as Jupiter's were read, its icon through Otus's server.
    const two = await worker(2);
    await two.keepTokens();
    const again = await two.tokens([key(80), key(81)], true);
    assert.deepEqual([asked.length, again.get(key(80))?.symbol, again.get(key(80))?.icon, again.get(key(81))], [1, 'KPT', `${OTUS_RPC}/icon/${key(80)}`, null]);
    // Older than ten minutes, an answer for another mint, or garbled: asked again.
    session.tokens = [[key(80), { id: key(80), name: 'Kept', symbol: 'KPT' }, Date.now() - 11 * 60_000, true], [key(81), { id: key(82), name: 'Other', symbol: 'OTH' }, Date.now(), true], 'garbage', [key(83), null, Date.now(), 'yes'], [key(84), null, Date.now(), true]];
    const three = await worker(3);
    await three.keepTokens();
    await three.tokens([key(80), key(81), key(83), key(84)], true);
    assert.deepEqual(asked.at(-1)?.split(',').sort(), [key(80), key(81), key(83)].sort()); // key(84): fresh, unknown to Jupiter
    // Dated ahead, or kept from a search the other way (straight to Jupiter, so its icon is not through Otus's): asked.
    session.tokens = [[key(85), null, Date.now() + 60_000, true], [key(86), null, Date.now(), false]];
    const four = await worker(4);
    await four.keepTokens();
    await four.tokens([key(85), key(86)], true);
    assert.deepEqual(asked.at(-1)?.split(',').sort(), [key(85), key(86)].sort());
});

test('a kept name, however old, names a mint at once, asked the same way only; the mint is asked again all the same', async (t) => {
    const { platform } = await import('../src/platform.ts'); // the session storage installed above
    const asked: string[] = [];
    t.mock.method(globalThis, 'fetch', async (url: string) => {
        asked.push(new URL(url).searchParams.get('query') ?? '');
        return new Response('[]');
    });
    const hour = 60 * 60_000;
    await platform.storage.session.set({ tokens: [
        [key(87), { id: key(87), name: 'Old', symbol: 'OLD', isVerified: true }, Date.now() - hour, true],
        [key(88), null, Date.now() - hour, true], // Jupiter did not know it
        [key(89), { id: key(89), name: 'Ahead', symbol: 'AHD', isVerified: true }, Date.now() + hour, true],
        [key(91), { id: key(91), name: 'Fake', symbol: 'USDC', isVerified: true }, Date.now(), true], // a borrowed name
    ] });
    const popup = (await import(`../src/tokens.ts?worker=${'popup'}`)) as typeof import('../src/tokens.ts');
    await popup.keepTokens();
    assert.deepEqual(popup.keptName(key(87), true), { symbol: 'OLD', verified: true });
    assert.deepEqual([popup.keptName(key(87), false), popup.keptName(key(88), true), popup.keptName(key(89), true)], [null, null, null]);
    assert.deepEqual(popup.keptName(key(91), true), { symbol: 'USDC', verified: false }); // read again with the same care
    assert.equal(popup.cachedToken(key(87)), null); // nothing else of it: no price, no icon
    await popup.tokens([key(87)], true);
    assert.deepEqual(asked, [key(87)]); // old: asked again
});

test('a page keeping answers only for their names asks again for a fresh one, its name kept all the same', async (t) => {
    const { platform } = await import('../src/platform.ts');
    const asked: string[] = [];
    t.mock.method(globalThis, 'fetch', async (url: string) => {
        asked.push(new URL(url).searchParams.get('query') ?? '');
        return new Response('[]');
    });
    await platform.storage.session.set({ tokens: [[key(93), { id: key(93), name: 'Fresh', symbol: 'FRS', isVerified: true, usdPrice: 2 }, Date.now(), true]] });
    const page = (await import(`../src/tokens.ts?worker=${'names'}`)) as typeof import('../src/tokens.ts');
    await page.keepTokens(Date.now, false);
    assert.deepEqual(page.keptName(key(93), true), { symbol: 'FRS', verified: true });
    await page.tokens([key(93)], true);
    assert.deepEqual(asked, [key(93)]); // fresh, and asked again: its price as it is now
});

test('what is kept of an answer is what is read of it: words cut as read, numbers only, no long icon address', async (t) => {
    const huge = { id: key(90), name: 'N'.repeat(5000), symbol: 'S\u0000YM', icon: `https://example.com/${'x'.repeat(5000)}`, isVerified: true, usdPrice: { nested: 'x'.repeat(5000) }, extra: 'y'.repeat(5000) };
    t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify([huge])));
    const worker = (await import(`../src/tokens.ts?worker=${'trim'}`)) as typeof import('../src/tokens.ts');
    await worker.keepTokens();
    await worker.tokens([key(90)], true);
    await new Promise((done) => setImmediate(done));
    const { platform } = await import('../src/platform.ts');
    const [, said] = ((await platform.storage.session.get('tokens')).tokens as [string, Record<string, unknown>][]).find(([m]) => m === key(90))!;
    assert.deepEqual([(said.name as string).length, said.symbol, said.icon, said.usdPrice, 'extra' in said], [40, 'SYM', null, null, false]);
    assert.ok(JSON.stringify(said).length < 600);
});
