import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { getCreateAssociatedTokenIdempotentInstruction, getTransferCheckedInstruction } from '@solana-program/token';
import { AccountRole, createNoopSigner, lamports, type Address, type Instruction, type MaybeEncodedAccount } from '@solana/kit';

import type { Chain } from '@otus-wallet/sdk/chain';
import { proposalAt, readCall, readKept, readMultisig, readProposal, SQUADS_V4, transactionAt, vaultAt } from '@otus-wallet/sdk/programs/squads';
import type { Review } from '@otus-wallet/sdk/review/review';
import type { Names } from '@otus-wallet/sdk/review/effects';
import { explain } from '@otus-wallet/sdk/review/explain';
import { notice, squadsTold, type ProposalTold } from '@otus-wallet/sdk/review/squads';
import { proposalViews } from '../src/view/squads.ts';
import { fakeChain, key } from './helpers.ts';

// Real Squads v4 instructions and the accounts they name, read from mainnet on 2026-10-05.
// Accounts are Squads' (their data) or another program's ({ data, owner }), as lookup tables.
const FIXTURES = JSON.parse(readFileSync(new URL('./squads.fixtures.json', import.meta.url), 'utf8')) as { instructions: Record<string, { data: string; accounts: Address[] }>; accounts: Record<string, string | { data: string; owner: Address }> };
const bytes = (b64: string) => new Uint8Array(Buffer.from(b64, 'base64'));
const call = (name: string) => readCall(bytes(FIXTURES.instructions[name].data), FIXTURES.instructions[name].accounts)!;
const held = (a: string) => FIXTURES.accounts[a];
const account = (a: string) => {
    const h = held(a);
    return bytes(typeof h === 'string' ? h : h.data);
};
// A transaction of these Squads instructions (null: another program's), its accounts as the chain held them on
// 2026-10-05.
function review(...names: (string | null)[]) {
    const accounts: Address[] = [SQUADS_V4, 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr' as Address];
    const instructions = names.map((name) => {
        if (name === null) return { programAddressIndex: 1, accountIndices: [], data: new Uint8Array([104, 105]) };
        const f = FIXTURES.instructions[name];
        for (const a of f.accounts) if (!accounts.includes(a)) accounts.push(a);
        return { programAddressIndex: 0, accountIndices: f.accounts.map((a) => accounts.indexOf(a)), data: bytes(f.data) };
    });
    const state = (a: Address): MaybeEncodedAccount => {
        const h = held(a);
        if (!h) return { exists: false, address: a };
        return { exists: true, address: a, data: account(a), lamports: lamports(1_000_000n), programAddress: typeof h === 'string' ? SQUADS_V4 : h.owner, executable: false, space: 0n };
    };
    const all = Object.keys(FIXTURES.accounts).map((a) => state(a as Address));
    const r = { message: { instructions }, accounts: accounts.map((a) => ({ address: a, signer: false, writable: false, table: null, state: state(a) })) } as unknown as Review;
    return { r, chain: fakeChain(all, all) };
}

// The names the review gives: none for these accounts, so each goes whole, as the review gives it; SOL and USDC known.
const names: Names = {
    wallet: 'FioYZC5CZHVQ7KsWDH6FRU5gMZV1hAgn3ykwsdGGKWv1' as Address,
    who: (a) => (a === names.wallet ? 'you' : a),
    mine: () => false,
    existed: () => true,
    mintOf: () => null,
    token: (mint) => (mint ? { symbol: 'USDC', decimals: 6, verified: true } : { symbol: 'tokens', decimals: null, verified: false }),
    program: (a) => a,
    priorityFee: null,
    payer: 'FioYZC5CZHVQ7KsWDH6FRU5gMZV1hAgn3ykwsdGGKWv1' as Address,
    changes: () => [],
};
const told = (part: Partial<ProposalTold>): ProposalTold => ({ instructions: [0], steps: ['approve'], multisig: names.wallet, number: 7n, threshold: 3, approved: 1, rejected: 0, status: 'active', inside: { kind: 'gone' }, ...part });

test('a proposal in words: what you do to it, its votes as they stand, and what its vault would do, its destination whole', async () => {
    const { r, chain } = review('proposalApprove');
    const [real] = await squadsTold(r, chain);
    const [view] = proposalViews([real], names);
    assert.equal(view.title, 'Squads proposal #23');
    assert.deepEqual([view.you, view.after], ['You approve:', 'It has 3 of 3 approvals already']);
    assert.match(view.lines[0].text, /^60,500\.321560212 SOL from vault to [1-9A-HJ-NP-Za-km-z]{32,44}$/); // the whole address it goes to
    const say = (part: Partial<ProposalTold>) => {
        const v = proposalViews([told(part)], names)[0];
        return [v.you, v.after];
    };
    assert.deepEqual(say({}), ['You approve:', '2 of 3 approvals with yours']);
    assert.deepEqual(say({ steps: ['create', 'propose', 'approve'], approved: 0 }), ['You create, propose and approve:', '1 of 3 approvals with yours']);
    assert.deepEqual(say({ steps: ['reject'] }), ['You reject:', 'It has 1 of 3 approvals']);
    assert.deepEqual(say({ steps: ['execute'], status: 'approved' }), ['You execute:', '']);
    assert.deepEqual(say({ steps: ['approve'], status: 'cancelled' }), ['You approve:', '2 of 3 approvals with yours. It was cancelled already']);
});

test("a multisig's changes and a spending limit in words, every address whole", () => {
    const member = 'F3pDQLAYVcTp6BYhfCbbyQVkkZBktLpjAm1bFzQEkhXK' as Address;
    const lines = (inside: ProposalTold['inside']) => proposalViews([told({ steps: ['create'], inside })], names)[0].lines.map((l) => [l.text, l.tone]);
    assert.deepEqual(
        lines({
            kind: 'config',
            actions: [
                { kind: 'addMember', member, permissions: 7 },
                { kind: 'threshold', threshold: 2 },
                { kind: 'addSpendingLimit', vaultIndex: 0, mint: '11111111111111111111111111111111' as Address, amount: 5_000_000_000n, period: 'day', members: [member], destinations: [] },
            ],
        }),
        [
            [`Adds a member who may propose, vote, execute: ${member}`, 'warn'],
            ['Makes it take 2 approvals', 'warn'],
            ['Adds a spending limit: up to 5 SOL a day from vault, with no vote', 'warn'],
            [`Who may use it: ${member}`, 'warn'],
            ['To any address', 'warn'],
        ],
    );
    assert.deepEqual(lines({ kind: 'spend', vault: member, amount: 20_000_000n, decimals: 9, mint: null, destination: member }), [[`0.02 SOL from vault to ${member}`, 'plain']]);
    assert.deepEqual(lines({ kind: 'gone' }), [["Otus can't find its transaction, so can't say what it runs", 'warn']]);
});

// Instructions as a carried message holds them: each account once, its roles merged, explained by Otus's plugins.
function explainedOf(ixs: Instruction[]) {
    const accounts: { address: Address; signer: boolean; writable: boolean }[] = [];
    const at = (address: Address, role?: AccountRole) => {
        let i = accounts.findIndex((a) => a.address === address);
        if (i < 0) i = accounts.push({ address, signer: false, writable: false }) - 1;
        if (role !== undefined) {
            accounts[i].signer ||= role === AccountRole.READONLY_SIGNER || role === AccountRole.WRITABLE_SIGNER;
            accounts[i].writable ||= role === AccountRole.WRITABLE || role === AccountRole.WRITABLE_SIGNER;
        }
        return i;
    };
    const instructions = ixs.map((ix) => ({ programAddressIndex: at(ix.programAddress), accountIndices: (ix.accounts ?? []).map((a) => at(a.address, a.role)), data: ix.data ?? new Uint8Array() }));
    return explain({ message: { instructions }, accounts });
}

test('tokens sent from the vault: "from vault", to the owner whole; no word on a recipient account there already', () => {
    const [vault, to, mint, source, ata] = [key(11), key(12), key(13), key(14), key(15)];
    const explained = explainedOf([
        getCreateAssociatedTokenIdempotentInstruction({ payer: createNoopSigner(vault), ata, owner: to, mint }),
        getTransferCheckedInstruction({ source, mint, destination: ata, authority: createNoopSigner(vault), amount: 12_000_000n, decimals: 6 }),
    ]);
    const inside: ProposalTold['inside'] = { kind: 'vault', vault, vaultIndex: 0, explained, accounts: [{ address: ata, exists: true, token: { mint, owner: to } }, { address: source, exists: true, token: { mint, owner: vault } }] };
    const [view] = proposalViews([told({ steps: ['create', 'propose', 'approve'], approved: 0, threshold: 2, inside })], names);
    assert.deepEqual([view.you, view.lines.map((l) => l.text), view.after], ['You create, propose and approve:', [`12 USDC from vault to ${to}`], '1 of 2 approvals with yours']);
});

test('your address shows whole, marked yours, for the window to tag', () => {
    const lines = proposalViews([told({ steps: ['setup'], inside: { kind: 'setup', threshold: 1, members: [{ key: names.wallet, permissions: 7 }], timeLock: 0 } })], names)[0].lines.map((l) => l.text);
    assert.deepEqual(lines, [`Member who may propose, vote, execute: ${names.wallet} (you)`, 'It takes 1 approval']);
});
