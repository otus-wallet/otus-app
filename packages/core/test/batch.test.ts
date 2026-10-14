import assert from 'node:assert/strict';
import { test } from 'node:test';

import { getTransferSolInstruction } from '@solana-program/system';
import { createNoopSigner, type MaybeEncodedAccount } from '@solana/kit';

import { review, type Review } from '@otus-wallet/sdk/review/review';
import { prepare, type Prepared } from '@otus-wallet/sdk/prepare/prepare';
import { describeBatch, siteView, type Shown } from '../src/view.ts';
import { AccountRole } from '@solana/kit';
import { TOKEN_PROGRAM_ADDRESS } from '@solana-program/token';
import { account, DRAIN, DRAIN_AFTER, DRAIN_BEFORE, fakeChain, key, PAYER, SYSTEM, tokenAccountData, transaction } from './helpers.ts';

// Several transactions signed at once, as the window shows them: all together, and each alone.
const SOL = 1_000_000_000n;
const site = siteView('https://app.example.com', { account: PAYER, signatures: 3 });
const shown: Shown = { site, account: { label: 'Me', address: PAYER }, signer: 'ready', cluster: 'solana:mainnet', known: { tokens: new Map(), decimals: new Map() } };
const known = { tokens: new Map(), decimals: new Map() };

async function reviewed(bytes: Uint8Array, before: MaybeEncodedAccount[], after: MaybeEncodedAccount[], others: Review[] = []): Promise<{ r: Review; p: Prepared }> {
    const chain = fakeChain(before, after);
    const r = await review(bytes, { wallet: PAYER, signedBefore: 0, host: 'app.example.com' }, chain);
    return { r, p: await prepare(r, PAYER, chain, false, undefined, undefined, others) };
}
const send = (to: number, amount: bigint) => transaction([getTransferSolInstruction({ source: createNoopSigner(PAYER), destination: key(to), amount })]);
const sent = (to: number, amount: bigint) => [account(PAYER, SYSTEM, 2n * SOL - amount - 5_000n), account(key(to), SYSTEM, amount)];

test('two transfers: one verdict, the SOL summed with each line by its number, the fees summed, guards in both', async () => {
    const a = await reviewed(send(2, SOL / 10n), [account(PAYER, SYSTEM, 2n * SOL)], sent(2, SOL / 10n));
    const b = await reviewed(send(3, SOL / 5n), [account(PAYER, SYSTEM, 2n * SOL)], sent(3, SOL / 5n), [a.r]);
    const v = describeBatch([{ ...a, known }, { ...b, known }], shown);
    assert.equal(v.kind, 'batch');
    assert.equal(v.items.length, 2);
    assert.equal(v.verdict, 'ok');
    assert.equal(v.balances.length, 1);
    assert.equal(v.balances[0].asset, 'SOL');
    assert.ok(v.balances[0].lines.every((l) => /^[12] · /.test(l.note)), JSON.stringify(v.balances[0].lines));
    assert.equal(v.fee, `${Number(a.p.fee + b.p.fee) / 1e9} SOL`);
    assert.deepEqual(v.guards, { held: true, text: 'Guards lock your accounts in all 2' });
    assert.equal(v.hash, '');
});

test('one bad among good: the worst verdict leads, its findings by its number, what all share said once', async () => {
    const a = await reviewed(send(2, SOL / 10n), [account(PAYER, SYSTEM, 2n * SOL)], sent(2, SOL / 10n));
    const d = await reviewed(DRAIN, DRAIN_BEFORE, DRAIN_AFTER);
    const v = describeBatch([{ ...a, known }, { ...d, known }, { ...a, known }], shown);
    assert.equal(v.verdict, 'danger');
    assert.equal(v.title, 'Not safe');
    const danger = v.findings.filter((f) => f.tone === 'danger');
    assert.ok(danger.length > 0 && danger.every((f) => f.title.startsWith('2 · ')), JSON.stringify(danger));
    assert.ok(v.changes.every((c) => c.title.startsWith('2 · ')), JSON.stringify(v.changes));
    // A clear finding the three share comes once, without numbers.
    const titles = v.findings.filter((f) => f.tone === 'ok').map((f) => f.title);
    assert.equal(new Set(titles).size, titles.length);
    // Each alone, as describe tells it.
    assert.deepEqual(v.items.map((i) => i.verdict), ['ok', 'danger', 'ok']);
});

test('while any is prepared: no fee, no guards, no verdict to sign yet', async () => {
    const a = await reviewed(send(2, SOL / 10n), [account(PAYER, SYSTEM, 2n * SOL)], sent(2, SOL / 10n));
    const v = describeBatch([{ r: a.r, p: null, known }, { ...a, known }], shown);
    assert.equal(v.preparing, true);
    assert.equal(v.fee, '');
    assert.deepEqual(v.guards, { held: false, text: '' });
});

