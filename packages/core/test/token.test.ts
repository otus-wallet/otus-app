import assert from 'node:assert/strict';
import { test } from 'node:test';

import { TOKEN_PROGRAM_ADDRESS } from '@solana-program/token';
import { address, type Address } from '@solana/kit';

import type { MintTerms } from '@otus-wallet/sdk/access/mint';
import { TOKEN_2022_PROGRAM_ADDRESS } from '@otus-wallet/sdk/programs/addresses';
import { marketFacts, solFacts, tokenFacts, type TokenNaming } from '../src/view/token.ts';

const A = address('2apBGMsS6ti9RyF5TwQTDswXBWskiJP2LD4cUEDqYJjk');
const B = address('AxJkHRY3puoofyj7Pn512M1SGBgWroXMkEdNPQypkzbu');
const MINE = address('HH2vCgeHY4PNpYfACYSAAr11P1chxbMsSYbY7VzAHVx2');
const naming = (o: Partial<TokenNaming> = {}): TokenNaming => ({ who: (a: Address) => `${a.slice(0, 4)}…`, wallet: MINE, symbol: 'X', epoch: null, now: 1_800_000_000, ...o });
const terms = (o: Partial<MintTerms> = {}): MintTerms => ({ program: TOKEN_PROGRAM_ADDRESS, supply: 1_234_500_000n, decimals: 6, mintAuthority: null, freezeAuthority: null, extensions: [], unknown: [], ...o });
const fee = (bps: number, epoch = 1n, max = 2n ** 64n - 1n) => ({ epoch, max, bps });

test('a plain token: no one can mint or freeze, its metadata fixed, its supply and program', () => {
    assert.deepEqual(tokenFacts(terms(), 'immutable', naming({ symbol: 'JUP' })), [
        { name: 'Mint authority', value: 'None' },
        { name: 'Freeze authority', value: 'None' },
        { name: 'Onchain metadata', value: 'Immutable' },
        { name: 'Supply', value: '1.2K JUP', full: '1,234.5 JUP' },
        { name: 'Program', value: 'Token' },
    ]);
    // Authorities name their address, to copy; without metadata Otus reads, that line is left out; unreadable, it warns.
    assert.deepEqual(tokenFacts(terms({ mintAuthority: A, freezeAuthority: B }), null, naming()).slice(0, 2), [
        { name: 'Mint authority', value: '2apB…', address: A },
        { name: 'Freeze authority', value: 'AxJk…', address: B },
    ]);
    assert.deepEqual(tokenFacts(terms(), 'unreadable', naming())[2], { name: 'Onchain metadata', value: 'Unreadable', warn: true });
    // Your wallet as an authority is tagged by its address, never by words: a symbol can say anything.
    assert.deepEqual(tokenFacts(terms({ mintAuthority: MINE }), null, naming())[0], { name: 'Mint authority', value: 'HH2v…', address: MINE, you: true });
    const fee = { kind: 'transferFee' as const, authority: null, older: { epoch: 1n, max: 5n, bps: 100 }, newer: { epoch: 1n, max: 5n, bps: 100 } };
    const sly = tokenFacts(terms({ extensions: [fee] }), null, naming({ symbol: 'X (you)' }));
    assert.deepEqual(sly.find((f) => f.name === 'Transfer fee'), { name: 'Transfer fee', value: '1%, at most 0.000005 X (you)' });
    assert.equal(sly.some((f) => f.you), false);
});

test('a supply, cap or liquidity under a thousand is said whole: in short a small one would read as 0', () => {
    const supply = (units: bigint, decimals = 6) => tokenFacts(terms({ supply: units, decimals }), null, naming()).find((f) => f.name === 'Supply');
    assert.deepEqual(supply(49_999n), { name: 'Supply', value: '0.049999 X' });
    assert.deepEqual(supply(0n), { name: 'Supply', value: '0 X' });
    assert.deepEqual(supply(999_000_000n), { name: 'Supply', value: '999 X' });
    // Past what short says, or with as many decimals as a mint can have, never Infinity or NaN.
    for (const decimals of [0, 9, 19, 20, 255]) {
        const f = supply(2n ** 64n - 1n, decimals)!;
        assert.doesNotMatch(`${f.value} ${f.full ?? ''}`, /Infinity|NaN/, `decimals ${decimals}`);
    }
    assert.deepEqual(marketFacts({ cap: 0.4, holders: 0, topHolders: 0, liquidity: 12.5, firstPool: null }), [
        { name: 'Market cap', value: '$0.40' },
        { name: 'Holders', value: '0' },
        { name: 'Top holders', value: '0% of supply' },
        { name: 'Liquidity', value: '$12.50' },
    ]);
});

test('an amount multiplier: the one in force, and the next while still to come', () => {
    const shown = (multiplier: number, next: number, nextAt: bigint) => tokenFacts(terms({ extensions: [{ kind: 'scaledUiAmount', authority: null, multiplier, next, nextAt }] }), null, naming()).find((f) => f.name === 'Amount multiplier')?.value;
    assert.equal(shown(1, 0.0001, 1_900_000_000n), '×1; ×0.0001 from 17 Mar 2030');
    assert.equal(shown(1, 0.0001, 1_700_000_000n), '×0.0001');
    assert.equal(shown(1.0000000000000002, 1.0000000000000002, 1_900_000_000n), '×1');
    assert.equal(shown(2, 3, 2n ** 63n - 1n), '×2'); // a date past any calendar: only the one in force
    assert.equal(tokenFacts(terms({ extensions: [{ kind: 'interestBearing', authority: null, bps: -32_768 }] }), null, naming()).find((f) => f.name === 'Interest')?.value, '-327.68% a year');
});

