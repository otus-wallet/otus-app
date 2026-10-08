import assert from 'node:assert/strict';
import { test } from 'node:test';

import { getSetComputeUnitPriceInstruction } from '@solana-program/compute-budget';
import { getAddMemoInstruction } from '@solana-program/memo';
import { getCreateAssociatedTokenIdempotentInstruction, getTransferCheckedInstruction } from '@solana-program/token';
import { AccountRole, createNoopSigner, type Instruction } from '@solana/kit';

import { CORE_PLUGINS, TOKEN_2022_PROGRAM_ADDRESS } from '../src/programs/core.ts';
import type { Plugin } from '../src/programs/plugin.ts';
import { decode } from '../src/review/decode.ts';
import { explain } from '../src/review/explain.ts';
import { resolve } from '../src/review/resolve.ts';
import { fakeChain, key, PAYER, RECIPIENT, SYSTEM, transaction, transfer, TRANSFER_DATA } from './helpers.ts';

const MINT = key(20);
const SOURCE = key(21);
const DESTINATION = key(22);
const UNKNOWN_PROGRAM = key(30);
const payer = createNoopSigner(PAYER);

const explained = async (bytes: Uint8Array, plugins?: Plugin[]) =>
    explain(await resolve(await decode(bytes), fakeChain([])), plugins);

test('names a System transfer, its accounts and its amount', async () => {
    assert.deepEqual(await explained(transfer()), [
        {
            program: SYSTEM,
            programName: 'System Program',
            source: 'plugin',
            name: 'TransferSol',
            accounts: [
                { role: 'source', address: PAYER },
                { role: 'destination', address: RECIPIENT },
            ],
            args: [{ name: 'amount', value: '1000000' }],
            data: TRANSFER_DATA,
        },
    ]);
});

test('names Compute Budget, Token, Associated Token and Memo instructions', async () => {
    const tx = transaction([
        getSetComputeUnitPriceInstruction({ microLamports: 50_000n }),
        getCreateAssociatedTokenIdempotentInstruction({ payer, ata: DESTINATION, owner: RECIPIENT, mint: MINT }),
        getTransferCheckedInstruction({ source: SOURCE, mint: MINT, destination: DESTINATION, authority: payer, amount: 2_500n, decimals: 6 }),
        getAddMemoInstruction({ memo: 'thanks' }),
    ]);
    const out = await explained(tx);
    assert.deepEqual(
        out.map((e) => [e.programName, e.name, e.args.map((a) => `${a.name}=${a.value}`).join(' ')]),
        [
            ['Compute Budget', 'SetComputeUnitPrice', 'microLamports=50000'],
            ['Associated Token', 'CreateAssociatedTokenIdempotent', ''],
            ['Token Program', 'TransferChecked', 'amount=2500 decimals=6'],
            ['Memo', 'AddMemo', 'memo=thanks'],
        ],
    );
    assert.deepEqual(out[2].accounts.map((a) => a.role), ['source', 'mint', 'destination', 'authority']);
});

test('Token-2022 base instructions read like Token ones; its extensions stay unknown', async () => {
    const checked = getTransferCheckedInstruction(
        { source: SOURCE, mint: MINT, destination: DESTINATION, authority: payer, amount: 1n, decimals: 0 },
        { programAddress: TOKEN_2022_PROGRAM_ADDRESS },
    );
    // 38 is WithdrawExcessLamports in both; 26, 45 and 255 are Token-2022 extensions, or Token instructions it does not have.
    const raw = (...data: number[]): Instruction => ({
        programAddress: TOKEN_2022_PROGRAM_ADDRESS,
        accounts: [
            { address: SOURCE, role: AccountRole.WRITABLE },
            { address: DESTINATION, role: AccountRole.WRITABLE },
            { address: PAYER, role: AccountRole.READONLY_SIGNER },
        ],
        data: new Uint8Array(data),
    });
    const out = await explained(transaction([checked, raw(38), raw(26, 1), raw(45, 0), raw(255, 2, 3, 9, 9, 9)]));
    assert.deepEqual(out.map((e) => [e.name, e.source]), [
        ['TransferChecked', 'plugin'],
        ['WithdrawExcessLamports', 'plugin'],
        ['Unknown instruction', 'unknown'],
        ['Unknown instruction', 'unknown'],
        ['Unknown instruction', 'unknown'],
    ]);
});

test('an unknown program, or a plugin that throws, leaves the instruction unknown', async () => {
    const ix: Instruction = {
        programAddress: UNKNOWN_PROGRAM,
        accounts: [{ address: PAYER, role: AccountRole.WRITABLE_SIGNER }],
        data: new Uint8Array([1]),
    };
    const [unknown] = await explained(transaction([ix]));
    assert.deepEqual(unknown, {
        program: UNKNOWN_PROGRAM,
        programName: null,
        source: 'unknown',
        name: 'Unknown instruction',
        accounts: [{ role: 'account 1', address: PAYER }],
        args: [],
        data: new Uint8Array([1]),
    });
    const broken: Plugin = { program: UNKNOWN_PROGRAM, name: 'Broken', explain: () => { throw new Error('bug'); } };
    const [fromBroken] = await explained(transaction([ix]), [broken]);
    assert.deepEqual([fromBroken.programName, fromBroken.source], ['Broken', 'unknown']);
});

test('one plugin per program', () => {
    assert.equal(new Set(CORE_PLUGINS.map((p) => p.program)).size, CORE_PLUGINS.length);
});
