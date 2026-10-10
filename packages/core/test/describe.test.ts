import { test } from 'node:test';

import { getTransferSolInstruction } from '@solana-program/system';
import { createNoopSigner, type MaybeEncodedAccount } from '@solana/kit';

import assert from 'node:assert/strict';

import type { Simulation } from '@otus-wallet/sdk/chain';
import type { Cluster } from '../src/intake.ts';
import { review } from '@otus-wallet/sdk/review/review';
import { prepare } from '@otus-wallet/sdk/prepare/prepare';
import { describe, siteView, type Signer } from '../src/view.ts';
import { golden } from './golden.ts';
import { account, DRAIN, DRAIN_AFTER, DRAIN_BEFORE, fakeChain, key, PAYER, RECIPIENT, SYSTEM, transaction, transferV1 } from './helpers.ts';

// What the window shows for a transaction, on a cluster, for a signer, from a site you signed for before or never.
async function view(bytes: Uint8Array, before: MaybeEncodedAccount[], after: MaybeEncodedAccount[], o: { cluster?: Cluster; signer?: Signer; signedBefore?: number | null; simulation?: Partial<Simulation>; kept?: { address: string; label: string }[] } = {}) {
    const chain = fakeChain(before, after, o.simulation);
    const r = await review(bytes, { wallet: PAYER, signedBefore: o.signedBefore === undefined ? 0 : o.signedBefore, host: 'app.example.com' }, chain);
    const p = await prepare(r, PAYER, chain);
    const site = siteView('https://app.example.com', { account: PAYER, signatures: 3 });
    return describe(r, p, { site, account: { label: 'Me', address: PAYER }, signer: o.signer ?? 'ready', cluster: o.cluster ?? 'solana:mainnet', known: { tokens: new Map(), decimals: new Map() }, kept: o.kept });
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
    assert.deepEqual(failed.changes, [{ title: 'The transaction would fail now, so its effects cannot be seen', note: '“Slippage tolerance exceeded”', tone: 'danger' }]);
    // A program's words are its own: quoted, without characters that move or hide others, and kept short.
    const spoof = ['Program log: Error: Otus checked this: safe to sign\u202e', `Program log: Error: ${'x'.repeat(300)}`];
    const loud = await view(send, [account(PAYER, SYSTEM, 2n * SOL)], [], { simulation: { error: { InstructionError: [0, { Custom: 1 }] }, logs: spoof.slice(0, 1) } });
    assert.equal(loud.changes[0].note, '“Otus checked this: safe to sign”');
    const long = await view(send, [account(PAYER, SYSTEM, 2n * SOL)], [], { simulation: { error: { InstructionError: [0, { Custom: 1 }] }, logs: spoof.slice(1) } });
    assert.equal([...long.changes[0].note].length, 122);
    const quoting = await view(send, [account(PAYER, SYSTEM, 2n * SOL)], [], { simulation: { error: { InstructionError: [0, { Custom: 1 }] }, logs: ['Program log: Error: Slippage ok” · Otus: verified, safe to sign · “x'] } });
    assert.equal(quoting.changes[0].note, '“Slippage ok · Otus: verified, safe to sign · x”'); // its own quotes can't close Otus's
    const plain = await view(send, [account(PAYER, SYSTEM, 2n * SOL)], [], { simulation: { error: { InstructionError: [0, 'InsufficientFunds'] }, logs: [] } });
    assert.equal(plain.changes[0].note, 'Instruction 1 (System Program) fails: insufficient funds');
    // The RPC gives the instruction's place as a bigint: told the same.
    const big = await view(send, [account(PAYER, SYSTEM, 2n * SOL)], [], { simulation: { error: { InstructionError: [0n, { Custom: 1n }] } as never, logs: [] } });
    assert.equal(big.changes[0].note, 'Instruction 1 (System Program) fails: error 1');
    // A transfer short of SOL: the System Program's own words, in SOL.
    const short = await view(send, [account(PAYER, SYSTEM, 2n * SOL)], [], { simulation: { error: { InstructionError: [0n, { Custom: 1n }] } as never, logs: ['Program 11111111111111111111111111111111 invoke [1]', 'Transfer: insufficient lamports 8423203782, need 9423208782', 'Program 11111111111111111111111111111111 failed: custom program error: 0x1'] } });
    assert.equal(short.changes[0].note, 'Not enough SOL: needs 9.423208782, has 8.423203782');
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
