import assert from 'node:assert/strict';
import { test } from 'node:test';

import { COMPUTE_BUDGET_PROGRAM_ADDRESS } from '@solana-program/compute-budget';
import { findAssociatedTokenPda, TOKEN_PROGRAM_ADDRESS } from '@solana-program/token';
import { blockhash, type Address } from '@solana/kit';

import { CORE_PLUGINS } from '@otus-wallet/sdk/programs/core';
import { decode, durable } from '@otus-wallet/sdk/review/decode';
import { explain } from '@otus-wallet/sdk/review/explain';
import { fix } from '../src/send/fix.ts';
import { feeOn, transfer, units, unplain } from '../src/send/transfer.ts';
import { key, PAYER, RECIPIENT } from './helpers.ts';

const LIFETIME = { blockhash: blockhash(key(9)), lastValidBlockHeight: 100n };
const MINT = key(20);
const SOURCE = key(23);

// The transfer as Otus's own review reads it: each instruction's name, and its accounts and amounts by role.
async function read(bytes: Uint8Array) {
    const d = await decode(bytes);
    const accounts = d.message.staticAccounts.map((address, i) => ({ address, state: { exists: false as const, address }, signer: i < d.message.header.numSignerAccounts, writable: true, table: false }));
    return explain({ ...d, accounts } as never, CORE_PLUGINS).map((e): Record<string, string> => ({
        name: e.name,
        ...Object.fromEntries(e.accounts.map((a) => [a.role, a.address])),
        ...Object.fromEntries(e.args.map((a) => [a.name, a.value])),
    }));
}

test('SOL goes straight to the address; the wallet pays and alone signs', async () => {
    const bytes = await transfer(PAYER, { kind: 'wallet', address: RECIPIENT }, { kind: 'sol' }, 1_500_000_000n, LIFETIME);
    const d = await decode(bytes);
    assert.deepEqual(d.signers, [PAYER]);
    assert.equal(d.message.lifetimeToken, LIFETIME.blockhash);
    // v1, the limits in the message: the most there is, for its review; fitted when it is prepared.
    assert.equal(d.message.version, 1);
    assert.deepEqual(d.message.config, { computeUnitLimit: 1_400_000, loadedAccountsDataSizeLimit: 64 * 1024 * 1024 });
    const [ix] = await read(bytes);
    assert.deepEqual([ix.name, ix.source, ix.destination, ix.amount], ['TransferSol', PAYER, RECIPIENT, '1500000000']);
});

test('for a Ledger, v0: no limits in the message, which its Solana app could not read', async () => {
    const bytes = await transfer(PAYER, { kind: 'wallet', address: RECIPIENT }, { kind: 'sol' }, 1_500_000_000n, LIFETIME, 0);
    const d = await decode(bytes);
    assert.equal(d.message.version, 0);
    assert.equal(bytes[1 + 64], 0x80); // the message starts with v0's prefix
    const [ix] = await read(bytes);
    assert.deepEqual([ix.name, ix.source, ix.destination, ix.amount], ['TransferSol', PAYER, RECIPIENT, '1500000000']);
});

test('a token goes to the associated account of a wallet, opened if needed, or to the token account named', async () => {
    const asset = { kind: 'token' as const, mint: MINT, program: TOKEN_PROGRAM_ADDRESS, source: SOURCE, decimals: 6 };
    const [ata] = await findAssociatedTokenPda({ owner: RECIPIENT, mint: MINT, tokenProgram: TOKEN_PROGRAM_ADDRESS });
    const [open, send] = await read(await transfer(PAYER, { kind: 'wallet', address: RECIPIENT }, asset, 2_500_000n, LIFETIME));
    assert.deepEqual([open.name, open.ata, open.owner, open.payer], ['CreateAssociatedTokenIdempotent', ata, RECIPIENT, PAYER]);
    assert.deepEqual([send.name, send.source, send.destination, send.mint, send.amount, send.decimals], ['TransferChecked', SOURCE, ata, MINT, '2500000', '6']);
    const direct = await read(await transfer(PAYER, { kind: 'token-account', address: key(30) as Address }, asset, 1n, LIFETIME));
    assert.deepEqual(direct.map((ix) => [ix.name, ix.destination]), [['TransferChecked', key(30)]]);
});

