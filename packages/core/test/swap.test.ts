import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { address, getAddressDecoder, type Address, type Blockhash } from '@solana/kit';

import type { Chain } from '@otus-wallet/sdk/chain';
import { decode } from '@otus-wallet/sdk/review/decode';
import { OTUS_RPC } from '../src/settings.ts';
import { throughSender } from '../src/swap/sender.ts';
import { fittingRoute, MOST_ACCOUNTS, SENDER_TIPS, swapping, TIP } from '../src/swap/build.ts';
import { JUPITER, readRoute, type Ask } from '../src/swap/route.ts';

// Three routes as Jupiter gave them through Otus's server: SOL for USDC (SOL wrapped first, unwrapped after), USDC for
// SOL, and USDC for BONK over four venues.
const ROUTES = JSON.parse(readFileSync(new URL('./swap.fixtures.json', import.meta.url), 'utf8')) as Record<'sol-usdc' | 'usdc-sol' | 'usdc-bonk', Record<string, unknown>>;
const TAKER = address('HH2vCgeHY4PNpYfACYSAAr11P1chxbMsSYbY7VzAHVx2');
const askOf = (r: Record<string, unknown>): Ask => ({ input: r.inputMint as Address, output: r.outputMint as Address, amount: BigInt(r.inAmount as string), taker: TAKER, slippageBps: 50, maxAccounts: 64 });
const LIFETIME = { blockhash: '11111111111111111111111111111111' as Blockhash, lastValidBlockHeight: 0n };
const copy = <T>(v: T): T => structuredClone(v);
const made = (n: number) => getAddressDecoder().decode(new Uint8Array(32).fill(n));

test('a route reads as Jupiter gave it: amounts, venues, and what to build', () => {
    const r = readRoute(ROUTES['sol-usdc'], askOf(ROUTES['sol-usdc']));
    assert.equal(r.out, 10_923_752n);
    assert.equal(r.least, 10_869_134n);
    assert.deepEqual(r.venues.map((v) => v.label), ['TesseraV', 'Raydium CLMM']);
    assert.equal(r.swap.programAddress, JUPITER);
    assert.equal(r.setup.length, 4); // the wSOL account opened, SOL moved in and synced, the USDC account opened
    assert.equal(r.cleanup.length, 1); // the wSOL account closed
    assert.equal(Object.keys(r.tables).length, 2);
    assert.equal(readRoute(ROUTES['usdc-bonk'], askOf(ROUTES['usdc-bonk'])).cleanup.length, 0);
});

test('a route for anything other than what was asked is refused', () => {
    const route = ROUTES['sol-usdc'];
    const ask = askOf(route);
    assert.throws(() => readRoute(route, { ...ask, amount: ask.amount + 1n }), /not for what was asked/);
    assert.throws(() => readRoute(route, { ...ask, output: ask.input }), /not for what was asked/);
    assert.throws(() => readRoute({ ...route, swapMode: 'ExactOut' }, ask), /not for what was asked/);
    assert.throws(() => readRoute({ ...route, otherAmountThreshold: '10923753' }, ask), /too little/);
    assert.throws(() => readRoute({ ...route, otherAmountThreshold: '0' }, ask), /too little/);
});

test('a route that would run or sign anything else is refused', () => {
    const route = ROUTES['sol-usdc'];
    const ask = askOf(route);
    const swap = route.swapInstruction as { programId: string; accounts: { pubkey: string; isSigner: boolean; isWritable: boolean }[]; data: string };
    const with_ = (change: (r: Record<string, unknown>) => void) => {
        const r = copy(route);
        change(r);
        return r;
    };
    assert.throws(() => readRoute(with_((r) => (r.tipInstruction = swap)), ask), /tip/);
    assert.throws(() => readRoute(with_((r) => (r.otherInstructions = [swap])), ask), /more to run/);
    assert.throws(() => readRoute(with_((r) => ((r.swapInstruction as typeof swap).programId = '11111111111111111111111111111111')), ask), /swaps with another program/);
    assert.throws(() => readRoute(with_((r) => (r.setupInstructions as unknown[]).push(swap)), ask), /sets up with another program/);
    assert.throws(() => readRoute(with_((r) => (r.cleanupInstruction = swap)), ask), /cleans up with another program/);
    assert.throws(() => readRoute(with_((r) => ((r.swapInstruction as typeof swap).accounts[5] = { pubkey: 'So11111111111111111111111111111111111111112', isSigner: true, isWritable: true })), ask), /another key would sign/);
    assert.throws(() => readRoute(with_((r) => ((r.swapInstruction as Record<string, unknown>).extra = 1)), ask), /more than asked/);
    assert.throws(() => readRoute(with_((r) => ((r.swapInstruction as typeof swap).accounts[0] = { ...swap.accounts[0], isSigner: 'yes' as unknown as boolean })), ask), /not as asked/);
    assert.throws(() => readRoute(with_((r) => ((r.computeBudgetInstructions as unknown[]).push(swap))), ask), /budget/);
});

