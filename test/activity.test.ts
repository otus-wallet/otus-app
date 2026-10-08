import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';

import { getTransferSolInstruction } from '@solana-program/system';
import { getCloseAccountInstruction, getCreateAssociatedTokenIdempotentInstruction, getTransferCheckedInstruction } from '@solana-program/token';
import {
    AccountRole,
    appendTransactionMessageInstructions,
    compileTransaction,
    createNoopSigner,
    createTransactionMessage,
    getBase58Decoder,
    getBase64Decoder,
    getTransactionDecoder,
    getTransactionEncoder,
    lamports,
    pipe,
    setTransactionMessageFeePayer,
    setTransactionMessageLifetimeUsingBlockhash,
    blockhash,
    createKeyPairFromPrivateKeyBytes,
    getAddressFromPublicKey,
    isAddress,
    type Address,
    type Instruction,
} from '@solana/kit';

import { exactJson, NoHistory, readPage, type Landed } from '../src/activity/history.ts';
import { summarize, type Activity } from '../src/activity/summary.ts';
import { short } from '../src/format.ts';
import { SQUADS_V4 } from '../src/programs/squads.ts';
import { apart, rows, text, type Naming } from '../src/ui/view/activity.ts';
import { key, MINT } from './helpers.ts';

// The wallet: a key's address, on the curve, as a wallet that signs has; a program's address never signs.
const WALLET = await getAddressFromPublicKey((await createKeyPairFromPrivateKeyBytes(new Uint8Array(32).fill(31))).publicKey);
const [FRIEND, PAYER] = [key(32), key(33)];
const [MY_TOKENS, THEIR_TOKENS, OTHER_MINT, JUPITER] = [key(34), key(35), key(36), 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4' as Address];
const SIGNATURE = new Uint8Array(64).fill(7);

type Side = { lamports?: Partial<Record<Address, [bigint, bigint]>>; tokens?: { address: Address; mint: Address; owner: Address; before: bigint | null; after: bigint | null; decimals?: number }[] };

// A transaction of these instructions, paid by `payer` and signed, as Helius gives it back: its meta built from the
// balances given, by address (every other account's unchanged at 1 SOL).
function item(instructions: Instruction[], payer: Address, side: Side = {}, extra: { err?: unknown; fee?: number } = {}) {
    const compiled = compileTransaction(
        pipe(
            createTransactionMessage({ version: 0 }),
            (m) => setTransactionMessageFeePayer(payer, m),
            (m) => setTransactionMessageLifetimeUsingBlockhash({ blockhash: blockhash(key(9)), lastValidBlockHeight: 0n }, m),
            (m) => appendTransactionMessageInstructions(instructions, m),
        ),
    );
    const signatures = Object.fromEntries(Object.keys(compiled.signatures).map((a) => [a, SIGNATURE]));
    const bytes = getTransactionEncoder().encode({ ...compiled, signatures } as never);
    const accounts = accountsOf(new Uint8Array(bytes));
    const fee = BigInt(extra.fee ?? 5000);
    const sol = (i: number) => side.lamports?.[accounts[i]] ?? [1_000_000_000n, 1_000_000_000n - (i === 0 ? fee : 0n)]; // the payer pays the fee
    const tokens = (when: 'before' | 'after') =>
        (side.tokens ?? []).filter((t) => t[when] !== null).map((t) => ({ accountIndex: accounts.indexOf(t.address), mint: t.mint, owner: t.owner, uiTokenAmount: { amount: String(t[when]), decimals: t.decimals ?? 6 } }));
    return {
        transaction: [getBase64Decoder().decode(bytes), 'base64'],
        slot: 400_000_000,
        blockTime: 1_791_236_675,
        meta: {
            err: extra.err ?? null,
            fee: extra.fee ?? 5000,
            preBalances: accounts.map((_, i) => Number(sol(i)[0])),
            postBalances: accounts.map((_, i) => Number(sol(i)[1])),
            preTokenBalances: tokens('before'),
            postTokenBalances: tokens('after'),
            loadedAddresses: { writable: [], readonly: [] },
        },
    };
}

// The accounts of a v0 transaction with no tables, in its order.
function accountsOf(bytes: Uint8Array): Address[] {
    const message = getTransactionDecoder().decode(bytes).messageBytes;
    // version byte, 3 header bytes, then a short-vec count (one byte here) and the addresses
    const count = message[4];
    return Array.from({ length: count }, (_, i) => getBase58Decoder().decode(message.slice(5 + 32 * i, 5 + 32 * (i + 1))) as Address);
}

async function landed(...items: unknown[]): Promise<Landed[]> {
    const page = await readPage({ result: { data: items, paginationToken: '1:2' } });
    return page.items.map((i) => {
        if ('unreadable' in i) throw new Error(i.unreadable);
        return i;
    });
}

const send = (from: Address, to: Address, sol: bigint) => getTransferSolInstruction({ source: createNoopSigner(from), destination: to, amount: lamports(sol) });
const sendTokens = (source: Address, destination: Address, authority: Address, units: bigint, mint = MINT) => getTransferCheckedInstruction({ source, mint, destination, authority: createNoopSigner(authority), amount: units, decimals: 6 });

test('a page: each transaction whole, its signature and accounts, exact lamports past 2^53, where the next starts', async () => {
    const big = 2n ** 60n + 1n;
    const text = JSON.stringify({ result: { data: [item([send(WALLET, FRIEND, 1n)], WALLET)], paginationToken: '449187227:567' } }).replace(/"postBalances":\[(\d+)/, `"postBalances":[${big}`);
    const page = await readPage(exactJson(text));
    const [t] = page.items as Landed[];
    assert.equal(t.signature, getBase58Decoder().decode(SIGNATURE));
    assert.deepEqual(t.accounts.slice(0, 2), [WALLET, FRIEND]);
    assert.equal(t.lamports.after[0], big);
    assert.equal(t.fee, 5000n);
    assert.equal(t.time, 1_791_236_675);
    assert.equal(page.next, '449187227:567');
    assert.equal((await readPage({ result: { data: [], paginationToken: '1:2' } })).next, null); // nothing after the last
    assert.deepEqual(exactJson('{"a":1e20,"b":12345678901234567890.0,"c":9007199254740993}'), { a: 1e20, b: 12345678901234567000, c: 9007199254740993n }); // only whole digits become exact
    assert.equal((await readPage({ result: { data: [item([send(WALLET, FRIEND, 1n)], WALLET)], paginationToken: 'x' } })).next, null);
});

test('an RPC without the method says so; what does not hold is unreadable, the rest read', async () => {
    await assert.rejects(readPage({ error: { code: -32601, message: 'Method not found' } }), NoHistory);
    await assert.rejects(readPage({ error: { code: -32005, message: 'rate limited' } }), /rate limited/);
    const good = item([send(WALLET, FRIEND, 1n)], WALLET);
    const short = { ...good, meta: { ...good.meta, postBalances: good.meta.postBalances.slice(1) } };
    const outOfRange = { ...good, meta: { ...good.meta, preTokenBalances: [{ accountIndex: 99, mint: MINT, owner: WALLET, uiTokenAmount: { amount: '1', decimals: 6 } }] } };
    const tables = { ...good, meta: { ...good.meta, loadedAddresses: { writable: [FRIEND], readonly: [] } } };
    const garbled = { ...good, transaction: ['AAAA', 'base64'] };
    const unsigned = { ...good, transaction: [getBase64Decoder().decode(getTransactionEncoder().encode({ ...compileTransaction(pipe(createTransactionMessage({ version: 0 }), (m) => setTransactionMessageFeePayer(WALLET, m), (m) => setTransactionMessageLifetimeUsingBlockhash({ blockhash: blockhash(key(9)), lastValidBlockHeight: 0n }, m), (m) => appendTransactionMessageInstructions([send(WALLET, FRIEND, 1n)], m))) })), 'base64'] };
    const page = await readPage({ result: { data: [short, outOfRange, tables, garbled, unsigned, good] } });
    assert.deepEqual(
        page.items.map((i) => ('unreadable' in i ? i.unreadable : 'read')),
        ['balances do not match the accounts', 'bad token account index', 'lookup accounts do not match the message', 'malformed transaction', 'unsigned', 'read'],
    );
});

test('SOL sent and received: the other side, and the fee apart from what moved', async () => {
    const [sent, got, failed] = await landed(
        item([send(WALLET, FRIEND, 1_000_000n)], WALLET, { lamports: { [WALLET]: [5_000_000n, 3_995_000n], [FRIEND]: [0n, 1_000_000n] } }),
        item([send(FRIEND, WALLET, 2_000_000n)], FRIEND, { lamports: { [FRIEND]: [5_000_000n, 2_995_000n], [WALLET]: [0n, 2_000_000n] } }),
        item([send(WALLET, FRIEND, 1_000_000n)], WALLET, { lamports: { [WALLET]: [5_000_000n, 4_995_000n] } }, { err: { InstructionError: [0, { Custom: 1 }] } }),
    );
    const s = summarize(sent, WALLET);
    assert.deepEqual([s.kind, s.other, s.moves, s.fee, s.payer], ['send', FRIEND, [{ mint: null, units: -1_000_000n, decimals: 9 }], 5000n, WALLET]);
    const g = summarize(got, WALLET);
    assert.deepEqual([g.kind, g.other, g.moves, g.payer], ['receive', FRIEND, [{ mint: null, units: 2_000_000n, decimals: 9 }], FRIEND]);
    const f = summarize(failed, WALLET);
    assert.deepEqual([f.kind, f.error, f.moves], ['other', 'instruction 1: error 1', []]);
});

test('tokens sent, opening their account: the rent set apart, the owner on the other side', async () => {
    const open = getCreateAssociatedTokenIdempotentInstruction({ payer: createNoopSigner(WALLET), ata: THEIR_TOKENS, owner: FRIEND, mint: MINT });
    const [t] = await landed(
        item([open, sendTokens(MY_TOKENS, THEIR_TOKENS, WALLET, 12_000_000n)], WALLET, {
            lamports: { [WALLET]: [10_000_000n, 7_955_720n], [THEIR_TOKENS]: [0n, 2_039_280n] },
            tokens: [
                { address: MY_TOKENS, mint: MINT, owner: WALLET, before: 50_000_000n, after: 38_000_000n },
                { address: THEIR_TOKENS, mint: MINT, owner: FRIEND, before: null, after: 12_000_000n },
            ],
        }),
    );
    const s = summarize(t, WALLET);
    assert.deepEqual([s.kind, s.other, s.moves, s.rent], ['send', FRIEND, [{ mint: MINT, units: -12_000_000n, decimals: 6 }], { yours: 0n, theirs: 2_039_280n }]); // their account, paid for
});

test('a swap through a program; an account of yours closed, its rent back; Squads steps; a memo', async () => {
    const swap = { programAddress: JUPITER, accounts: [{ address: WALLET, role: AccountRole.WRITABLE_SIGNER }, { address: MY_TOKENS, role: AccountRole.WRITABLE }], data: new Uint8Array([1]) };
    const close = getCloseAccountInstruction({ account: MY_TOKENS, destination: WALLET, owner: createNoopSigner(WALLET) });
    const discriminator = createHash('sha256').update('global:proposal_approve').digest().subarray(0, 8);
    const approve = { programAddress: SQUADS_V4, accounts: [{ address: key(40), role: AccountRole.READONLY }, { address: WALLET, role: AccountRole.WRITABLE_SIGNER }, { address: key(41), role: AccountRole.WRITABLE }], data: new Uint8Array([...discriminator, 0]) };
    const note = { programAddress: 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr' as Address, accounts: [], data: new TextEncoder().encode('rent for June') };
    const [swapped, closed, voted] = await landed(
        item([swap], WALLET, {
            lamports: { [WALLET]: [3_000_000_000n, 1_997_955_720n], [MY_TOKENS]: [0n, 2_039_280n] },
            tokens: [{ address: MY_TOKENS, mint: OTHER_MINT, owner: WALLET, before: null, after: 150_000_000n }],
        }),
        item([close], WALLET, {
            lamports: { [WALLET]: [1_000_000n, 3_034_280n], [MY_TOKENS]: [2_039_280n, 0n] },
            tokens: [{ address: MY_TOKENS, mint: MINT, owner: WALLET, before: 0n, after: null }],
        }),
        item([approve, note], WALLET),
    );
    const s = summarize(swapped, WALLET);
    assert.deepEqual([s.kind, s.main, s.rent, s.moves], ['swap', JUPITER, { yours: 2_039_280n, theirs: 0n }, [{ mint: null, units: -1_000_000_000n, decimals: 9 }, { mint: OTHER_MINT, units: 150_000_000n, decimals: 6 }]]);
    const c = summarize(closed, WALLET);
    assert.deepEqual([c.kind, c.rent, c.moves], ['other', { yours: -2_039_280n, theirs: 0n }, []]);
    const v = summarize(voted, WALLET);
    assert.deepEqual([v.kind, v.squads, v.main, v.memo], ['other', ['approve'], SQUADS_V4, 'rent for June']);
});

test('address poisoning: dust from a copy is caught against an address you know, or one that paid you on the page', async () => {
    // A copy: the real address's first and last four characters around another's middle, as poisoners grind them.
    const real = key(60);
    const copy = Array.from({ length: 30 }, (_, i) => `${real.slice(0, 4)}${key(61 + i).slice(4, -4)}${real.slice(-4)}`).find((a) => a !== real && isAddress(a)) as Address;
    const [t] = await landed(
        item([sendTokens(THEIR_TOKENS, MY_TOKENS, copy, 100n)], copy, {
            tokens: [
                { address: THEIR_TOKENS, mint: MINT, owner: copy, before: 1_000n, after: 900n },
                { address: MY_TOKENS, mint: MINT, owner: WALLET, before: 5n, after: 105n },
            ],
        }),
    );
    const dust = summarize(t, WALLET);
    assert.deepEqual([dust.kind, dust.other], ['receive', copy]);
    const naming = (known: Address[]): Naming => ({ wallet: WALLET, symbol: () => 'USDT', who: short, program: short, known });
    const flagged = (list: Activity[], known: Address[]) => rows(list, naming(known)).map((r) => r.address?.copy);
    assert.deepEqual(flagged([dust], [FRIEND, real]), [true]); // a known address it copies
    assert.deepEqual(flagged([dust], [FRIEND, copy]), [false]); // the very address, known: not a copy
    assert.deepEqual(flagged([dust], []), [false]); // nothing to copy
    // Not known: 30,000 from the real one, then dust from its copy, as the user's history shows.
    const paid: Activity = { ...dust, signature: 'paid', other: real, payer: real, moves: [{ mint: MINT, units: 30_000_000_000n, decimals: 6 }] };
    assert.deepEqual(flagged([dust, paid], []), [true, false]);
    assert.equal(text(rows([dust, paid], naming([]))[0].sub), `from ${apart(copy, real)} · copies ${apart(real, copy)}`);
});

test('rows: each in a line, opened for all it told; a copy of an address you sent to on the page caught', () => {
    const base = { time: 1_791_236_675, error: null, fee: 5000n, payer: WALLET, rent: { yours: 0n, theirs: 0n }, signed: true, programs: [] as Address[], main: null, squads: [], memo: null };
    const naming: Naming = { wallet: WALLET, symbol: (m) => (m === MINT ? 'USDC' : short(m)), who: (a) => (a === WALLET ? `${short(a)} (you)` : a === FRIEND ? 'Fio' : short(a)), program: (a) => (a === JUPITER ? 'Jupiter v6' : short(a)), known: [] };
    const real = key(60);
    const copy = Array.from({ length: 30 }, (_, i) => `${real.slice(0, 4)}${key(61 + i).slice(4, -4)}${real.slice(-4)}`).find((a) => a !== real && isAddress(a)) as Address;
    const [swap, sent, dust, failed, unread] = rows(
        [
            { ...base, signature: 's1', kind: 'swap', other: null, main: JUPITER, programs: [JUPITER], moves: [{ mint: null, units: -1_000_000_000n, decimals: 9 }, { mint: MINT, units: 120_580_000n, decimals: 6 }] },
            { ...base, signature: 's2', kind: 'send', other: real, moves: [{ mint: MINT, units: -12_000_000n, decimals: 6 }], rent: { yours: 0n, theirs: 2_039_280n } },
            { ...base, signature: 's3', kind: 'receive', other: copy, payer: copy, moves: [{ mint: MINT, units: 100n, decimals: 6 }] },
            { ...base, signature: 's4', kind: 'other', error: 'instruction 2: error 6001', main: JUPITER, programs: [JUPITER], other: null, moves: [] },
            { unreadable: 'no meta' },
        ],
        naming,
    );
    assert.deepEqual([swap.icon, text(swap.title), text(swap.sub)], ['swap', 'Swap 1 SOL → 120.58 USDC', 'Jupiter v6']);
    assert.deepEqual(swap.title.filter((p) => p.way), [{ text: '1 SOL', way: 'out' }, { text: '120.58 USDC', way: 'in' }]); // coloured apart
    assert.deepEqual([text(sent.title), text(sent.sub), sent.address], ['Sent 12 USDC', `to ${apart(real, copy)}`, { label: 'To', address: real, name: null, copy: false }]); // its copy on the page
    assert.deepEqual(sent.details.map((d) => d.text), ['−12 USDC', '0.00203928 SOL to open their token account', `Fee 0.000005 SOL, paid by ${short(WALLET)} (you)`]); // your address, tagged
    const [it, was] = [apart(copy, real), apart(real, copy)];
    assert.notEqual(it, was); // where short() gives both the same
    assert.equal(short(copy), short(real));
    assert.deepEqual([dust.tone, text(dust.title), text(dust.sub)], ['warn', 'Received 0.0001 USDC', `from ${it} · copies ${was}`]);
    assert.equal(dust.details[1].text, `Dust from ${it}, made to look like ${was}: never send to it`);
    assert.equal(dust.details.find((d) => d.text.startsWith('Fee'))?.text, `Fee 0.000005 SOL, paid by ${it}`);
    assert.equal(dust.address?.copy, true);
    assert.deepEqual([failed.icon, failed.tone, text(failed.title), failed.details[0].text], ['cross', 'danger', 'Failed · Jupiter v6', 'Failed: instruction 2: error 6001']);
    assert.deepEqual([text(unread.title), unread.signature], ["Otus couldn't read this one", null]);
});

test("rent stays the wallet's own: wrapping SOL, closing while sending, rent sent elsewhere, rent others pay", async () => {
    const [MY_WSOL, ELSEWHERE, RELAYER] = [key(42), key(43), key(44)];
    const WSOL = 'So11111111111111111111111111111111111111112' as Address;
    const RENT = 2_039_280n;
    const open = (ata: Address, owner: Address, mint: Address, payer = WALLET) => getCreateAssociatedTokenIdempotentInstruction({ payer: createNoopSigner(payer), ata, owner, mint });
    const close = (to: Address) => getCloseAccountInstruction({ account: MY_TOKENS, destination: to, owner: createNoopSigner(WALLET) });
    const [wrap, closeAndSend, closedAway, relayed, opened] = await landed(
        // 1 SOL wrapped into a wSOL account the wallet opens
        item([open(MY_WSOL, WALLET, WSOL), send(WALLET, MY_WSOL, 1_000_000_000n)], WALLET, {
            lamports: { [WALLET]: [3_000_000_000n, 3_000_000_000n - 1_000_000_000n - RENT - 5000n], [MY_WSOL]: [0n, 1_000_000_000n + RENT] },
            tokens: [{ address: MY_WSOL, mint: WSOL, owner: WALLET, before: null, after: 1_000_000_000n, decimals: 9 }],
        }),
        // an empty account closed, its rent back, and 0.1 SOL sent
        item([close(WALLET), send(WALLET, FRIEND, 100_000_000n)], WALLET, {
            lamports: { [WALLET]: [1_000_000_000n, 1_000_000_000n + RENT - 100_000_000n - 5000n], [MY_TOKENS]: [RENT, 0n], [FRIEND]: [0n, 100_000_000n] },
            tokens: [{ address: MY_TOKENS, mint: MINT, owner: WALLET, before: 0n, after: null }],
        }),
        // closed, its rent sent to another address
        item([close(ELSEWHERE)], WALLET, {
            lamports: { [WALLET]: [1_000_000_000n, 1_000_000_000n - 5000n], [MY_TOKENS]: [RENT, 0n], [ELSEWHERE]: [0n, RENT] },
            tokens: [{ address: MY_TOKENS, mint: MINT, owner: WALLET, before: 0n, after: null }],
        }),
        // a relayer pays the fee; the wallet opens its friend's account and sends 12
        item([open(THEIR_TOKENS, FRIEND, MINT), sendTokens(MY_TOKENS, THEIR_TOKENS, WALLET, 12_000_000n)], RELAYER, {
            lamports: { [RELAYER]: [1_000_000_000n, 1_000_000_000n - 5000n], [WALLET]: [1_000_000_000n, 1_000_000_000n - RENT], [THEIR_TOKENS]: [0n, RENT] },
            tokens: [
                { address: MY_TOKENS, mint: MINT, owner: WALLET, before: 50_000_000n, after: 38_000_000n },
                { address: THEIR_TOKENS, mint: MINT, owner: FRIEND, before: null, after: 12_000_000n },
            ],
        }),
        // someone sends the wallet 12, opening its account themselves
        item([open(MY_TOKENS, WALLET, MINT, FRIEND), sendTokens(THEIR_TOKENS, MY_TOKENS, FRIEND, 12_000_000n)], FRIEND, {
            lamports: { [FRIEND]: [1_000_000_000n, 1_000_000_000n - RENT - 5000n], [MY_TOKENS]: [0n, RENT] },
            tokens: [
                { address: THEIR_TOKENS, mint: MINT, owner: FRIEND, before: 50_000_000n, after: 38_000_000n },
                { address: MY_TOKENS, mint: MINT, owner: WALLET, before: null, after: 12_000_000n },
            ],
        }),
    );
    const sum = (t: Landed) => {
        const s = summarize(t, WALLET);
        return [s.kind, s.moves.map((m) => `${m.mint === null ? 'SOL' : m.mint === WSOL ? 'wSOL' : 'token'} ${m.units}`), s.rent.yours, s.rent.theirs];
    };
    assert.deepEqual(sum(wrap), ['swap', ['SOL -1000000000', 'wSOL 1000000000'], RENT, 0n]);
    assert.deepEqual(sum(closeAndSend), ['send', ['SOL -100000000'], -RENT, 0n]);
    assert.deepEqual(sum(closedAway), ['send', ['SOL -2039280'], -RENT, 0n]);
    assert.equal(summarize(closedAway, WALLET).other, ELSEWHERE);
    assert.deepEqual(sum(relayed), ['send', ['token -12000000'], 0n, RENT]);
    assert.deepEqual(sum(opened), ['receive', ['token 12000000'], RENT, 0n]);
});

test('what left the wallet unsigned, a delegate moved: told apart, and never taken as an address you know', async () => {
    const [DELEGATE, copy] = [key(45), key(46)];
    const [taken] = await landed(
        item([sendTokens(MY_TOKENS, THEIR_TOKENS, DELEGATE, 1n)], DELEGATE, {
            tokens: [
                { address: MY_TOKENS, mint: MINT, owner: WALLET, before: 5n, after: 4n },
                { address: THEIR_TOKENS, mint: MINT, owner: copy, before: 0n, after: 1n },
            ],
        }),
    );
    const a = summarize(taken, WALLET);
    assert.deepEqual([a.kind, a.signed, a.other], ['send', false, copy]);
    // A program's address (a Squads vault) never signs: its program moves it, no delegate.
    const vault = (await import('@solana/kit')).getProgramDerivedAddress;
    const [VAULT] = await vault({ programAddress: SQUADS_V4, seeds: ['vault'] });
    const [byProgram] = await landed(
        item([sendTokens(key(47), THEIR_TOKENS, VAULT, 1n)], PAYER, {
            tokens: [
                { address: key(47), mint: MINT, owner: VAULT, before: 5n, after: 4n },
                { address: THEIR_TOKENS, mint: MINT, owner: FRIEND, before: 0n, after: 1n },
            ],
        }),
    );
    assert.deepEqual([summarize(byProgram, VAULT).kind, summarize(byProgram, VAULT).signed], ['send', true]);
    const naming: Naming = { wallet: WALLET, symbol: () => 'USDC', who: short, program: short, known: [] };
    const [row] = rows([a], naming);
    assert.deepEqual([row.tone, text(row.title)], ['warn', 'Moved 0.000001 USDC']);
    assert.equal(row.details.find((d) => d.tone === 'warn')?.text, "You didn't sign it: a delegate of your tokens moved them");
});