test('reads an amount as typed into base units, and nothing that is not one', () => {
    assert.deepEqual([units('1.5', 9), units('0.000001', 6), units('1000', 2), units(' 2 ', 0), units('.5', 1), units('3.', 2)], [1_500_000_000n, 1n, 100_000n, 2n, 5n, 300n]);
    // A comma means a decimal in some places and thousands in others: "0,05" must never become 5.
    for (const bad of ['', '0', '0.0', '-1', '1e3', 'abc', '1.2.3', '.', '0.0000001', '0,05', '1,5', '1,000', '1,000.5']) assert.equal(units(bad, 6), null, bad);
});

test('a Token-2022 token goes in a plain transfer, unless it runs a program of its own on every transfer or cannot move', () => {
    // A mint with extensions: the base mint, padding to 165, the account type, then (type, length, value) entries.
    const mint = (...extensions: [number, Uint8Array][]) => {
        const body = extensions.flatMap(([type, value]) => [type & 255, type >> 8, value.length & 255, value.length >> 8, ...value]);
        return Uint8Array.from([...new Uint8Array(165), 1, ...body]);
    };
    const hook = (program: number) => Uint8Array.from([...new Uint8Array(32).fill(7), ...new Uint8Array(32).fill(program)]);
    const pointer = new Uint8Array(64).fill(3); // a metadata pointer
    assert.equal(unplain(new Uint8Array(82)), null); // no extensions
    assert.equal(unplain(mint([18, pointer])), null);
    assert.equal(unplain(mint([18, pointer], [14, hook(0)])), null); // a hook with no program runs nothing
    assert.match(unplain(mint([18, pointer], [14, hook(9)])) ?? '', /runs a program of its own/);
    assert.equal(unplain(mint([9, new Uint8Array(0)])), 'This token cannot be transferred');
    assert.equal(unplain(mint([1, new Uint8Array(108)])), null); // a transfer fee: Send says what it keeps
});

test('what a Token-2022 transfer fee keeps: basis points rounded up, up to its most, the larger of its fee now and the next', () => {
    const fee = (older: [bigint, number], newer: [bigint, number]) => {
        const v = new Uint8Array(108);
        const view = new DataView(v.buffer);
        for (const [at, [most, bps]] of [[72, older], [90, newer]] as const) {
            view.setBigUint64(at + 8, most, true);
            view.setUint16(at + 16, bps, true);
        }
        return Uint8Array.from([...new Uint8Array(165), 1, 1, 0, 108, 0, ...v]);
    };
    assert.equal(feeOn(fee([0n, 0], [0n, 0]), 1_000n), 0n);
    assert.equal(feeOn(fee([1_000n, 100], [1_000n, 100]), 1_001n), 11n); // 1% of 1,001, rounded up
    assert.equal(feeOn(fee([5n, 5_000], [5n, 5_000]), 1_000n), 5n); // half, but at most 5
    assert.equal(feeOn(fee([10_000n, 50], [10_000n, 5_000]), 1_000n), 500n); // the next fee, higher, counts
    assert.equal(feeOn(new Uint8Array(82), 1_000n), 0n);
});

test('taking access back: its Compute Budget limit first, then a Revoke, or a nonce moved on', async () => {
    const lifetime = { blockhash: blockhash(key(9)), lastValidBlockHeight: 0n };
    const { message } = await decode(fix(key(1), { kind: 'revoke', account: key(30), program: TOKEN_PROGRAM_ADDRESS }, lifetime));
    const program = (i: number) => message.staticAccounts[message.instructions[i].programAddressIndex];
    assert.equal(message.version, 0);
    assert.equal(program(0), COMPUTE_BUDGET_PROGRAM_ADDRESS);
    assert.equal(program(1), TOKEN_PROGRAM_ADDRESS);
    assert.deepEqual([...message.instructions[1].data], [5]);
    assert.deepEqual(message.instructions[1].accountIndices.map((i) => message.staticAccounts[i]), [key(30), key(1)]);
    const cancel = (await decode(fix(key(1), { kind: 'cancel', nonce: key(32) }, lifetime))).message;
    assert.equal(durable(cancel), false); // its advance is not first: it lives by its blockhash
    assert.deepEqual([...cancel.instructions[1].data], [4, 0, 0, 0]);
    assert.equal(cancel.staticAccounts[cancel.instructions[1].accountIndices[2]], key(1));
});