test('garbage, truncated and hostile answers are refused, never read', () => {
    const route = ROUTES['usdc-sol'];
    const ask = askOf(route);
    const swap = route.swapInstruction as { data: string; accounts: unknown[] };
    for (const body of [null, undefined, 0, 'route', [], [route], {}, { ...route, routePlan: undefined }, { ...route, setupInstructions: null }, { ...route, addressesByLookupTableAddress: [] }]) {
        assert.throws(() => readRoute(body, ask), Error, JSON.stringify(body)?.slice(0, 60));
    }
    for (const [key, value] of [
        ['outAmount', '0091552895'],
        ['outAmount', '-1'],
        ['outAmount', 91552895],
        ['outAmount', '18446744073709551616'],
        ['otherAmountThreshold', '1e9'],
        ['swapInstruction', { ...swap, data: 'not base64!' }],
        ['swapInstruction', { ...swap, data: 'AAA' }],
        ['swapInstruction', { ...swap, data: 'A'.repeat(4100) }],
        ['swapInstruction', { ...swap, accounts: Array(256).fill(swap.accounts[0]) }],
        ['swapInstruction', { ...swap, programId: 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV' }],
        ['addressesByLookupTableAddress', Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`${i + 1}`.repeat(32), ['11111111111111111111111111111111']]))],
        ['addressesByLookupTableAddress', { '2Lvj7QUu1pcKqVb5Lq9ddc94bYKJ1SB6vZQm9F3vzpRe': ['not an address'] }],
        ['routePlan', [{ percent: 100, swapInfo: { label: 7 } }]],
        ['routePlan', [{ percent: 0, swapInfo: { label: 'x' } }]],
    ] as const) {
        assert.throws(() => readRoute({ ...copy(route), [key]: value }, ask), Error, key);
    }
});

test("a venue's name keeps no control or invisible characters, and stays short", () => {
    const route = copy(ROUTES['usdc-sol']);
    route.routePlan = [{ percent: 100, bps: 10000, swapInfo: { label: 'Whirl‮pool\u0000' + 'x'.repeat(60) } }];
    assert.equal(readRoute(route, askOf(route)).venues[0].label, 'Whirlpool' + 'x'.repeat(23));
});

test('a swap is built: its limit first, the route in order, the tip last, through the lookup tables', async () => {
    for (const name of ['sol-usdc', 'usdc-sol'] as const) {
        const route = readRoute(ROUTES[name], askOf(ROUTES[name]));
        const bytes = swapping(route, LIFETIME, SENDER_TIPS[3]);
        const { message, signers } = await decode(bytes);
        const accounts = [...message.staticAccounts, ...message.lookups.flatMap((l) => [...l.writableIndexes, ...l.readonlyIndexes].map((i) => route.tables[l.lookupTableAddress][i]))];
        const programs = message.instructions.map((ix) => accounts[ix.programAddressIndex]);
        assert.equal(message.version, 0);
        assert.deepEqual(signers, [TAKER]);
        assert.equal(programs[0], 'ComputeBudget111111111111111111111111111111');
        assert.deepEqual(programs.slice(1, -1), [...route.setup, route.swap, ...route.cleanup].map((ix) => ix.programAddress));
        const tip = message.instructions.at(-1)!;
        assert.equal(programs.at(-1), '11111111111111111111111111111111');
        assert.equal(accounts[tip.accountIndices[1]], SENDER_TIPS[3]);
        assert.equal(new DataView(tip.data.buffer, tip.data.byteOffset).getBigUint64(4, true), TIP);
        assert.ok(message.lookups.length > 0, 'through its lookup tables');
        assert.ok(bytes.length <= 1232, `${name}: ${bytes.length} bytes`);
    }
});

test('a route too large to leave room for the guards is asked again with fewer accounts', async () => {
    const asked: number[] = [];
    // A big route (four venues) while 64 or 48 accounts are allowed, a small one after.
    const find = async (ask: Ask) => {
        asked.push(ask.maxAccounts);
        const big = ask.maxAccounts > 40;
        const route = readRoute(ROUTES[big ? 'usdc-bonk' : 'usdc-sol'], askOf(ROUTES[big ? 'usdc-bonk' : 'usdc-sol']));
        return big ? { ...route, setup: Array(12).fill(route.setup).flat() } : route;
    };
    const route = await fittingRoute({ input: TAKER, output: TAKER, amount: 1n, taker: TAKER, slippageBps: 50 }, find);
    assert.deepEqual(asked, [64, 48, 36]); // a small one fits at 36, the first under 40
    assert.equal(route.venues.length, 1);
    // One that fits at once is asked once.
    asked.length = 0;
    await fittingRoute({ input: TAKER, output: TAKER, amount: 1n, taker: TAKER, slippageBps: 50 }, async (ask) => (asked.push(ask.maxAccounts), readRoute(ROUTES['usdc-sol'], askOf(ROUTES['usdc-sol']))));
    assert.deepEqual(asked, [MOST_ACCOUNTS[0]]);
});

