import assert from 'node:assert/strict';
import { test } from 'node:test';

import { getTransferSolInstruction } from '@solana-program/system';
import { createNoopSigner, type MaybeEncodedAccount } from '@solana/kit';

import { review, type Review } from '@otus-wallet/sdk/review/review';
import { prepare, type Prepared } from '@otus-wallet/sdk/prepare/prepare';
import { describeBatch, siteView, type Shown } from '../src/view.ts';
import { account, DRAIN, DRAIN_AFTER, DRAIN_BEFORE, fakeChain, key, PAYER, SYSTEM, transaction } from './helpers.ts';

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
