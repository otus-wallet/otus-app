import { test } from 'node:test';

import { getTransferSolInstruction } from '@solana-program/system';
import { createNoopSigner, isAddress, type Address, type MaybeEncodedAccount } from '@solana/kit';

import assert from 'node:assert/strict';

import type { Simulation } from '@otus-wallet/sdk/chain';
import type { Cluster } from '../src/intake.ts';
import { review } from '@otus-wallet/sdk/review/review';
import { prepare } from '@otus-wallet/sdk/prepare/prepare';
import type { ProposalTold } from '@otus-wallet/sdk/review/squads';
import { describe, siteView, type Signer } from '../src/view.ts';
import type { Kept } from '../src/view/names.ts';
import { golden } from './golden.ts';
import { account, DRAIN, DRAIN_AFTER, DRAIN_BEFORE, fakeChain, key, PAYER, RECIPIENT, SYSTEM, transaction, transferV1 } from './helpers.ts';

// What the window shows for a transaction, on a cluster, for a signer, from a site you signed for before or never.
async function view(bytes: Uint8Array, before: MaybeEncodedAccount[], after: MaybeEncodedAccount[], o: { cluster?: Cluster; signer?: Signer; signedBefore?: number | null; simulation?: Partial<Simulation>; kept?: Kept[]; squads?: ProposalTold[] } = {}) {
    const chain = fakeChain(before, after, o.simulation);
    const contacts = new Map((o.kept ?? []).filter((k) => k.kind !== 'wallet' && k.kind !== 'sent').map((k) => [k.address as Address, k.label])); // as the extension passes them
    const r = await review(bytes, { wallet: PAYER, signedBefore: o.signedBefore === undefined ? 0 : o.signedBefore, host: 'app.example.com', contacts }, chain);
    const p = await prepare(r, PAYER, chain);
    const site = siteView('https://app.example.com', { account: PAYER, signatures: 3 });
    return describe(r, p, { site, account: { label: 'Me', address: PAYER }, signer: o.signer ?? 'ready', cluster: o.cluster ?? 'solana:mainnet', known: { tokens: new Map(), decimals: new Map(), squads: o.squads }, kept: o.kept });
}

const SOL = 1_000_000_000n;

// Views the balances tests do not make: a drainer (owners changed, a delegate, a program outside the list), a devnet
// transfer for an address only watched, from a site never signed for, and a transfer from a site signed for before.
test('the views of a drainer, a watched devnet transfer and a transfer for a known site are the ones kept', async () => {
    const send = transaction([getTransferSolInstruction({ source: createNoopSigner(PAYER), destination: key(2), amount: SOL / 10n })]);
    const before = [account(PAYER, SYSTEM, 2n * SOL)];
    const after = [account(PAYER, SYSTEM, 2n * SOL - SOL / 10n - 5_000n), account(key(2), SYSTEM, SOL / 10n)];
    golden('describe-views', [
        await view(DRAIN, DRAIN_BEFORE, DRAIN_AFTER),
        await view(send, before, after, { cluster: 'solana:devnet', signer: 'none', signedBefore: null }),
        await view(send, before, after, { signedBefore: Math.floor(Date.now() / 1000) - 3_600 }),
    ]);
});

