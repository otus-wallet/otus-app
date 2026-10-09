import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { Address } from '@solana/kit';

import type { Grant } from '@otus-wallet/sdk/access/access';
import type { Review } from '@otus-wallet/sdk/review/review';
import { usable } from '../src/shell/serve.ts';
import type { State } from '../src/shell/state.ts';
import { accessRows, accessWords, freezable, others, type AccessNaming } from '../src/ui/view/access.ts';
import { key } from './helpers.ts';

const ME = key(1);
const naming = (o: Partial<AccessNaming> = {}): AccessNaming => ({
    wallet: ME,
    symbol: (mint) => (mint === key(20) ? 'USDC' : 'PYUSD'),
    decimals: (mint) => (mint === key(20) ? 6 : null),
    who: (a) => `who ${a.slice(0, 4)}`,
    program: (a) => `program ${a.slice(0, 4)}`,
    given: [],
    waiting: [],
    ...o,
});
const delegate: Grant = { kind: 'delegate', account: key(30), program: key(5), mint: key(20), to: key(31), allowance: 100_000_000n, all: false };
const nonce: Grant = { kind: 'nonce', account: key(32), nonce: 'N1', authority: ME };

test('each grant in words, with the site behind it when Otus kept that', () => {
    const [row] = accessRows([delegate], naming({ given: [{ account: key(30), to: key(31), host: 'jup.ag', at: 1_791_000_000 }] }));
    assert.equal(row.title, `who ${key(31).slice(0, 4)} can move up to 100 USDC`);
    assert.match(row.sub, /^Approved on jup\.ag · /);
    assert.equal(row.fix, 'revoke');
    assert.equal(accessRows([{ ...delegate, all: true }], naming())[0].title, `who ${key(31).slice(0, 4)} can move all your USDC`);
    assert.equal(accessRows([{ ...delegate, mint: key(21) }], naming())[0].title, `who ${key(31).slice(0, 4)} can move up to 100000000 units of PYUSD`);
    assert.equal(accessRows([delegate], naming())[0].sub, 'A delegate on your USDC account');
});

test('a transaction waiting on a nonce of yours can be cancelled; on another’s, only told', () => {
    const waiting = [{ wallet: ME, account: key(32), nonce: 'N1', host: 'raydium.io', at: 1 }];
    const [mine] = accessRows([nonce], naming({ waiting }));
    assert.equal(mine.title, 'A transaction you signed on raydium.io can still run');
    assert.equal(mine.fix, 'cancel');
    const [theirs] = accessRows([{ ...nonce, authority: key(33) }], naming());
    assert.equal(theirs.title, 'A transaction you signed can still run');
    assert.equal(theirs.fix, null);
});

test('freezing is said apart, and counts no one', () => {
    const freeze: Grant = { kind: 'freeze', mint: key(20), to: key(34) };
    assert.deepEqual(accessRows([freeze], naming()), []);
    assert.deepEqual(freezable([freeze], naming()), ['USDC']);
    assert.equal(others([freeze]), 0);
    assert.equal(accessWords(0), 'Only you can move your funds');
});

test('a wallet a program took over comes first; wrapped SOL a stranger can close says what it takes; unchecked issuers are never "only you"', () => {
    const [taken] = accessRows([{ kind: 'taken', program: key(40) }], naming());
    assert.deepEqual([taken.title, taken.fix], [`Your wallet belongs to program ${key(40).slice(0, 4)}`, null]);
    assert.equal(others([{ kind: 'taken', program: key(40) }]), 1);
    const [wrapped] = accessRows([{ kind: 'closer', account: key(30), mint: key(21), to: key(31), sol: 5_000_000_000n }], naming());
    assert.deepEqual([wrapped.title, wrapped.sub], [`who ${key(31).slice(0, 4)} can close your wrapped SOL account`, 'And take the 5 SOL in it, at any time']);
    const [empty] = accessRows([{ kind: 'closer', account: key(30), mint: key(20), to: key(31), sol: 0n }], naming());
    assert.equal(empty.sub, 'They keep its rent');
    assert.equal(accessWords(0, 3), 'No one else, among what Otus could check');
});

test('others counts each one once', () => {
    const permanent: Grant = { kind: 'permanent', mint: key(21), to: key(35) };
    assert.equal(others([delegate, { ...delegate, account: key(36) }, permanent, nonce]), 3);
    assert.equal(accessWords(1), 'Someone else can control some of your funds');
    assert.equal(accessWords(3), '3 others can control some of your funds');
});

test('signing keeps what a site can still use: a transaction on a nonce, and the delegates it gave', () => {
    const state = { waiting: [], given: [{ account: key(30), to: key(9), host: 'old.example', at: 1 }] } as unknown as State;
    const token = (delegate: Address | null, delegated: bigint) => ({ lamports: 1n, program: key(5), space: 165, data: new Uint8Array(), token: { mint: key(20), owner: ME, amount: 10n, delegate, delegated, closer: null, native: false } });
    const r = {
        message: { version: 'legacy', header: {}, staticAccounts: [ME, key(32), key(6), '11111111111111111111111111111111'], lookups: [], lifetimeToken: 'N1', instructions: [{ programAddressIndex: 3, accountIndices: [1, 2, 0], data: new Uint8Array([4, 0, 0, 0]) }], config: {} },
        assessment: { yours: { fee: 0n, accounts: [{ address: key(30), before: token(null, 0n), after: token(key(31), 5n) }] } },
    } as unknown as Review;
    const kept = usable(state, r, ME, 'jup.ag', 1_791_000_000_000);
    assert.deepEqual(kept?.waiting, [{ wallet: ME, account: key(32), nonce: 'N1', host: 'jup.ag', at: 1_791_000_000 }]);
    assert.deepEqual(kept?.given, [{ account: key(30), to: key(31), host: 'jup.ag', at: 1_791_000_000 }]); // the account's older one replaced
    const plain = { ...r, message: { ...r.message, instructions: [{ ...r.message.instructions[0], data: new Uint8Array([2, 0, 0, 0]) }] }, assessment: { yours: { fee: 0n, accounts: [] } } } as unknown as Review;
    assert.equal(usable(state, plain, ME, 'jup.ag', 0), null);
});
