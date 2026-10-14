import assert from 'node:assert/strict';
import { test } from 'node:test';

import { AccountRole, createNoopSigner, getAddressEncoder, type Address, type MaybeEncodedAccount } from '@solana/kit';

import type { Simulation } from '@otus-wallet/sdk/chain';
import { getTransferSolInstruction } from '@solana-program/system';

import { review } from '@otus-wallet/sdk/review/review';
import { prepare } from '@otus-wallet/sdk/prepare/prepare';
import { describe, siteView } from '../src/view.ts';
import { account, fakeChain, key, PAYER, SYSTEM, transaction } from './helpers.ts';

const SOME = key(30);
const data = (...rest: number[]) => new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, ...rest]);

// A program Otus doesn't know gets your signature: what the review says of it, held by guards or not, what it calls
// inside (`calls`; `listed`: whether the RPC listed them), and with its IDL (`told`: the name it gives itself there).
async function unknownCall(o: { cosigned?: boolean; told?: string; calls?: Address[]; listed?: boolean } = {}) {
    const payer = createNoopSigner(PAYER);
    const call = { programAddress: SOME, accounts: [{ address: PAYER, role: AccountRole.WRITABLE_SIGNER }], data: data(1) };
    const extra = o.cosigned ? [getTransferSolInstruction({ source: createNoopSigner(key(32)), destination: key(33), amount: 1n })] : [];
    const tx = transaction([call, ...extra, ...(o.cosigned ? [] : [getTransferSolInstruction({ source: payer, destination: key(33), amount: 1n })])]);
    const simulation: Partial<Simulation> = { inner: [{ index: 0, calls: (o.calls ?? []).map((program) => ({ program, type: null })) }], innerListed: o.listed ?? true };
    // The lamport sent shows: from the wallet, or from the other signer.
    const [sender, receiver] = [key(32), key(33)];
    const after = o.cosigned ? [account(PAYER, SYSTEM, 4_995_000n), account(sender, SYSTEM, 999_999n), account(receiver, SYSTEM, 1n)] : [account(PAYER, SYSTEM, 4_994_999n), account(receiver, SYSTEM, 1n)];
    const chain = fakeChain([account(PAYER, SYSTEM, 5_000_000n), account(sender, SYSTEM, 1_000_000n)], after, simulation);
    const r = await review(tx, { wallet: PAYER, signedBefore: 0, host: 'app.example.com' }, chain);
    const p = await prepare(r, PAYER, chain);
    const told = new Map(o.told ? [[0, { name: 'Boom', args: 'x 1', accounts: [{ role: 'user', address: PAYER }], program: o.told, from: 'anchor' as const }]] : []);
    return describe(r, p, { site: siteView('https://app.example.com', { account: PAYER, signatures: 3 }), account: { label: 'Me', address: PAYER }, signer: 'ready', cluster: 'solana:mainnet', known: { tokens: new Map(), decimals: new Map(), told } });
}

test('a program Otus doesn’t know: a warning, a notice once its own IDL describes it; critical only for what it does', async () => {
    const said = (v: Awaited<ReturnType<typeof unknownCall>>) => [v.verdict, ...v.findings.filter((f) => f.tone === 'danger' || / not a program Otus knows$/.test(f.title)).map((f) => `${f.tone}: ${f.title}`)];
    const unknown = `${SOME} is not a program Otus knows`; // whole: the window cuts it short
    assert.deepEqual(said(await unknownCall()), ['warn', `warn: ${unknown}`]);
    assert.deepEqual(said(await unknownCall({ told: 'evil' })), ['ok', 'notice: Evil is not a program Otus knows']);
    // What it calls inside with your signature: moving SOL, itself, another program, all as they are; but Kamino Lend,
    // where it could act on loans of yours that no balance shows, is critical; and so is not seeing what it calls.
    assert.deepEqual(said(await unknownCall({ calls: [SYSTEM, SOME, key(40)] })), ['warn', `warn: ${unknown}`]);
    const KAMINO = 'KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD' as Address;
    assert.deepEqual(said(await unknownCall({ calls: [SYSTEM, KAMINO], told: 'evil' })), ['danger', 'danger: An unknown program uses your signature in Kamino Lend', 'notice: Evil is not a program Otus knows']);
    assert.deepEqual(said(await unknownCall({ listed: false })), ['danger', "danger: Otus can't see what an unknown program does with your signature", `warn: ${unknown}`]);
    // Without guards its own IDL binds nothing: a warning still; the Guards line says why there are none.
    const loose = await unknownCall({ cosigned: true });
    assert.deepEqual([loose.guards.held, loose.guards.text], [false, "None: Otus can't add guards because another account must sign the transaction too"]);
    assert.deepEqual(said(loose), ['warn', `warn: ${unknown}`]);
    assert.deepEqual(said(await unknownCall({ cosigned: true, told: 'evil' })), ['warn', 'warn: Evil is not a program Otus knows']);
    // A name borrowed from a program Otus knows.
    assert.deepEqual(said(await unknownCall({ told: 'jupiterAggregator' })), ['danger', 'danger: An unknown program calls itself Jupiter Aggregator', 'notice: Jupiter Aggregator is not a program Otus knows']);
});

test('a name borrowed from a brand, a wallet or a program every transaction uses, by whole words; plain words and names forks keep, no', async () => {
    const posing = async (told: string) => (await unknownCall({ told })).findings.filter((f) => f.title.includes(' calls itself ')).map((f) => f.title.replace('An unknown program calls itself ', ''));
    for (const told of ['tokenProgram', 'phantomRewards', 'pumpFunAmm', 'okxRouter', 'driftVaultsV2']) assert.equal((await posing(told)).length, 1, told);
    // One word: a brand and what its products are called, or digits read as letters, or "real" before it.
    for (const told of ['jupiterv6', 'jupiter6', 'jupiteraggregator', 'Jupiterswap', 'JUPITERAGGREGATOR', 'kaminolend', 'marginfiv2', 'raydiumamm', 'orcawhirlpool', 'jup1ter', 'realjupiter']) assert.equal((await posing(told)).length, 1, told);
    for (const told of ['pythonUtils', 'voteEscrow', 'splGovernance', 'stakePool', 'driftwood', 'memoLogger', 'orcanaut', 'tensorflow', 'mangoes']) assert.deepEqual(await posing(told), [], told);
    // The whole name of one of Solana's own programs.
    for (const told of ['System', 'token', 'Stake', 'Memo', 'UpgradeableLoader', 'native_loader']) assert.equal((await posing(told)).length, 1, told);
});

test('shows an instruction as its IDL tells it, and a program Otus doesn’t know by the name its IDL gives', async () => {
    const view = await unknownCall({ told: 'evil' });
    const program = view.programs.find((p) => p.address === SOME)!;
    assert.deepEqual([program.name, program.standing], ['Evil', 'described']);
    const ix = program.instructions[0];
    assert.deepEqual([ix.name, ix.args, ix.source, ix.accounts[0].role.split(' · ')[0]], ['Boom', 'x 1', 'idl', 'user']);
    const plain = (await unknownCall()).programs.find((p) => p.address === SOME)!;
    assert.deepEqual([plain.name, plain.standing, plain.instructions[0].source, plain.instructions[0].name], ['Unknown program', 'unknown', 'unknown', 'Unknown instruction']);
    assert.equal(view.programs.find((p) => p.address === SYSTEM)?.standing, 'known');
});