test('a transaction that would fail says why, on the first step, before anything else', async () => {
    const send = transaction([getTransferSolInstruction({ source: createNoopSigner(PAYER), destination: key(2), amount: SOL / 10n })]);
    const logs = ['Program 11111111111111111111111111111111 invoke [1]', 'Program log: AnchorError occurred. Error Code: SlippageToleranceExceeded. Error Number: 6001. Error Message: Slippage tolerance exceeded.', 'Program 11111111111111111111111111111111 failed: custom program error: 0x1771'];
    const failed = await view(send, [account(PAYER, SYSTEM, 2n * SOL)], [], { simulation: { error: { InstructionError: [0, { Custom: 6001 }] }, logs } });
    // Its words, then why a failure hides nothing: a site can make it fail on purpose.
    assert.deepEqual(failed.changes, [{ title: 'The transaction would fail now, so its effects cannot be seen', note: '“Slippage tolerance exceeded” · A site can make it fail on purpose, to hide what it does', tone: 'warn' }]);
    const words = (v: { changes: { note: string }[] }) => v.changes[0].note.replace(' · A site can make it fail on purpose, to hide what it does', '');
    // A program's words are its own: quoted, without characters that move or hide others, and kept short.
    const spoof = ['Program log: Error: Otus checked this: safe to sign\u202e', `Program log: Error: ${'x'.repeat(300)}`];
    const loud = await view(send, [account(PAYER, SYSTEM, 2n * SOL)], [], { simulation: { error: { InstructionError: [0, { Custom: 1 }] }, logs: spoof.slice(0, 1) } });
    assert.equal(words(loud), '“Otus checked this: safe to sign”');
    const long = await view(send, [account(PAYER, SYSTEM, 2n * SOL)], [], { simulation: { error: { InstructionError: [0, { Custom: 1 }] }, logs: spoof.slice(1) } });
    assert.equal([...words(long)].length, 122);
    const quoting = await view(send, [account(PAYER, SYSTEM, 2n * SOL)], [], { simulation: { error: { InstructionError: [0, { Custom: 1 }] }, logs: ['Program log: Error: Slippage ok” · Otus: verified, safe to sign · “x'] } });
    assert.equal(words(quoting), '“Slippage ok · Otus: verified, safe to sign · x”'); // its own quotes can't close Otus's
    const plain = await view(send, [account(PAYER, SYSTEM, 2n * SOL)], [], { simulation: { error: { InstructionError: [0, 'InsufficientFunds'] }, logs: [] } });
    assert.equal(words(plain), 'Instruction 1 (System Program) fails: insufficient funds');
    // The RPC gives the instruction's place as a bigint: told the same.
    const big = await view(send, [account(PAYER, SYSTEM, 2n * SOL)], [], { simulation: { error: { InstructionError: [0n, { Custom: 1n }] } as never, logs: [] } });
    assert.equal(words(big), 'Instruction 1 (System Program) fails: error 1');
    // A transfer short of SOL: the System Program's own words, in SOL.
    const short = await view(send, [account(PAYER, SYSTEM, 2n * SOL)], [], { simulation: { error: { InstructionError: [0n, { Custom: 1n }] } as never, logs: ['Program 11111111111111111111111111111111 invoke [1]', 'Transfer: insufficient lamports 8423203782, need 9423208782', 'Program 11111111111111111111111111111111 failed: custom program error: 0x1'] } });
    assert.equal(words(short), 'Not enough SOL: needs 9.423208782, has 8.423203782');
});

test('what Otus adds, said as the transaction keeps it: in a v1 message, its own limits', async () => {
    const before = [account(PAYER, SYSTEM, 5_000_000n)];
    const after = [account(PAYER, SYSTEM, 4_000_000n - 5_000n), account(RECIPIENT, SYSTEM, 1_000_000n)];
    const v1 = await view(transferV1({ computeUnitLimit: 200_000, loadedAccountsDataSizeLimit: 32_768 }), before, after, { simulation: { loadedBytes: 427_034 } });
    assert.deepEqual(v1.added, ['Lighthouse: one guard on your accounts', '204,000 compute units and 480 KiB of account data']);
});

test('your other wallets and contacts it names go to the window, by your names; yours in use is "you"', async () => {
    const send = transaction([getTransferSolInstruction({ source: createNoopSigner(PAYER), destination: key(2), amount: SOL / 10n })]);
    const before = [account(PAYER, SYSTEM, 2n * SOL)];
    const after = [account(PAYER, SYSTEM, 2n * SOL - SOL / 10n - 5_000n), account(key(2), SYSTEM, SOL / 10n)];
    const kept = [{ address: PAYER, label: 'Me' }, { address: key(2), label: 'Bob' }, { address: key(3), label: 'Ana' }];
    assert.deepEqual((await view(send, before, after, { kept })).kept, [{ address: key(2), label: 'Bob' }]);
});