test('one that would fail alone, after others, may need one of them: said, and the user decides', async () => {
    const a = await reviewed(send(2, SOL / 10n), [account(PAYER, SYSTEM, 2n * SOL)], sent(2, SOL / 10n));
    const chain = fakeChain([account(PAYER, SYSTEM, 2n * SOL)], [], { error: { InstructionError: [0, 'InvalidAccountData'] }, logs: [] });
    const r = await review(send(3, SOL), { wallet: PAYER, signedBefore: 0, host: 'app.example.com' }, chain);
    const failing = { r, p: await prepare(r, PAYER, chain), known };
    const v = describeBatch([{ ...a, known }, failing], shown);
    assert.equal(v.verdict, 'danger');
    assert.match(v.changes[0].title, /^2 · The transaction would fail now/);
    assert.match(v.changes[0].note, /alone: it may need one before it$/);
    // First of all, nothing comes before it: only that it fails.
    const firstFails = describeBatch([failing, { ...a, known }], shown);
    assert.doesNotMatch(firstFails.changes[0].note, /may need/);
});

test('almost all your SOL leaving, split into several, warns as one transaction alone would', async () => {
    // Two transfers of half of it each: neither alone says so.
    const half = SOL - 10_000n;
    const a = await reviewed(send(2, half), [account(PAYER, SYSTEM, 2n * SOL)], sent(2, half));
    const b = await reviewed(send(3, half), [account(PAYER, SYSTEM, 2n * SOL)], sent(3, half), [a.r]);
    const v = describeBatch([{ ...a, known }, { ...b, known }], shown);
    assert.deepEqual(v.items.map((i) => i.verdict), ['ok', 'ok']);
    assert.equal(v.verdict, 'warn');
    assert.deepEqual(v.findings[0], { tone: 'warn', title: 'All · You send almost all your SOL', note: '' });
    // A tenth each: nothing more.
    const small = await reviewed(send(2, SOL / 10n), [account(PAYER, SYSTEM, 2n * SOL)], sent(2, SOL / 10n));
    assert.equal(describeBatch([{ ...small, known }, { ...small, known }], shown).verdict, 'ok');
});

test('a clear line only some of them have says whose it is', async () => {
    const a = await reviewed(send(2, SOL / 10n), [account(PAYER, SYSTEM, 2n * SOL)], sent(2, SOL / 10n));
    const d = await reviewed(DRAIN, DRAIN_BEFORE, DRAIN_AFTER);
    const v = describeBatch([{ ...a, known }, { ...d, known }], shown);
    const clear = v.findings.filter((f) => f.tone === 'ok');
    const onlyFirst = a.r && describeBatch([{ ...a, known }], shown).findings.filter((f) => f.tone === 'ok').map((f) => f.title);
    for (const f of clear) {
        const inDrain = v.items[1].findings.some((x) => x.tone === 'ok' && f.title.endsWith(x.title));
        const inFirst = onlyFirst.some((t) => f.title.endsWith(t));
        if (inFirst && !inDrain) assert.ok(f.title.startsWith('1 · '), f.title);
    }
});

test('room the others leave, moving funds between your accounts, is said with how much', async () => {
    // B: 1 SOL from your wallet into your own token account's lamports, nothing of yours leaving.
    const OWN = key(30);
    const own = (lamports: bigint) => account(OWN, TOKEN_PROGRAM_ADDRESS, lamports, tokenAccountData({ mint: key(31), owner: PAYER, amount: 0n }));
    const touch = transaction([{ programAddress: key(32), accounts: [{ address: PAYER, role: AccountRole.WRITABLE_SIGNER }, { address: OWN, role: AccountRole.WRITABLE }] }]);
    const b = await reviewed(touch, [account(PAYER, SYSTEM, 2n * SOL), own(2_039_280n)], [account(PAYER, SYSTEM, SOL - 5_000n), own(SOL + 2_039_280n)]);
    const a = await reviewed(send(2, SOL / 10n), [account(PAYER, SYSTEM, 2n * SOL)], sent(2, SOL / 10n), [b.r]);
    const v = describeBatch([{ ...a, known }, { ...b, known }], shown);
    const said = v.findings.find((f) => f.title.endsWith('Its guards leave room for the others'));
    assert.ok(said?.title.startsWith('1 · '), JSON.stringify(v.findings));
    assert.match(said!.note, /^Up to 1 SOL more than shown/);
    assert.equal(v.items[0].guards.held, false);
});
