import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { getCreateAssociatedTokenIdempotentInstruction, getTransferCheckedInstruction } from '@solana-program/token';
import { AccountRole, createNoopSigner, lamports, type Address, type Instruction, type MaybeEncodedAccount } from '@solana/kit';

import type { Chain } from '../src/chain.ts';
import { proposalAt, readCall, readKept, readMultisig, readProposal, SQUADS_V4, transactionAt, vaultAt } from '../src/programs/squads.ts';
import type { Review } from '../src/review/review.ts';
import type { Names } from '../src/review/effects.ts';
import { explain } from '../src/review/explain.ts';
import { notice, squadsTold, type ProposalTold } from '../src/review/squads.ts';
import { short } from '../src/format.ts';
import { proposalViews } from '../src/ui/view/squads.ts';
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

test('every Squads instruction Otus reads, by its discriminator: the step it takes and what it names', () => {
    const steps = Object.fromEntries(Object.keys(FIXTURES.instructions).map((name) => [name, call(name)?.step]));
    assert.deepEqual(steps, {
        proposalApprove: 'approve',
        vaultTransactionExecute: 'execute',
        proposalCreate: 'propose',
        vaultTransactionCreate: 'create',
        spendingLimitUse: 'spend',
        configTransactionExecute: 'execute',
        configTransactionCreate: 'create',
        proposalActivate: 'activate',
        batchAddTransaction: 'create',
        proposalReject: 'reject',
        batchExecuteTransaction: 'execute',
    });
    assert.equal(call('proposalCreate').index, 6129n);
    assert.equal(readCall(new Uint8Array(16), ['13sLrRAFgVtf8StMv5km5b5CX8VBqARxPp18oWSxtd3T' as Address]), null); // not one of them
});

test("a vault transaction's message: as the create instruction carries it, and as its account keeps it", () => {
    const created = call('vaultTransactionCreate');
    assert.equal(created.vaultIndex, 2);
    const kept = readKept(account(created.transaction!));
    assert.ok(kept?.kind === 'vault');
    assert.equal(kept.vaultIndex, 2);
    // The compact form and Borsh say the same transaction.
    assert.deepEqual(created.inner, kept.inner);
    assert.equal(created.inner!.instructions.length, 1);
});

test('where Squads keeps things: transactions, proposals, vaults', async () => {
    const created = call('vaultTransactionCreate');
    assert.equal(await transactionAt(created.multisig, 6129n), created.transaction);
    assert.equal(await proposalAt(call('proposalCreate').multisig, 6129n), call('proposalCreate').proposal);
    const approve = call('proposalApprove');
    const proposal = readProposal(account(approve.proposal!))!;
    assert.equal(await proposalAt(approve.multisig, proposal.index), approve.proposal);
    assert.ok(readKept(account(await transactionAt(approve.multisig, proposal.index))));
    const spend = call('spendingLimitUse');
    assert.equal(await vaultAt(spend.multisig, 0), spend.spend!.vault);
});

test('a proposal: its transaction, where it stands, who voted; the multisig: its threshold and members', () => {
    const approve = call('proposalApprove');
    const proposal = readProposal(account(approve.proposal!))!;
    assert.deepEqual([proposal.index, proposal.status, proposal.approved.length, proposal.rejected.length], [23n, 'approved', 3, 0]);
    assert.equal(proposal.multisig, approve.multisig);
    const rejected = readProposal(account(call('proposalReject').proposal!))!;
    assert.deepEqual([rejected.status, rejected.rejected.length], ['rejected', 1]);
    const multisig = readMultisig(account(approve.multisig))!;
    assert.deepEqual([multisig.threshold, multisig.members.length], [3, 4]);
    assert.equal(readProposal(account(approve.multisig)), null); // a multisig is no proposal
});

test('config changes, spending from a limit, and batches', async () => {
    assert.deepEqual(call('configTransactionCreate').actions, [{ kind: 'rentCollector', collector: '5VwZGtHBgAneWtAEuEgGkZf5J6owJzYuMgeVzwsGEUXj' }]);
    const spend = call('spendingLimitUse').spend!;
    assert.deepEqual([spend.amount, spend.decimals, spend.mint, spend.destination], [20_000_000n, 9, null, 'F3pDQLAYVcTp6BYhfCbbyQVkkZBktLpjAm1bFzQEkhXK']); // SOL
    const added = call('batchAddTransaction');
    assert.equal(added.inner!.lookups.length, 1);
    const kept = readKept(account(added.transaction!));
    assert.ok(kept?.kind === 'batchTransaction');
    assert.deepEqual(kept.inner, added.inner); // as added, as kept
    // A batch sits where the transaction of its index would: its proposal's.
    const activate = call('proposalActivate');
    const batch = readKept(account(await transactionAt(activate.multisig, readProposal(account(activate.proposal!))!.index)));
    assert.deepEqual(batch, { kind: 'batch', vaultIndex: 0, size: 1 });
});