test('Token-2022’s extensions: who can take yours or has stopped it warns; each authority is said; what Otus cannot read is said', () => {
    const facts = tokenFacts(
        terms({
            program: TOKEN_2022_PROGRAM_ADDRESS,
            extensions: [
                { kind: 'permanentDelegate', delegate: A },
                { kind: 'transferFee', authority: B, older: fee(0), newer: fee(0) },
                { kind: 'transferHook', authority: A, program: null },
                { kind: 'pausable', authority: A, paused: true },
                { kind: 'defaultState', frozen: true },
                { kind: 'nonTransferable' },
                { kind: 'closeAuthority', authority: null },
                { kind: 'permissionedBurn', authority: A },
                { kind: 'interestBearing', authority: B, bps: 500 },
                { kind: 'scaledUiAmount', authority: null, multiplier: 1, next: 1.5, nextAt: 1_700_000_000n },
                { kind: 'metadataPointer', authority: A, metadata: A },
                { kind: 'other', name: 'Confidential transfers' },
                { kind: 'other', name: 'Group pointer' },
            ],
            unknown: [40, 41],
        }),
        'mutable',
        naming({ symbol: 'PYUSD' }),
    );
    assert.deepEqual(facts.slice(2), [
        { name: 'Onchain metadata', value: 'Mutable' },
        { name: 'Permanent delegate', value: '2apB…', address: A, warn: true },
        { name: 'Transfer fee', value: '0%' },
        { name: 'Fee authority', value: 'AxJk…', address: B }, // 0% now, but it can raise it
        { name: 'Hook authority', value: '2apB…', address: A }, // no hook yet, but it can set one
        { name: 'Transfers', value: 'Paused', warn: true },
        { name: 'Pause authority', value: '2apB…', address: A }, // who can resume them
        { name: 'New accounts', value: 'Start frozen' },
        { name: 'Transferable', value: 'No' },
        { name: 'Burn authority', value: '2apB…', address: A },
        { name: 'Interest', value: '5% a year' },
        { name: 'Rate authority', value: 'AxJk…', address: B },
        { name: 'Amount multiplier', value: '×1.5' }, // the next one, as its time has come
        { name: 'Extensions', value: 'Confidential transfers, Group pointer' },
        { name: 'Unreadable', value: '2 extensions', warn: true },
        { name: 'Supply', value: '1.2K PYUSD', full: '1,234.5 PYUSD' },
        { name: 'Program', value: 'Token-2022' },
    ]);
});

test('a transfer fee as it holds now, its cap, and the one to come', () => {
    const shown = (older: ReturnType<typeof fee>, newer: ReturnType<typeof fee>, epoch: bigint | null) => tokenFacts(terms({ extensions: [{ kind: 'transferFee', authority: null, older, newer }] }), null, naming({ epoch })).find((f) => f.name === 'Transfer fee')?.value;
    assert.equal(shown(fee(1000), fee(100, 900n), 950n), '1%'); // the newer holds since epoch 900
    assert.equal(shown(fee(1000), fee(100, 900n), 899n), '10%; 1% from epoch 900');
    assert.equal(shown(fee(1000), fee(100, 900n), null), '10% or 1%'); // the epoch unread: both said
    assert.equal(shown(fee(10_000, 1n, 1n), fee(10_000, 1n, 1n), null), '100%, at most 0.000001 X');
    assert.equal(shown(fee(0, 1n, 0n), fee(0, 1n, 0n), null), '0%'); // a cap of 0 on no fee says nothing
});

test('SOL: native, no mint; its supply and what circulates in short, whole on hover, when known', () => {
    assert.deepEqual(solFacts({ total: 612_345_678.9, circulating: 512_000_000.1 }), [
        { name: 'Type', value: 'Native token' },
        { name: 'Supply', value: '612.3M SOL', full: '612,345,678.9 SOL' },
        { name: 'Circulating', value: '512M SOL', full: '512,000,000.1 SOL' },
        { name: 'Program', value: 'System' },
    ]);
    assert.deepEqual(solFacts(null).map((f) => f.name), ['Type', 'Program']);
});

test('its market, between its supply and its program: market cap, holders, the top holders’ share, liquidity, the first pool', () => {
    const market = { cap: 1_241_445_666.9, holders: 838_628, topHolders: 15.44, liquidity: 5_602_336.3, firstPool: Date.UTC(2024, 0, 29, 17, 33, 29) };
    assert.deepEqual(marketFacts(market), [
        { name: 'Market cap', value: '$1.2B', full: '$1,241,445,666.90' },
        { name: 'Holders', value: '838,628' },
        { name: 'Top holders', value: '15.4% of supply' },
        { name: 'Liquidity', value: '$5.6M', full: '$5,602,336.30' },
        { name: 'First pool', value: '29 Jan 2024' },
    ]);
    assert.deepEqual(marketFacts({ cap: null, holders: null, topHolders: null, liquidity: 980, firstPool: null }), [{ name: 'Liquidity', value: '$980.00' }]);
    assert.deepEqual(tokenFacts(terms(), null, naming(), market).map((f) => f.name), ['Mint authority', 'Freeze authority', 'Supply', 'Market cap', 'Holders', 'Top holders', 'Liquidity', 'First pool', 'Program']);
});
