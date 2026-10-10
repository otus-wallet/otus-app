import assert from 'node:assert/strict';
import { test } from 'node:test';

import { TOKEN_PROGRAM_ADDRESS } from '@solana-program/token';
import { address, type Address } from '@solana/kit';

import type { MintTerms } from '@otus-wallet/sdk/access/mint';
import { TOKEN_2022_PROGRAM_ADDRESS } from '@otus-wallet/sdk/programs/addresses';
import { tokenFacts } from '../src/view/token.ts';

const A = address('2apBGMsS6ti9RyF5TwQTDswXBWskiJP2LD4cUEDqYJjk');
const who = (a: Address) => `${a.slice(0, 4)}…`;
const terms = (o: Partial<MintTerms> = {}): MintTerms => ({ program: TOKEN_PROGRAM_ADDRESS, supply: 1_234_500_000n, decimals: 6, mintAuthority: null, freezeAuthority: null, extensions: [], unknown: [], ...o });

test('a plain token: no one can mint or freeze, its metadata fixed, its supply and program', () => {
    assert.deepEqual(tokenFacts(terms(), { mutable: false, updateAuthority: A, where: 'metaplex' }, 'JUP', who), [
        { name: 'Mint authority', value: 'None' },
        { name: 'Freeze authority', value: 'None' },
        { name: 'Metadata', value: 'Immutable' },
        { name: 'Supply', value: '1,234.5 JUP' },
        { name: 'Program', value: 'Token' },
    ]);
    // Without metadata Otus reads, that line is left out.
    assert.deepEqual(tokenFacts(terms({ mintAuthority: A, freezeAuthority: A }), null, 'USDC', who).slice(0, 3).map((f) => f.value), ['2apB…', '2apB…', '1,234.5 USDC']);
});

test('Token-2022’s extensions: who can take or stop yours is a warning; what Otus cannot read is said', () => {
    const facts = tokenFacts(
        terms({
            program: TOKEN_2022_PROGRAM_ADDRESS,
            extensions: [
                { kind: 'permanentDelegate', delegate: A },
                { kind: 'transferFee', authority: A, older: { epoch: 1n, max: 9n, bps: 250 }, newer: { epoch: 2n, max: 9n, bps: 100 } },
                { kind: 'transferHook', authority: null, program: null },
                { kind: 'pausable', authority: A, paused: true },
                { kind: 'defaultState', frozen: true },
                { kind: 'nonTransferable' },
                { kind: 'closeAuthority', authority: null },
                { kind: 'permissionedBurn', authority: A },
                { kind: 'metadataPointer', authority: A, metadata: A },
                { kind: 'other', name: 'Confidential transfers' },
                { kind: 'other', name: 'Scaled UI amount' },
            ],
            unknown: [40, 41],
        }),
        { mutable: true, updateAuthority: A, where: 'mint' },
        'PYUSD',
        who,
    );
    assert.deepEqual(facts.slice(2), [
        { name: 'Metadata', value: 'Mutable' },
        { name: 'Permanent delegate', value: '2apB…', warn: true },
        { name: 'Transfer fee', value: '2.5%' },
        { name: 'Transfers', value: 'Paused', warn: true },
        { name: 'New accounts', value: 'Start frozen' },
        { name: 'Transfers', value: 'Not allowed' },
        { name: 'Burn authority', value: '2apB…' },
        { name: 'Extensions', value: 'Confidential transfers, Scaled UI amount' },
        { name: 'Unreadable', value: '2 extensions', warn: true },
        { name: 'Supply', value: '1,234.5 PYUSD' },
        { name: 'Program', value: 'Token-2022' },
    ]);
    // Not paused: who can pause it.
    assert.deepEqual(tokenFacts(terms({ extensions: [{ kind: 'pausable', authority: A, paused: false }] }), null, 'X', who)[2], { name: 'Pause authority', value: '2apB…' });
});