test("data that is anyone's: cut short, running on, too long a list, or an index past the accounts, is refused", () => {
    const { data, accounts } = FIXTURES.instructions.vaultTransactionCreate;
    const full = bytes(data);
    assert.throws(() => readCall(full.slice(0, full.length - 3), accounts), /ends early/);
    // The message's first instruction names its program by an index past every account.
    const created = call('vaultTransactionCreate');
    const at = 8 + 1 + 1 + 4 + 3 + 1 + 32 * created.inner!.keys.length + 1; // to the first instruction's program index
    const broken = full.slice();
    broken[at] = 200;
    assert.throws(() => readCall(broken, accounts), /does not hold together/);
    const long = full.slice();
    long[8 + 1 + 1 + 4 + 3] = 255; // 255 account keys
    assert.throws(() => readCall(long, accounts));
});

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

test('voting on a proposal: its number, votes and standing, and what its vault would run, explained', async () => {
    const { r, chain } = review('proposalApprove');
    const [told] = await squadsTold(r, chain);
    assert.deepEqual([told.steps, told.number, told.threshold, told.approved, told.status], [['approve'], 23n, 3, 3, 'approved']);
    assert.ok(told.inside.kind === 'vault');
    assert.equal(told.inside.vault, await vaultAt(told.multisig, told.inside.vaultIndex));
    assert.ok(told.inside.explained.length === 1 && told.inside.explained[0].name !== 'Unknown instruction', told.inside.explained[0]?.name);
});

test('creating, proposing and approving in one transaction: one proposal, every step, what it carries', async () => {
    const { r, chain } = review('vaultTransactionCreate', 'proposalCreate');
    const told = await squadsTold(r, chain);
    assert.equal(told.length, 1);
    assert.deepEqual([told[0].steps, told[0].number], [['create', 'propose'], 6129n]);
    assert.equal(told[0].inside.kind, 'vault');
});

test('config changes, a spending limit used, a batch and an execution are told; data Squads would refuse is not', async () => {
    const config = (await squadsTold(...Object.values(review('configTransactionCreate')) as [Review, Chain]))[0];
    assert.deepEqual(config.inside, { kind: 'config', actions: [{ kind: 'rentCollector', collector: '5VwZGtHBgAneWtAEuEgGkZf5J6owJzYuMgeVzwsGEUXj' }] });
    const spend = (await squadsTold(...Object.values(review('spendingLimitUse')) as [Review, Chain]))[0];
    assert.equal(spend.inside.kind === 'spend' && spend.inside.amount, 20_000_000n);
    const batch = (await squadsTold(...Object.values(review('batchExecuteTransaction')) as [Review, Chain]))[0];
    assert.equal(batch.inside.kind, 'vault');
    const run = (await squadsTold(...Object.values(review('vaultTransactionExecute')) as [Review, Chain]))[0];
    assert.deepEqual([run.steps, run.number, run.inside.kind], [['execute'], 2n, 'vault']);
    const { r, chain } = review('proposalApprove');
    (r.message.instructions[0] as unknown as { data: Uint8Array }).data = r.message.instructions[0].data.slice(0, 8); // no memo option at all
    assert.deepEqual(await squadsTold(r, chain), [notice(0, 'instruction')]); // said, not left out
});

// The names the review gives: none for these accounts, so each shows short, as the review does; SOL and USDC known.
const names: Names = {
    wallet: 'FioYZC5CZHVQ7KsWDH6FRU5gMZV1hAgn3ykwsdGGKWv1' as Address,
    who: (a) => (a === names.wallet ? 'you' : short(a)),
    mine: () => false,
    existed: () => true,
    mintOf: () => null,
    token: (mint) => (mint ? { symbol: 'USDC', decimals: 6, verified: true } : { symbol: 'tokens', decimals: null, verified: false }),
    program: (a) => short(a),
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

test('a spend at place N and proposal #N stay apart: each says what it does', async () => {
    const { r, chain } = review(...Array<null>(23).fill(null), 'spendingLimitUse', 'proposalApprove');
    const told = await squadsTold(r, chain);
    assert.deepEqual(told.map((t) => [t.steps, t.inside.kind]), [[['spend'], 'spend'], [['approve'], 'vault']]);
});

test('bytes after a carried message are read past, as Squads does; past the instructions Otus reads, the rest is said unread', async () => {
    const { data, accounts } = FIXTURES.instructions.vaultTransactionCreate;
    const longer = Uint8Array.from([...bytes(data), 7]);
    assert.ok(readCall(longer, accounts)?.inner);
    const { r, chain } = review(...Array<string>(9).fill('proposalActivate'), 'proposalApprove');
    const told = await squadsTold(r, chain);
    assert.deepEqual(told.at(-1), notice(8, 'more'));
});

test("a proposal's accounts are read only when Squads keeps them: another program's data is no proposal", async () => {
    const { r, chain } = review('proposalApprove');
    const proposal = FIXTURES.instructions.proposalApprove.accounts[2];
    const slot = r.accounts.find((a) => a.address === proposal) as { state: MaybeEncodedAccount };
    slot.state = { exists: true, address: proposal, data: account(proposal), lamports: lamports(1n), programAddress: 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr' as Address, executable: false, space: 0n };
    const [told] = await squadsTold(r, chain);
    assert.equal(told.number, null); // the proposal's data, but not Squads': not read
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