test("a swap is sent to Otus's server for Sender, as the server takes it; all else is read from the chain as before", async (t) => {
    const posts: { url: string; body: Record<string, unknown> }[] = [];
    t.mock.method(globalThis, 'fetch', async (url: string, init: { body: string }) => {
        posts.push({ url: String(url), body: JSON.parse(init.body) });
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: posts.at(-1)!.body.id, result: '5'.repeat(88) }), { headers: { 'content-type': 'application/json' } });
    });
    const asked: string[] = [];
    const chain = { status: async () => (asked.push('status'), null), send: async () => void asked.push('chain send') } as unknown as Chain;
    const fast = throughSender(chain);
    await fast.send(Uint8Array.of(1, 2, 3), true);
    await fast.status('x' as never);
    assert.equal(posts.length, 1);
    assert.equal(posts[0].url, `${OTUS_RPC}/send`);
    assert.equal(posts[0].body.method, 'sendTransaction');
    // Kit adds the commitment of its own: one of the fields Otus's server takes, and writes anew.
    assert.deepEqual(posts[0].body.params, ['AQID', { encoding: 'base64', skipPreflight: true, maxRetries: 0, preflightCommitment: 'confirmed' }]);
    assert.deepEqual(asked, ['status']);
});

test("a swap whose instruction carries other terms than the route states is refused", () => {
    const name = 'sol-usdc';
    const ask = askOf(ROUTES[name]);
    // The swap's data, bent at a byte: the amount in (8), the quote (16), the slippage (24), the fees (26, 28).
    const bent = (at: number, value: number) => {
        const r = copy(ROUTES[name]);
        const swap = r.swapInstruction as { data: string };
        const data = Buffer.from(swap.data, 'base64');
        data[at] = value;
        swap.data = data.toString('base64');
        return r;
    };
    for (const [what, at, value] of [['amount in', 8, 7], ['quote', 16, 7], ['slippage', 24, 200], ['platform fee', 26, 1], ['positive slippage', 28, 1], ['another instruction', 0, 0]] as const) {
        assert.throws(() => readRoute(bent(at, value), ask), /terms/, what);
    }
    // Its other destination set: what comes out would land elsewhere.
    const elsewhere = copy(ROUTES[name]);
    (elsewhere.swapInstruction as { accounts: { pubkey: string }[] }).accounts[7].pubkey = 'So11111111111111111111111111111111111111112';
    assert.throws(() => readRoute(elsewhere, ask), /terms/);
});

test('a route at another slippage, or with too low a least for its own, is refused', () => {
    const route = ROUTES['usdc-sol'];
    const ask = askOf(route);
    assert.throws(() => readRoute({ ...route, slippageBps: 300 }, ask), /not for what was asked/);
    const out = BigInt(route.outAmount as string);
    assert.throws(() => readRoute({ ...route, otherAmountThreshold: String(out - (out * 50n) / 10_000n - 2n) }, ask), /too little/);
    assert.doesNotThrow(() => readRoute({ ...route, otherAmountThreshold: String(out - (out * 50n + 9_999n) / 10_000n) }, ask));
});

test('an account opened with another program as its token program, or for another wallet, is refused', () => {
    const ask = askOf(ROUTES['sol-usdc']);
    const opened = (i: number, address: string) => {
        const r = copy(ROUTES['sol-usdc']);
        (r.setupInstructions as { accounts: { pubkey: string }[] }[])[0].accounts[i].pubkey = address;
        return r;
    };
    const ATTACKER = 'Attacker111111111111111111111111111111111111';
    assert.throws(() => readRoute(opened(5, ATTACKER), ask), /opens an account otherwise/);
    assert.throws(() => readRoute(opened(4, ATTACKER), ask), /opens an account otherwise/);
    assert.throws(() => readRoute(opened(2, ATTACKER), ask), /opens an account otherwise/);
    const many = copy(ROUTES['sol-usdc']);
    many.setupInstructions = Array(7).fill((many.setupInstructions as unknown[])[0]);
    assert.throws(() => readRoute(many, ask), /not as asked/);
});