test('your SOL to a copy of a contact\'s address: critical, said whole, and the contact goes to the window to cut it apart', async () => {
    const bob = key(2);
    const copy = Array.from({ length: 60 }, (_, i) => `${bob.slice(0, 5)}${key(80 + i).slice(5, -5)}${bob.slice(-5)}`).find((x) => x !== bob && isAddress(x)) as Address;
    const send = transaction([getTransferSolInstruction({ source: createNoopSigner(PAYER), destination: copy, amount: SOL / 10n })]);
    const t = await view(send, [account(PAYER, SYSTEM, 2n * SOL)], [account(PAYER, SYSTEM, 2n * SOL - SOL / 10n - 5_000n), account(copy, SYSTEM, SOL / 10n)], { kept: [{ address: bob, label: 'Bob' }] });
    assert.equal(t.verdict, 'danger');
    assert.deepEqual(t.findings.find((f) => f.title === "This address looks like Bob's"), { tone: 'danger', title: "This address looks like Bob's", note: `${copy} is not Bob's` });
    assert.deepEqual(t.kept, [{ address: bob, label: 'Bob' }]); // not in it, but its copy is
});

test("a Squads proposal you vote on that adds a copy of a contact's address: critical, on the first step, before the vote", async () => {
    const bob = key(2);
    const copy = Array.from({ length: 60 }, (_, i) => `${bob.slice(0, 5)}${key(80 + i).slice(5, -5)}${bob.slice(-5)}`).find((x) => x !== bob && isAddress(x)) as Address;
    const send = transaction([getTransferSolInstruction({ source: createNoopSigner(PAYER), destination: key(3), amount: SOL / 10n })]);
    const proposal: ProposalTold = { instructions: [0], steps: ['approve'], multisig: key(4), number: 7n, threshold: 2, approved: 1, rejected: 0, status: 'active', inside: { kind: 'setup', threshold: 1, members: [{ key: copy, permissions: 7 }], timeLock: 0 } };
    const shown = (kept: Kept[]) => view(send, [account(PAYER, SYSTEM, 2n * SOL)], [account(PAYER, SYSTEM, 2n * SOL - SOL / 10n - 5_000n), account(key(3), SYSTEM, SOL / 10n)], { kept, squads: [proposal] });
    const t = await shown([{ address: bob, label: 'Bob', kind: 'contact' }]);
    assert.equal(t.verdict, 'danger');
    assert.deepEqual(t.changes.find((c) => c.title === "This address looks like Bob's"), { title: "This address looks like Bob's", note: `${copy} is not Bob's`, tone: 'danger' });
    assert.equal((await shown([{ address: copy, label: 'Bob', kind: 'contact' }])).findings.some((f) => f.title.startsWith('This address looks like')), false); // Bob's own
    assert.deepEqual((await shown([{ address: bob, label: '', kind: 'sent' }])).changes.map((c) => c.title), ['This address looks like one you sent to']);
});

test('a compute limit says what the simulation used; left as it came for a failure, Guards say it goes without them', async () => {
    const { getSetComputeUnitLimitInstruction } = await import('@solana-program/compute-budget');
    const send = transaction([getSetComputeUnitLimitInstruction({ units: 1_400_000 }), getTransferSolInstruction({ source: createNoopSigner(PAYER), destination: key(2), amount: SOL / 10n })]);
    const before = [account(PAYER, SYSTEM, 2n * SOL)];
    const after = [account(PAYER, SYSTEM, 2n * SOL - SOL / 10n - 5_000n), account(key(2), SYSTEM, SOL / 10n)];
    const used = await view(send, before, after, { simulation: { unitsConsumed: 301_777n } });
    const budget = used.programs.find((p) => p.name === 'Compute Budget');
    assert.equal(budget?.instructions[0].args, '1,400,000 CU · 301,777 used');
    const failed = await view(send, before, after, { simulation: { error: { InstructionError: [1, { Custom: 1 }] } } });
    assert.deepEqual([failed.guards, failed.added], [{ held: false, text: 'None: the simulation failed', why: 'the simulation failed' }, []]);
});