test("an account opened for a token between the two swapped goes only when the swap names it (a route of several steps)", () => {
    const ask = askOf(ROUTES['sol-usdc']);
    const THROUGH = 'DEkqHyPN7GMRJ5cArtQFAWefqbZb33Hyf6s5iCwjEonT';
    const ACCOUNT = 'Through111111111111111111111111111111111111';
    const through = (named: boolean) => {
        const r = copy(ROUTES['sol-usdc']);
        const create = copy((r.setupInstructions as { accounts: { pubkey: string }[] }[])[0]);
        create.accounts[1].pubkey = ACCOUNT;
        create.accounts[3].pubkey = THROUGH;
        (r.setupInstructions as unknown[]).push(create);
        if (named) (r.swapInstruction as { accounts: unknown[] }).accounts.push({ pubkey: ACCOUNT, isSigner: false, isWritable: true });
        return r;
    };
    assert.throws(() => readRoute(through(false), ask), /opens an account otherwise/);
    assert.equal(readRoute(through(true), ask).setup.length, (ROUTES['sol-usdc'].setupInstructions as unknown[]).length + 1);
});

test('accounts opened for tokens passed through: the taker\'s, by CreateIdempotent, written by route_v2, each once, four at most', () => {
    // USD Coin for SOL through route_v2, one account opened: room for more.
    const base = ROUTES['usdc-sol'];
    const ask = askOf(base);
    const create = (r: Record<string, unknown>) => (r.setupInstructions as { accounts: { pubkey: string }[]; data: string }[])[0]!;
    const opening = (n: number, change: (open: { accounts: { pubkey: string; isWritable: boolean }[]; data: string }, swap: { accounts: { pubkey: string; isSigner: boolean; isWritable: boolean }[] }) => void = () => {}) => {
        const r = copy(base);
        const swap = r.swapInstruction as { accounts: { pubkey: string; isSigner: boolean; isWritable: boolean }[] };
        for (let i = 0; i < n; i++) {
            const open = copy(create(base)) as { accounts: { pubkey: string; isWritable: boolean }[]; data: string };
            open.accounts[1].pubkey = made(100 + i);
            open.accounts[3].pubkey = made(120 + i);
            swap.accounts.push({ pubkey: open.accounts[1].pubkey, isSigner: false, isWritable: true });
            change(open, swap);
            (r.setupInstructions as unknown[]).push(open);
        }
        return r;
    };
    assert.doesNotThrow(() => readRoute(opening(3), ask));
    assert.throws(() => readRoute(opening(4), ask), /twice, or too many/);
    // Another wallet's, a create that is not the idempotent one, or one the swap names only read-only: refused.
    assert.throws(() => readRoute(opening(1, (open) => void (open.accounts[2].pubkey = 'Attacker111111111111111111111111111111111111')), ask), /opens an account otherwise/);
    assert.throws(() => readRoute(opening(1, (open) => void (open.data = Buffer.from([0]).toString('base64'))), ask), /opens an account otherwise/);
    assert.throws(() => readRoute(opening(1, (_, swap) => void (swap.accounts.at(-1)!.isWritable = false)), ask), /opens an account otherwise/);
    // The same one twice.
    const twice = copy(base);
    (twice.setupInstructions as unknown[]).push(create(base));
    assert.throws(() => readRoute(twice, ask), /twice, or too many/);
    // The shared route swaps through Jupiter's own accounts: one of the taker's it names is no account it passes through.
    const shared = copy(ROUTES['usdc-bonk']);
    const open = copy(create(shared)) as { accounts: { pubkey: string }[] };
    open.accounts[1].pubkey = made(140);
    open.accounts[3].pubkey = made(141);
    (shared.swapInstruction as { accounts: unknown[] }).accounts.push({ pubkey: open.accounts[1].pubkey, isSigner: false, isWritable: true });
    (shared.setupInstructions as unknown[]).push(open);
    assert.throws(() => readRoute(shared, askOf(ROUTES['usdc-bonk'])), /opens an account otherwise/);
});

test("a swap missing accounts its IDL names is refused, never read short", () => {
    const ask = askOf(ROUTES['sol-usdc']);
    const cut = copy(ROUTES['sol-usdc']);
    (cut.swapInstruction as { accounts: unknown[] }).accounts.length = 7; // route_v2 names 10
    assert.throws(() => readRoute(cut, ask), /terms/);
    const shared = copy(ROUTES['usdc-bonk']);
    (shared.swapInstruction as { accounts: unknown[] }).accounts.length = 11; // the shared route names 12
    assert.throws(() => readRoute(shared, askOf(ROUTES['usdc-bonk'])), /terms/);
});
