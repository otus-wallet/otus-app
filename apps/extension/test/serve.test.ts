import assert from 'node:assert/strict';
import { test } from 'node:test';

import { getTransferSolInstruction } from '@solana-program/system';
import { findAssociatedTokenPda, getCloseAccountInstruction, getCreateAssociatedTokenIdempotentInstruction, getRevokeInstruction, getSyncNativeInstruction, TOKEN_PROGRAM_ADDRESS } from '@solana-program/token';
import {
    AccountRole,
    address,
    appendTransactionMessageInstruction,
    blockhash,
    compileTransaction,
    compressTransactionMessageUsingAddressLookupTables,
    createNoopSigner,
    createTransactionMessage,
    generateKeyPair,
    getAddressEncoder,
    getAddressFromPublicKey,
    getBase58Encoder,
    getBase64Decoder,
    getBase58Decoder,
    getBase64Encoder,
    getSolanaErrorFromJsonRpcError,
    getTransactionDecoder,
    getTransactionEncoder,
    lamports,
    pipe,
    setTransactionMessageFeePayer,
    setTransactionMessageLifetimeUsingBlockhash,
    signBytes,
    SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR,
    SolanaError,
    verifySignature,
    type Address,
    type Blockhash,
    type SignatureBytes,
} from '@solana/kit';

import { LIGHTHOUSE } from '@otus-wallet/sdk/programs/addresses';
import { Refused, type Reply } from '@otus-wallet/core/protocol.ts';
import { decode } from '@otus-wallet/sdk/review/decode';
import { LOOKUP_TABLE_PROGRAM } from '@otus-wallet/sdk/review/resolve';
import { transfer as sendTransfer } from '@otus-wallet/core/send/transfer.ts';
import { send } from '@otus-wallet/core/send/send.ts';
import { DEFAULT_SETTINGS, OTUS_RPC } from '@otus-wallet/core/settings.ts';
import type { Answer } from '../src/shell/approvals.ts';
import { fix } from '@otus-wallet/core/send/fix.ts';
import { own, serve, stakeOwn, swapOwn, takeBack, type Shell } from '../src/shell/serve.ts';
import { SENDER_TIPS, swapping, TIP } from '@otus-wallet/core/swap/build.ts';
import { JUPITER, type Route } from '@otus-wallet/core/swap/route.ts';
import type { Asked } from '@otus-wallet/core/swap/terms.ts';
import { staking, stakeAt } from '@otus-wallet/core/send/stake.ts';
import { getCompiledTransactionMessageDecoder, getCompiledTransactionMessageEncoder } from '@solana/kit';
import { followed } from '../src/shell/transaction.ts';
import type { Review } from '@otus-wallet/sdk/review/review';
import type { Status } from '@otus-wallet/sdk/chain';
import { getSetComputeUnitPriceInstruction } from '@solana-program/compute-budget';
import type { Chain } from '@otus-wallet/sdk/chain';
import type { State } from '@otus-wallet/core/state.ts';
import type { Approval, Outcome } from '@otus-wallet/core/view.ts';
import { account, fakeChain, key, SYSTEM, tokenAccountData } from '@otus-wallet/core/test/helpers.ts';

const ORIGIN = 'https://jup.ag';
const base64 = (b: Uint8Array) => getBase64Decoder().decode(b);
const bytes = (s: string) => new Uint8Array(getBase64Encoder().encode(s));

const NOW = 1_791_000_000_000; // ms: the fake extension's time
const LEDGER_PATH = "44'/501'/0'/0'";

/** A wallet with a real key, a site connected to it, and a fake extension around serve. `chain` changes the network's
 *  answers; sends are watched without waiting between checks. */
async function wallet(o: { key?: boolean; ledger?: boolean; locked?: boolean; answer?: (a: Approval, s: { state: State }) => Answer | Promise<Answer>; validOn?: string[]; chain?: Partial<Chain>; slow?: number; early?: boolean | 'no' } = {}) {
    const pair = await generateKeyPair();
    const me = await getAddressFromPublicKey(pair.publicKey);
    const box = {
        state: {
            accounts: [{ address: me, label: 'Me', ...(o.ledger ? { ledger: { path: LEDGER_PATH } } : o.key !== false && { key: { secret: 's', index: 0 } }) }],
            active: me,
            sites: { [ORIGIN]: { account: me, signatures: 0 } },
            contacts: [],
            sent: {},
            removed: [],
            waiting: [],
            given: [],
            signedHere: {},
            outside: {},
            disconnected: [],
            settings: DEFAULT_SETTINGS,
        } as State,
    };
    const approvals: Approval[] = [];
    const firsts: Approval[] = []; // the first form of each, shown before it is prepared
    const shownAt: { first: number[]; final: number[] } = { first: [], final: [] }; // when each form came
    const sent: Uint8Array[] = [];
    const quick = fakeChain([account(me, SYSTEM, 5_000_000_000n)], [account(me, SYSTEM, 4_998_995_000n), account(key(2), SYSTEM, 1_000_000n)], {}, {
        send: async (tx) => void sent.push(tx),
        status: async () => ({ error: null, confirmed: true }),
        ...o.chain,
    });
    // `slow`: every answer of the network takes that many ms, as a round trip does.
    const chain: Chain = o.slow
        ? (Object.fromEntries(Object.entries(quick).map(([k, f]) => [k, async (...args: unknown[]) => (await new Promise((r) => setTimeout(r, o.slow)), (f as (...a: unknown[]) => unknown)(...args))])) as unknown as Chain)
        : quick;
    const looked: string[][] = []; // the mints Jupiter was asked about
    const outcomes: Outcome[] = []; // what approved windows heard
    const settled = { count: 0 }; // how many times Otus's pages were told a transaction landed
    const following = { count: 0 }; // windows kept after a yes, to hear how it goes
    const warmed = { count: 0 }; // times the network was reached ahead
    // `early`: windows opened before the review, and why each ended unanswered (true: on a no); 'no': the user says no
    // at once, in the window still waiting for the review.
    const opened: { first: Approval; at: number; closed: string | boolean }[] = [];
    // As the window: the first form shown, the final one (when it comes) the only one answered.
    const asking: Shell['approve'] = async (a, _follow, later, after) => {
            firsts.push(a);
            shownAt.first.push(performance.now());
            const final = later ? await later : a;
            shownAt.final.push(performance.now());
            approvals.push(final);
            const answer = o.answer ? await o.answer(final, box) : true;
            if (answer !== false && after) (following.count++, after((outcome) => outcomes.push(outcome))); // the window stays, and hears how it goes
            return answer;
    };
    const shell: Shell = {
        load: async () => box.state,
        update: async (change) => void (box.state = { ...box.state, ...(change(box.state) ?? {}) }),
        // A site's transaction asks in the window opened for it early, when there is one.
        approve: (a, ...rest) => (o.early && a.kind === 'transaction' && a.site.origin.startsWith('https:') ? Promise.reject(new Error('asked outside its window')) : asking(a, ...rest)),
        sign: async (_account, data): Promise<SignatureBytes> => {
            if (o.locked) throw new Refused('Otus is locked');
            return signBytes(pair.privateKey, data);
        },
        chain: (rpc) => ({ ...chain, valid: o.chain?.valid ?? (async () => !o.validOn || o.validOn.includes(rpc)) }), // validOn: the RPCs that know the blockhash
        send: (tx, on) => send(tx, on, async () => {}),
        tokens: async (mints) => (looked.push(mints), new Map()),
        now: () => NOW,
        settled: () => void settled.count++,
        warm: () => void warmed.count++,
        ...(o.early && {
            early: (first: Approval) => {
                const window: (typeof opened)[number] = { first, at: performance.now(), closed: false };
                opened.push(window);
                // Said no at once, as the real window, it answers no to what comes after.
                return { approve: o.early === 'no' ? async () => false : asking, no: o.early === 'no' ? Promise.resolve() : new Promise<void>(() => {}), close: (why) => void (window.closed = why ?? true) };
            },
        }),
    };
    // A transfer of 0.001 SOL to key(2) from `from`, its fee paid by `payer`.
    const transfer = (from: Address = me, payer: Address = from, version: 0 | 1 = 0) =>
        base64(
            new Uint8Array(
                getTransactionEncoder().encode(
                    compileTransaction(
                        pipe(
                            createTransactionMessage({ version }),
                            (m) => setTransactionMessageFeePayer(payer, m),
                            (m) => setTransactionMessageLifetimeUsingBlockhash({ blockhash: blockhash(key(9)), lastValidBlockHeight: 0n }, m),
                            (m) => appendTransactionMessageInstruction(getTransferSolInstruction({ source: createNoopSigner(from), destination: key(2), amount: lamports(1_000_000n) }), m),
                        ),
                    ),
                ),
            ),
        );
    const call = (method: string, params: object, origin = ORIGIN) => serve({ method, params }, origin, shell);
    return { me, pair, box, approvals, firsts, shownAt, sent, looked, outcomes, settled, following, warmed, opened, transfer, call, shell };
}

const result = <T>(reply: Reply): T => {
    assert.ok(reply.ok, reply.ok ? '' : reply.error);
    return reply.result as T;
};

test('signs the transaction as approved, guards and fees included, with your signature in its place', async () => {
    const w = await wallet();
    const { transactions } = result<{ transactions: string[] }>(await w.call('signTransaction', { account: w.me, transactions: [w.transfer()] }));
    const signed = getTransactionDecoder().decode(bytes(transactions[0]));
    assert.ok(await verifySignature(w.pair.publicKey, signed.signatures[w.me]!, signed.messageBytes));
    const shown = w.approvals[0];
    assert.equal(shown.kind === 'transaction' && shown.signer, 'ready');
    assert.match(shown.kind === 'transaction' ? shown.guards.text : '', /guard/);
    assert.equal(w.box.state.sites[ORIGIN].signatures, 1);
    assert.equal(w.box.state.sites[ORIGIN].since, NOW / 1000); // the first transaction: known a day later
    assert.equal(w.sent.length, 0);
    // Its signature kept with the account: Activity tells it from those made elsewhere.
    assert.deepEqual(w.box.state.signedHere[w.me], [getBase58Decoder().decode(signed.signatures[w.me]!)]);
});

test('an approved transaction’s window hears how it goes: sent by Otus, or followed while the site sends it', async () => {
    const sends = await wallet();
    result(await sends.call('signAndSendTransaction', { account: sends.me, transactions: [sends.transfer()] }));
    assert.deepEqual(sends.outcomes.map((o) => o.phase), ['sending', 'landed']);
    assert.match((sends.outcomes[1] as { link: string }).link, /^https:\/\/solscan\.io\/tx\//);
    const signs = await wallet();
    result(await signs.call('signTransaction', { account: signs.me, transactions: [signs.transfer()] }));
    for (let i = 0; i < 20 && signs.outcomes.length < 2; i++) await new Promise((r) => setTimeout(r, 10));
    const link = (signs.outcomes[1] as { link: string }).link;
    assert.deepEqual(signs.outcomes, [{ phase: 'waiting', host: 'jup.ag', link }, { phase: 'landed', failed: false, link }]);
    // Another account pays, and has not signed yet: nothing to follow by.
    const other = await wallet();
    result(await other.call('signTransaction', { account: other.me, transactions: [other.transfer(other.me, key(7))] }));
    assert.deepEqual(other.outcomes, [{ phase: 'signed', host: 'jup.ag' }]);
    // Refused once approved: said in the window too.
    let checks = 0;
    const late = await wallet({ chain: { valid: async () => ++checks <= 1 } });
    await late.call('signTransaction', { account: late.me, transactions: [late.transfer()] });
    assert.deepEqual(late.outcomes, [{ phase: 'refused', error: 'It expired before you signed it, so nothing was sent' }]);
});

test('Otus’s pages hear when a transaction it signed goes out, sent by Otus or by the site; not when nothing did', async () => {
    const wait = async (done: () => boolean) => {
        for (let i = 0; i < 50 && !done(); i++) await new Promise((r) => setTimeout(r, 10));
    };
    const sends = await wallet();
    result(await sends.call('signAndSendTransaction', { account: sends.me, transactions: [sends.transfer()] }));
    assert.equal(sends.settled.count, 1);
    await own(bytes(sends.transfer()), sends.me, key(2), sends.shell);
    assert.equal(sends.settled.count, 2);
    // Failed onchain, it paid its fee; not seen yet, it may land in a moment: both are read again.
    const failed = await wallet({ chain: { status: async () => ({ error: { InstructionError: [0, 'InvalidArgument'] } as never, confirmed: true }) } });
    await failed.call('signAndSendTransaction', { account: failed.me, transactions: [failed.transfer()] });
    assert.equal(failed.settled.count, 1);
    const unseen = await wallet();
    unseen.shell.send = async () => ({ signature: key(10) as never, outcome: 'unknown', error: null });
    result(await unseen.call('signAndSendTransaction', { account: unseen.me, transactions: [unseen.transfer()] }));
    assert.equal(unseen.settled.count, 1);
    // The site sends it: once Otus sees it land; not when it expires unseen.
    const signs = await wallet();
    result(await signs.call('signTransaction', { account: signs.me, transactions: [signs.transfer()] }));
    await wait(() => signs.settled.count > 0);
    assert.equal(signs.settled.count, 1);
    let siteChecks = 0;
    const lost = await wallet({ chain: { status: async () => null, valid: async () => ++siteChecks <= 2 } });
    result(await lost.call('signTransaction', { account: lost.me, transactions: [lost.transfer()] }));
    await wait(() => lost.outcomes.length > 1);
    assert.deepEqual([lost.outcomes[1]?.phase, lost.settled.count], ['unseen', 0]);
    // Refused by the network, or expired once sent: nothing went out.
    const refused = await wallet({ chain: { send: async () => { throw blockhashNotFound(); } } });
    assert.deepEqual(await refused.call('signAndSendTransaction', { account: refused.me, transactions: [refused.transfer()] }), { ok: false, error: 'it expired before it was sent, so nothing was sent' });
    let checks = 0;
    const late = await wallet({ chain: { status: async () => null, valid: async () => ++checks <= 2 } });
    assert.deepEqual(await late.call('signAndSendTransaction', { account: late.me, transactions: [late.transfer()] }), { ok: false, error: 'it expired before it landed, so nothing was sent' });
    assert.ok(late.sent.length > 0); // it went to the network, and expired there
    assert.deepEqual([refused.settled.count, late.settled.count], [0, 0]);
    // Telling the pages never changes how it went.
    const loud = await wallet();
    loud.shell.settled = () => {
        throw new Error('no pages');
    };
    result(await loud.call('signAndSendTransaction', { account: loud.me, transactions: [loud.transfer()] }));
});

test('only what Otus builds to take access back is signed that way; a payer signature a site wrote is not followed', async () => {
    const w = await wallet();
    // A Compute Budget price first, where only a compute limit belongs: a fee slipped in.
    const priced = base64(new Uint8Array(getTransactionEncoder().encode(compileTransaction(pipe(
        createTransactionMessage({ version: 0 }),
        (m) => setTransactionMessageFeePayer(w.me, m),
        (m) => setTransactionMessageLifetimeUsingBlockhash({ blockhash: blockhash(key(9)), lastValidBlockHeight: 0n }, m),
        (m) => appendTransactionMessageInstruction(getSetComputeUnitPriceInstruction({ microLamports: 10_000_000_000n }), m),
        (m) => appendTransactionMessageInstruction(getRevokeInstruction({ source: key(30), owner: createNoopSigner(w.me) }), m),
    )))));
    assert.match(((await takeBack(bytes(priced), w.me, w.shell)) as { error: string }).error, /does more than take access back/);
    // The site pays, and wrote some bytes as its signature: Otus does not follow them.
    const site = await wallet();
    const tx = getTransactionDecoder().decode(bytes(site.transfer(site.me, key(7))));
    const written = base64(new Uint8Array(getTransactionEncoder().encode({ ...tx, signatures: { ...tx.signatures, [key(7)]: new Uint8Array(64).fill(1) as SignatureBytes } })));
    result(await site.call('signTransaction', { account: site.me, transactions: [written] }));
    assert.deepEqual(site.outcomes, [{ phase: 'signed', host: 'jup.ag' }]);
});

test('following a transaction says expired only when the network said so', async () => {
    const r = { message: { instructions: [], staticAccounts: [], lifetimeToken: key(9) } } as unknown as Review;
    const seen = (statuses: (Status | 'fails')[]) => {
        let i = 0;
        return { status: async () => { const s = statuses[Math.min(i++, statuses.length - 1)]; if (s === 'fails') throw new Error('no answer'); return s; }, valid: async () => false } as unknown as Chain;
    };
    assert.deepEqual(await followed(key(10) as never, r, seen([null, null])), { expired: true });
    assert.deepEqual(await followed(key(10) as never, r, seen([null, 'fails'])), { expired: false }); // its last read failed: nothing proven
    assert.deepEqual(await followed(key(10) as never, r, seen([{ error: null, confirmed: true }])), { failed: false });
});

test('a transfer made in the popup is not signed once its blockhash is too old, and says when it is signed', async () => {
    const old = await wallet({ validOn: [] });
    assert.deepEqual(await own(bytes(old.transfer()), old.me, key(2), old.shell), { ok: false, error: 'it expired before you signed it, so nothing was sent' });
    assert.equal(old.sent.length, 0);
    assert.equal(old.box.state.accounts[0].signatures ?? 0, 0);
    assert.deepEqual(old.box.state.sent, {});
    const w = await wallet();
    assert.deepEqual(await own(bytes(w.transfer()), w.me, 'not an address', w.shell), { ok: false, error: 'that is not a Solana address' });
    const told: string[] = [];
    const { signature } = result<{ signature: string }>(await own(bytes(w.transfer()), w.me, key(2), w.shell, async (s) => void told.push(s)));
    assert.deepEqual(told, [signature]); // before it was sent: a worker that stops can still tell
});

test('a transfer made in the popup is reviewed as Otus’s own, signed and sent, and counts for the wallet only', async () => {
    const w = await wallet();
    const reply = await own(bytes(w.transfer()), w.me, key(2), w.shell);
    const { signature, outcome } = result<{ signature: string; outcome: string }>(reply);
    assert.equal(outcome, 'confirmed');
    assert.equal(w.sent.length, 1);
    assert.deepEqual(new Uint8Array(getBase58Encoder().encode(signature)), new Uint8Array(getTransactionDecoder().decode(w.sent[0]).signatures[w.me]!));
    const shown = w.approvals[0];
    assert.ok(shown.kind === 'transaction');
    assert.deepEqual([shown.site.host, shown.site.note, shown.recipient], ['Otus', 'Your own transfer', key(2)]);
    assert.ok(shown.findings.some((f) => f.title === 'Made in Otus') && !shown.findings.some((f) => /site/.test(f.title)));
    assert.equal(w.box.state.accounts[0].signatures, 1);
    assert.equal(w.box.state.sites[ORIGIN].signatures, 0);
    assert.deepEqual(w.box.state.sent, { [key(2)]: 1 }); // landed there: the address is one you sent to
    assert.deepEqual(w.box.state.signedHere, { [w.me]: [signature] }); // kept, as every transaction Otus signs
    // Only for an account Otus holds a key for, and that alone signs it.
    assert.match((await own(bytes(w.transfer()), key(5), key(2), w.shell) as { error: string }).error, /no key/);
    // The address shown whole is one the transfer names.
    assert.match((await own(bytes(w.transfer()), w.me, key(3), w.shell) as { error: string }).error, /does not name the address you typed/);
    const rejected = await wallet({ answer: () => false });
    assert.deepEqual(await own(bytes(rejected.transfer()), rejected.me, key(2), rejected.shell), { ok: false, error: 'You rejected it', rejected: true });
    assert.deepEqual(rejected.box.state.sent, {});
    assert.equal(rejected.sent.length, 0);
});

test('what the popup makes to take access back is reviewed as Otus’s own, signed and sent; anything more is refused', async () => {
    const w = await wallet();
    const revoke = fix(w.me, { kind: 'revoke', account: key(30), program: TOKEN_PROGRAM_ADDRESS }, { blockhash: blockhash(key(9)), lastValidBlockHeight: 0n });
    const { outcome } = result<{ signature: string; outcome: string }>(await takeBack(revoke, w.me, w.shell));
    assert.equal(outcome, 'confirmed');
    assert.equal(w.sent.length, 1);
    const shown = w.approvals[0];
    assert.ok(shown.kind === 'transaction');
    assert.deepEqual([shown.site.host, shown.site.note], ['Otus', 'Taking access back']);
    const cancel = fix(w.me, { kind: 'cancel', nonce: key(32) }, { blockhash: blockhash(key(9)), lastValidBlockHeight: 0n });
    assert.equal(result<{ outcome: string }>(await takeBack(cancel, w.me, w.shell)).outcome, 'confirmed');
    // A transfer is no taking back, nor is a revoke another account signs.
    assert.match(((await takeBack(bytes(w.transfer()), w.me, w.shell)) as { error: string }).error, /does more than take access back/);
    const theirs = fix(key(5), { kind: 'revoke', account: key(30), program: TOKEN_PROGRAM_ADDRESS }, { blockhash: blockhash(key(9)), lastValidBlockHeight: 0n });
    assert.match(((await takeBack(theirs, w.me, w.shell)) as { error: string }).error, /does not sign this transaction/);
    assert.equal(w.sent.length, 2);
});

test('an endpoint of your own that says devnet, for a transaction mainnet knows, is not believed', async () => {
    const MINE = 'https://mine.example/';
    const lying = await wallet({ validOn: [OTUS_RPC, MINE] });
    lying.box.state = { ...lying.box.state, settings: { ...DEFAULT_SETTINGS, network: 'custom', rpc: MINE, custom: 'solana:devnet' } };
    assert.deepEqual(await own(bytes(lying.transfer()), lying.me, key(2), lying.shell), { ok: false, error: 'your RPC says it serves devnet, but this transaction is for mainnet' });
    assert.equal(lying.sent.length, 0);
    const honest = await wallet({ validOn: [MINE] });
    honest.box.state = { ...honest.box.state, settings: { ...DEFAULT_SETTINGS, network: 'custom', rpc: MINE, custom: 'solana:devnet' } };
    assert.equal(result<{ outcome: string }>(await own(bytes(honest.transfer()), honest.me, key(2), honest.shell)).outcome, 'confirmed');
    const shown = honest.approvals[0];
    assert.equal(shown.kind === 'transaction' && shown.network, 'devnet');
});

test('a transfer made in the popup never opens a token account for an address that is a token account itself', async () => {
    // key(2) holds tokens for key(6): an account opened for key(2) would be one no key can ever move.
    const held = account(key(2), TOKEN_PROGRAM_ADDRESS, 2_039_280n, tokenAccountData({ mint: key(31), owner: key(6), amount: 5n }));
    const w = await wallet({ chain: fakeChain([held], [held]) });
    const open = getCreateAssociatedTokenIdempotentInstruction({ payer: createNoopSigner(w.me), ata: key(30), owner: key(2), mint: key(31) });
    const tx = pipe(
        createTransactionMessage({ version: 0 }),
        (m) => setTransactionMessageFeePayer(w.me, m),
        (m) => setTransactionMessageLifetimeUsingBlockhash({ blockhash: blockhash(key(9)), lastValidBlockHeight: 0n }, m),
        (m) => appendTransactionMessageInstruction(open, m),
    );
    const reply = (await own(new Uint8Array(getTransactionEncoder().encode(compileTransaction(tx))), w.me, key(2), w.shell)) as { error: string };
    assert.match(reply.error, /token account or a mint, not a wallet/);
    assert.equal(w.sent.length, 0);
});

test('a site gets one review at a time, and what its bytes alone refuse costs no RPC', async () => {
    let asked = 0; // network checks: each review starts with one
    const w = await wallet({ chain: { valid: async () => (asked++, true) } });
    const [one, two] = await Promise.all([w.call('signTransaction', { account: w.me, transactions: [w.transfer()] }), w.call('signTransaction', { account: w.me, transactions: [w.transfer()] })]);
    assert.equal([one, two].filter((r) => r.ok).length, 1);
    assert.match(([one, two].find((r) => !r.ok) as { error: string }).error, /already asking you/);
    // Paid by another account whose signature is missing, it cannot be sent: refused before any review.
    asked = 0;
    const cosigned = await w.call('signAndSendTransaction', { account: w.me, transactions: [w.transfer(w.me, key(5))] });
    assert.match((cosigned as { error: string }).error, /another signature is missing/);
    assert.equal(asked, 0);
});

test('signs and sends, and answers with the signature once it lands', async () => {
    const w = await wallet();
    const { signatures } = result<{ signatures: string[] }>(await w.call('signAndSendTransaction', { account: w.me, transactions: [w.transfer()] }));
    assert.equal(w.sent.length, 1);
    const landed = getTransactionDecoder().decode(w.sent[0]);
    assert.deepEqual(new Uint8Array(getBase58Encoder().encode(signatures[0])), new Uint8Array(landed.signatures[w.me]!));
});

test('the latest 200 signatures are kept an account, and only for an account still in Otus', async () => {
    const w = await wallet();
    const others = { [key(7)]: ['theirs'] };
    w.box.state = { ...w.box.state, signedHere: { [w.me]: Array.from({ length: 200 }, (_, i) => `old${i}`), ...others } };
    const { transactions } = result<{ transactions: string[] }>(await w.call('signTransaction', { account: w.me, transactions: [w.transfer()] }));
    const kept = w.box.state.signedHere[w.me];
    assert.deepEqual([kept.length, kept[0], kept.at(-1)], [200, 'old1', getBase58Decoder().decode(getTransactionDecoder().decode(bytes(transactions[0])).signatures[w.me]!)]);
    assert.deepEqual(w.box.state.signedHere[key(7)], ['theirs']); // another account's untouched
    // Removed while its key signed: no entry comes back for it.
    const gone = await wallet();
    const sign = gone.shell.sign;
    gone.shell.sign = async (a, data) => ((gone.box.state = { ...gone.box.state, accounts: [], signedHere: {} }), sign(a, data));
    await gone.call('signTransaction', { account: gone.me, transactions: [gone.transfer()] });
    assert.equal(gone.box.state.accounts.length, 0);
    assert.deepEqual(gone.box.state.signedHere, {});
});

test('signs a message, and a sign-in that the site can check', async () => {
    const w = await wallet();
    const text = new TextEncoder().encode('Hello from jup.ag');
    const m = result<{ signedMessage: string; signature: string }>(await w.call('signMessage', { account: w.me, message: base64(text) }));
    assert.deepEqual(bytes(m.signedMessage), text);
    assert.ok(await verifySignature(w.pair.publicKey, bytes(m.signature) as SignatureBytes, text));

    w.box.state = { ...w.box.state, sites: {} };
    const input = { statement: 'Sign in to Jupiter', uri: ORIGIN, version: '1', nonce: 'abc12345', issuedAt: '2026-10-03T12:00:00Z', resources: ['https://jup.ag/terms'] };
    const s = result<{ account: string; signedMessage: string; signature: string }>(await w.call('signIn', input));
    const expected = `jup.ag wants you to sign in with your Solana account:\n${w.me}\n\nSign in to Jupiter\n\nURI: https://jup.ag\nVersion: 1\nNonce: abc12345\nIssued At: 2026-10-03T12:00:00Z\nResources:\n- https://jup.ag/terms`;
    assert.equal(new TextDecoder().decode(bytes(s.signedMessage)), expected);
    assert.ok(await verifySignature(w.pair.publicKey, bytes(s.signature) as SignatureBytes, bytes(s.signedMessage)));
    assert.equal(w.box.state.sites[ORIGIN]?.account, w.me); // signing in connects the site
    assert.equal(w.box.state.signedHere[w.me], undefined); // a message never lands: none kept
});

test('an address you only watch is reviewed but never signed for', async () => {
    const w = await wallet({ key: false });
    const reply = await w.call('signTransaction', { account: w.me, transactions: [w.transfer()] });
    assert.equal(w.approvals[0].kind === 'transaction' && w.approvals[0].signer, 'none');
    assert.deepEqual(reply, { ok: false, error: 'Otus holds no key for this account' });
});

test('the review is shown behind the lock, which the window keeps; signing still needs the keystore unlocked', async () => {
    const w = await wallet({ locked: true });
    const reply = await w.call('signMessage', { account: w.me, message: base64(new TextEncoder().encode('hi')) });
    assert.equal(w.approvals[0].kind === 'message' && w.approvals[0].signer, 'ready');
    assert.deepEqual(reply, { ok: false, error: 'Otus is locked' });
});

test('signs nothing for a site disconnected while the user was deciding', async () => {
    const w = await wallet({ answer: (_a, box) => ((box.state = { ...box.state, sites: {} }), true) });
    const reply = await w.call('signTransaction', { account: w.me, transactions: [w.transfer()] });
    assert.deepEqual(reply, { ok: false, error: 'this site is not connected to that account' });
});

test('a rejection, or a transaction that does not need you, signs nothing', async () => {
    const w = await wallet({ answer: () => false });
    assert.deepEqual(await w.call('signMessage', { account: w.me, message: base64(new Uint8Array([1, 2, 3])) }), { ok: false, error: 'The user rejected the request', rejected: true });
    const other = await wallet();
    const reply = await other.call('signTransaction', { account: other.me, transactions: [other.transfer(key(3))] });
    assert.equal(reply.ok, false);
    assert.equal(other.approvals.length, 0);
});

test('connecting with another of your accounts, chosen in the window: it connects, and is the one in use', async () => {
    const other = key(5);
    const withTwo = (box: { state: State }) => (box.state = { ...box.state, accounts: [...box.state.accounts, { address: other, label: 'Other', key: { secret: 's', index: 1 } }] });
    const w = await wallet({ answer: (a, box) => (a.kind === 'connect' ? { account: other } : true) });
    withTwo(w.box);
    assert.deepEqual(result(await w.call('connect', {}, 'https://new.app')), { accounts: [other], v1: true });
    assert.deepEqual([w.box.state.sites['https://new.app']?.account, w.box.state.active], [other, other]);
    const shown = w.approvals[0];
    assert.deepEqual(shown.kind === 'connect' && shown.choices.map((c) => c.address), [w.me, other]); // the window offers your accounts

    // An address that is not one of yours connects nothing.
    const stranger = await wallet({ answer: () => ({ account: key(6) }) });
    assert.equal((await stranger.call('connect', {}, 'https://new.app')).ok, false);
    assert.equal(stranger.box.state.sites['https://new.app'], undefined);
    // To sign, an account chosen is a no.
    const signing = await wallet({ answer: () => ({ account: key(6) }) });
    assert.equal((await signing.call('signMessage', { account: signing.me, message: base64(new TextEncoder().encode('hi')) })).ok, false);
    assert.equal((await signing.call('signTransaction', { account: signing.me, transactions: [signing.transfer()] })).ok, false);
});

test('a watched account never connects: the window offers those that sign, and only they connect', async () => {
    const signer = key(5);
    const withSigner = (box: { state: State }) => (box.state = { ...box.state, accounts: [...box.state.accounts, { address: signer, label: 'Signs', key: { secret: 's', index: 1 } }] });
    // The one in use only watches: a plain yes connects nothing; choosing one that signs does.
    const yes = await wallet({ key: false });
    withSigner(yes.box);
    assert.equal((await yes.call('connect', {}, 'https://new.app')).ok, false);
    assert.equal(yes.box.state.sites['https://new.app'], undefined);
    const shown = yes.approvals[0];
    assert.deepEqual(shown.kind === 'connect' && shown.choices.map((c) => c.address), [signer]); // the watched one is not offered
    const chose = await wallet({ key: false, answer: () => ({ account: signer }) });
    withSigner(chose.box);
    assert.deepEqual(result(await chose.call('connect', {}, 'https://new.app')), { accounts: [signer], v1: true });
    // Naming the watched one is a no; with no account that signs, no window opens.
    const named = await wallet({ key: false, answer: (_a, box) => ({ account: box.state.accounts[0].address }) });
    withSigner(named.box);
    assert.equal((await named.call('connect', {}, 'https://new.app')).ok, false);
    const none = await wallet({ key: false });
    assert.deepEqual(await none.call('connect', {}, 'https://new.app'), { ok: false, error: 'no account in Otus can sign: a watched one cannot connect' });
    assert.equal(none.approvals.length, 0);
});

test('connecting keeps what changed while the user was deciding', async () => {
    const w = await wallet({ answer: (_a, box) => ((box.state = { ...box.state, sites: {} }), true) }); // jup.ag disconnected meanwhile
    result(await w.call('connect', {}, 'https://new.app'));
    assert.deepEqual(Object.keys(w.box.state.sites), ['https://new.app']);
});

test('reviews a transaction on the network that knows its blockhash, and refuses one named for another', async () => {
    const devnet = 'https://api.devnet.solana.com';
    const named = await wallet({ validOn: [devnet] });
    const reply = await named.call('signTransaction', { account: named.me, chain: 'solana:mainnet', transactions: [named.transfer()] });
    assert.deepEqual(reply, { ok: false, error: 'this transaction is not for mainnet' });
    assert.equal(named.approvals.length, 0);

    const guessed = await wallet({ validOn: [devnet] });
    result(await guessed.call('signTransaction', { account: guessed.me, transactions: [guessed.transfer()] }));
    const shown = guessed.approvals[0];
    assert.equal(shown.kind === 'transaction' && shown.network, 'devnet');
    assert.equal(guessed.firsts.length, 1); // reviewed on mainnet first, as the wallet shows: that review is never shown
    assert.equal((await wallet({ validOn: [] })).approvals.length, 0);
});

test('a site’s transaction is reviewed while its network is checked, and shown only once the check says so', async () => {
    const CHECK = 150; // ms the network takes to say the blockhash is its own
    const w = await wallet({ slow: 40, chain: { valid: () => new Promise((r) => setTimeout(() => r(true), CHECK)) } });
    const asked = performance.now();
    result(await w.call('signTransaction', { account: w.me, chain: 'solana:mainnet', transactions: [w.transfer()] }));
    const shown = w.shownAt.first[0] - asked;
    assert.ok(shown >= CHECK, `shown after ${shown} ms, before the check`);
    assert.ok(shown < CHECK + 2 * 40, `shown after ${shown} ms: the review waited for the check`); // it takes two round trips or more
});

test('a site’s transaction is reviewed with what the request read, not reading storage again while its window opens', async () => {
    const w = await wallet({ early: true });
    const reads: number[] = [];
    const load = w.shell.load;
    w.shell.load = () => (reads.push(performance.now()), load());
    result(await w.call('signTransaction', { account: w.me, transactions: [w.transfer()] }));
    assert.equal(reads.filter((at) => at < w.shownAt.first[0]).length, 1); // the request's own, before the window
});

test('a review on the network guessed that fails does not refuse a transaction for another', async () => {
    const devnet = 'https://api.devnet.solana.com';
    const w = await wallet({ validOn: [devnet] });
    const chain = w.shell.chain;
    // Mainnet, where it is reviewed first, does not answer for its accounts.
    w.shell.chain = (rpc) => (rpc === devnet ? chain(rpc) : { ...chain(rpc), accounts: () => Promise.reject(new Error('mainnet did not answer')) });
    result(await w.call('signTransaction', { account: w.me, transactions: [w.transfer()] }));
    const shown = w.approvals[0];
    assert.equal(shown.kind === 'transaction' && shown.network, 'devnet');
});

test('mainnet’s lookup tables are kept: read once, then only past what they held; another network’s are not', async () => {
    const TABLE = key(60);
    const data = new Uint8Array(56 + 32);
    data.set([1, 0, 0, 0]); // a lookup table, never deactivated, holding key(2)
    data.fill(0xff, 4, 12);
    data.set(getAddressEncoder().encode(key(2)), 56);
    const signed = async (network: 'solana:mainnet' | 'solana:devnet') => {
        const w = await wallet({ validOn: [network === 'solana:mainnet' ? OTUS_RPC : 'https://api.devnet.solana.com'] });
        const kept = new Map<Address, readonly Address[]>();
        const read: Address[][] = [];
        w.shell.tables = { get: async (t) => kept.get(t), set: (t, e) => void kept.set(t, e) };
        const chain = w.shell.chain;
        w.shell.chain = (rpc) => {
            const c = chain(rpc);
            return { ...c, accounts: async (a) => (read.push([...a]), a.includes(TABLE) ? { slot: 1n, accounts: [account(TABLE, LOOKUP_TABLE_PROGRAM, 1n, data)] } : c.accounts(a)) };
        };
        // The transfer, its recipient from the table.
        const message = pipe(
            createTransactionMessage({ version: 0 }),
            (m) => setTransactionMessageFeePayer(w.me, m),
            (m) => setTransactionMessageLifetimeUsingBlockhash({ blockhash: blockhash(key(9)), lastValidBlockHeight: 0n }, m),
            (m) => appendTransactionMessageInstruction(getTransferSolInstruction({ source: createNoopSigner(w.me), destination: key(2), amount: lamports(1_000_000n) }), m),
            (m) => compressTransactionMessageUsingAddressLookupTables(m, { [TABLE]: [key(2)] }),
        );
        const tx = base64(new Uint8Array(getTransactionEncoder().encode(compileTransaction(message))));
        for (let i = 0; i < 2; i++) result(await w.call('signTransaction', { account: w.me, chain: network, transactions: [tx] }));
        return { kept, tables: read.filter((r) => r.includes(TABLE)).length };
    };
    assert.deepEqual(await signed('solana:mainnet'), { kept: new Map([[TABLE, [key(2)]]]), tables: 1 });
    assert.deepEqual(await signed('solana:devnet'), { kept: new Map(), tables: 2 });
});

test('an RPC that cannot answer just now, or cannot be reached, is said so, not as a failure of Otus', async () => {
    const behind = await wallet({ chain: { accounts: () => Promise.reject(getSolanaErrorFromJsonRpcError({ code: -32016, message: 'Minimum context slot has not been reached' })) } });
    assert.deepEqual(await behind.call('signTransaction', { account: behind.me, transactions: [behind.transfer()] }), { ok: false, error: 'the RPC could not answer just now: try again' });
    const offline = await wallet({ chain: { accounts: () => Promise.reject(new TypeError('Failed to fetch')) } });
    assert.deepEqual(await offline.call('signTransaction', { account: offline.me, transactions: [offline.transfer()] }), { ok: false, error: "Otus couldn't reach the RPC" });
    const broken = await wallet({ chain: { accounts: () => Promise.reject(new TypeError("Cannot read properties of undefined (reading 'x')")) } });
    assert.deepEqual(await broken.call('signTransaction', { account: broken.me, transactions: [broken.transfer()] }), { ok: false, error: 'Otus could not handle this request' }); // a fault of Otus's own stays one
});

test('kept lookup tables serve only mainnet as Otus’s server reads it; a public endpoint is never reviewed on ahead', async () => {
    // Mainnet through an endpoint of your own: its tables are not taken from what Otus's server gave.
    const MINE = 'https://mine.example/';
    const own = await wallet({ validOn: [MINE] });
    own.box.state = { ...own.box.state, settings: { ...DEFAULT_SETTINGS, network: 'custom', rpc: MINE, custom: 'solana:mainnet' } };
    let used = 0;
    own.shell.tables = { get: async () => (used++, undefined), set: () => void used++ };
    result(await own.call('signTransaction', { account: own.me, transactions: [own.transfer()] }));
    assert.equal(used, 0);
    // The wallet on devnet's public endpoint, a transaction for mainnet that names no network: devnet is asked only
    // whether its blockhash is its own, never to read or simulate it.
    const devnet = await wallet({ validOn: [OTUS_RPC] });
    devnet.box.state = { ...devnet.box.state, settings: { ...DEFAULT_SETTINGS, network: 'devnet' } };
    const reads: string[] = [];
    const chain = devnet.shell.chain;
    devnet.shell.chain = (rpc) => {
        const c = chain(rpc);
        return { ...c, accounts: (a) => (reads.push(rpc), c.accounts(a)), simulate: (...args) => (reads.push(rpc), c.simulate(...args)) };
    };
    result(await devnet.call('signTransaction', { account: devnet.me, transactions: [devnet.transfer()] }));
    assert.ok(reads.length > 0 && reads.every((rpc) => rpc === OTUS_RPC), reads.join());
});

test('a refusal of the review on the network guessed reaches the site once it is confirmed; a no then signs nothing', async () => {
    const refused = await wallet({ chain: { accounts: () => Promise.reject(new Refused('an account appears twice')) } });
    assert.deepEqual(await refused.call('signTransaction', { account: refused.me, chain: 'solana:mainnet', transactions: [refused.transfer()] }), { ok: false, error: 'an account appears twice' });
    // Said no while it is reviewed on mainnet, for a transaction that is devnet's: nothing asked, nothing signed.
    const no = await wallet({ early: 'no', validOn: ['https://api.devnet.solana.com'] });
    assert.equal((await no.call('signTransaction', { account: no.me, transactions: [no.transfer()] })).ok, false);
    await new Promise((done) => setTimeout(done, 50)); // the review left to end on its own
    assert.deepEqual([no.approvals.length, no.box.state.sites[ORIGIN].signatures, no.box.state.signedHere[no.me]], [0, 0, undefined]);
});

test('a connected site signs in with its account only; another site cannot learn which accounts Otus holds', async () => {
    const w = await wallet();
    assert.deepEqual(await w.call('signIn', { address: key(5) }), { ok: false, error: 'that account is not connected to this site' });
    const elsewhere = result<{ account: string }>(await w.call('signIn', { address: key(5) }, 'https://other.app'));
    assert.equal(elsewhere.account, w.me); // the account in use, whatever address the site named
});

// What the RPC answers a send whose blockhash it does not know, as kit reads it.
const blockhashNotFound = () => getSolanaErrorFromJsonRpcError({ code: -32002, message: 'Transaction simulation failed: Blockhash not found', data: { err: 'BlockhashNotFound', logs: [], accounts: null, unitsConsumed: 0 } });
const http = (statusCode: number) => new SolanaError(SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR, { headers: new Headers(), message: '', statusCode });

test('your own transfer is yours alone to sign, and signed only while the account is still in Otus', async () => {
    const w = await wallet();
    assert.deepEqual(await own(bytes(w.transfer(w.me, key(3))), w.me, key(2), w.shell), { ok: false, error: 'another account would have to sign it' });
    assert.equal(w.approvals.length, 0);
    const removed = await wallet({ answer: (_a, box) => ((box.state = { ...box.state, accounts: [] }), true) });
    assert.deepEqual(await own(bytes(removed.transfer()), removed.me, key(2), removed.shell), { ok: false, error: 'Otus holds no key for this account' });
    assert.equal(removed.sent.length, 0);
});

test('a site gets nothing signed for an account removed while the user was deciding', async () => {
    const w = await wallet({ answer: (_a, box) => ((box.state = { ...box.state, accounts: [] }), true) });
    assert.deepEqual(await w.call('signTransaction', { account: w.me, transactions: [w.transfer()] }), { ok: false, error: 'this site is not connected to that account' });
});

test('a transaction another account must sign too is signed, but not sent while its signature is missing', async () => {
    const w = await wallet();
    const tx = w.transfer(w.me, key(3));
    assert.deepEqual(await w.call('signAndSendTransaction', { account: w.me, transactions: [tx] }), { ok: false, error: 'another signature is missing, so it cannot be sent' });
    const { transactions } = result<{ transactions: string[] }>(await w.call('signTransaction', { account: w.me, transactions: [tx] }));
    const signed = getTransactionDecoder().decode(bytes(transactions[0]));
    assert.ok(signed.signatures[w.me] && !signed.signatures[key(3)]);
    const shown = w.approvals[0];
    const why = "Otus can't add guards because another account must sign the transaction too";
    assert.deepEqual(shown.kind === 'transaction' && [shown.guards, shown.added], [{ held: false, text: `None: ${why}`, why }, []]); // left as it came, and why
});

test('a send the network refuses, or one that expires before it lands, is said in words on both ways in', async () => {
    const refused = await wallet({ chain: { send: async () => { throw blockhashNotFound(); } } });
    const expected = { ok: false, error: 'it expired before it was sent, so nothing was sent' };
    assert.deepEqual(await refused.call('signAndSendTransaction', { account: refused.me, transactions: [refused.transfer()] }), expected);
    assert.deepEqual(await own(bytes(refused.transfer()), refused.me, key(2), refused.shell), expected);
    // The blockhash is known while reviewing and signing, then no longer: unseen, the transfer expires. A site's goes by
    // two checks before signing (its network, then its blockhash once approved); your own, by the second only.
    let checks = 0;
    let known = 2;
    const late = await wallet({ chain: { status: async () => null, valid: async () => ++checks <= known } });
    assert.deepEqual(await late.call('signAndSendTransaction', { account: late.me, transactions: [late.transfer()] }), { ok: false, error: 'it expired before it landed, so nothing was sent' });
    [checks, known] = [0, 1];
    assert.deepEqual(await own(bytes(late.transfer()), late.me, key(2), late.shell), { ok: false, error: 'it expired before it landed, so nothing was sent' });
});

test('an RPC that turns Otus away, or does not answer, is said so on both ways in', async () => {
    const busy = await wallet({ chain: { accounts: async () => { throw http(429); } } });
    const turnedAway = { ok: false, error: "the RPC refused Otus's request (HTTP 429)" };
    assert.deepEqual(await busy.call('signTransaction', { account: busy.me, transactions: [busy.transfer()] }), turnedAway);
    assert.deepEqual(await own(bytes(busy.transfer()), busy.me, key(2), busy.shell), turnedAway);
    const silent = await wallet({ chain: { accounts: async () => { throw new DOMException('signal timed out', 'TimeoutError'); } } });
    const noAnswer = { ok: false, error: 'the RPC did not answer in time' };
    assert.deepEqual(await silent.call('signTransaction', { account: silent.me, transactions: [silent.transfer()] }), noAnswer);
    assert.deepEqual(await own(bytes(silent.transfer()), silent.me, key(2), silent.shell), noAnswer);
});

test('several transactions in one call: one window for all, each reviewed alone, all signed in their order', async () => {
    const w = await wallet();
    const asked = [w.transfer(), w.transfer(w.me, w.me, 1), w.transfer()];
    const { transactions } = result<{ transactions: string[] }>(await w.call('signTransaction', { account: w.me, transactions: asked }));
    assert.equal(w.approvals.length, 1);
    const shown = w.approvals[0];
    assert.equal(shown.kind, 'batch');
    assert.equal(shown.kind === 'batch' && shown.items.length, 3);
    assert.equal(w.firsts[0].kind === 'batch' && w.firsts[0].preparing, true); // shown as reviewed first, then prepared
    assert.equal(transactions.length, 3);
    for (const t of transactions) {
        const signed = getTransactionDecoder().decode(bytes(t));
        assert.ok(await verifySignature(w.pair.publicKey, signed.signatures[w.me]!, signed.messageBytes));
    }
    // Each in the order asked: the second is the version 1 one.
    assert.deepEqual(await Promise.all(transactions.map(async (t) => (await decode(bytes(t))).message.version)), [0, 1, 0]);
    assert.equal(w.box.state.sites[ORIGIN].signatures, 3);
    assert.equal(w.box.state.signedHere[w.me].length, 3);
});

test('more than ten in one call, or one this wallet does not sign among them, is refused before any review', async () => {
    const w = await wallet();
    const eleven = await w.call('signTransaction', { account: w.me, transactions: Array.from({ length: 11 }, () => w.transfer()) });
    assert.deepEqual(eleven, { ok: false, error: 'Otus signs at most 10 transactions in one request' });
    const ten = await w.call('signTransaction', { account: w.me, transactions: Array.from({ length: 10 }, () => w.transfer()) });
    assert.equal(result<{ transactions: string[] }>(ten).transactions.length, 10);
    const stranger = await w.call('signTransaction', { account: w.me, transactions: [w.transfer(), w.transfer(key(5))] });
    assert.deepEqual(stranger, { ok: false, error: 'transaction 2 of 2: this wallet does not sign this transaction' });
    assert.equal(w.approvals.length, 1); // only the ten
});

test('several sent: in order, each once the one before landed; one that fails onchain stops the rest', async () => {
    let looked = 0;
    const w = await wallet({ chain: { status: async () => (looked++ === 1 ? { error: { InstructionError: [0, { Custom: 1 }] }, confirmed: true } : { error: null, confirmed: true }) } });
    const reply = await w.call('signAndSendTransaction', { account: w.me, transactions: [w.transfer(), w.transfer(), w.transfer()] });
    assert.equal(w.sent.length, 2);
    const first = getBase58Decoder().decode(getTransactionDecoder().decode(w.sent[0]).signatures[w.me]!);
    assert.deepEqual(reply, { ok: false, error: `transaction 2 of 3 failed onchain, so Otus sent none after it (landed: ${first})` });
    // The first failing: nothing landed before it, and the site is told no signature as landed.
    let seen = 0;
    const firstFails = await wallet({ chain: { status: async () => (seen++ === 0 ? { error: { InstructionError: [0, { Custom: 1 }] }, confirmed: true } : { error: null, confirmed: true }) } });
    assert.deepEqual(await firstFails.call('signAndSendTransaction', { account: firstFails.me, transactions: [firstFails.transfer(), firstFails.transfer()] }), { ok: false, error: 'transaction 1 of 2 failed onchain, so Otus sent none after it' });
    // The window says it landed and failed, and what came before: not "Not sent".
    assert.deepEqual(w.outcomes.at(-1), { phase: 'landed', failed: true, link: w.outcomes.at(-1)!.phase === 'landed' ? (w.outcomes.at(-1) as { link: string }).link : '', words: 'Transaction 2 of 3 landed and failed: 1 confirmed before it; none after it was sent.' });
    const all = await wallet();
    const { signatures } = result<{ signatures: string[] }>(await all.call('signAndSendTransaction', { account: all.me, transactions: [all.transfer(), all.transfer(all.me, all.me, 1)] }));
    assert.equal(all.sent.length, 2);
    assert.deepEqual(signatures, all.sent.map((t) => getBase58Decoder().decode(getTransactionDecoder().decode(t).signatures[all.me]!)));
});

test('a Ledger signs each of several on its device, in order; anything but a signature for each signs nothing', async () => {
    const answers: ((a: Approval, key: CryptoKey) => Promise<Answer>)[] = [
        async (a, k) => (a.kind === 'batch' && a.ledger ? Promise.all(a.ledger.messages.map((m) => signBytes(k, bytes(m)))) : false),
        async (a, k) => (a.kind === 'batch' && a.ledger ? signBytes(k, bytes(a.ledger.messages[0])) : false), // one signature for all
        async (a, k) => (a.kind === 'batch' && a.ledger ? (await Promise.all(a.ledger.messages.map((m) => signBytes(k, bytes(m))))).reverse() : false), // out of order
    ];
    const replies = [];
    for (const answer of answers) {
        let pair: CryptoKeyPair | null = null;
        const w = await wallet({ ledger: true, answer: (a) => answer(a, pair!.privateKey) });
        pair = w.pair;
        // Two that differ: 0.002 SOL to key(3) beside the usual transfer.
        const other = base64(
            new Uint8Array(
                getTransactionEncoder().encode(
                    compileTransaction(
                        pipe(
                            createTransactionMessage({ version: 0 }),
                            (m) => setTransactionMessageFeePayer(w.me, m),
                            (m) => setTransactionMessageLifetimeUsingBlockhash({ blockhash: blockhash(key(9)), lastValidBlockHeight: 0n }, m),
                            (m) => appendTransactionMessageInstruction(getTransferSolInstruction({ source: createNoopSigner(w.me), destination: key(3), amount: lamports(2_000_000n) }), m),
                        ),
                    ),
                ),
            ),
        );
        replies.push(await w.call('signTransaction', { account: w.me, transactions: [w.transfer(), other] }));
    }
    assert.equal(replies[0].ok && (replies[0].result as { transactions: string[] }).transactions.length, 2);
    assert.equal(replies[1].ok, false);
    assert.equal(replies[2].ok, false);
});

test('token names and prices are asked of Jupiter for mainnet only', async () => {
    const mainnet = await wallet();
    result(await mainnet.call('signTransaction', { account: mainnet.me, transactions: [mainnet.transfer()] }));
    assert.equal(mainnet.looked.length, 1);
    const devnet = await wallet({ validOn: ['https://api.devnet.solana.com'] });
    result(await devnet.call('signTransaction', { account: devnet.me, transactions: [devnet.transfer()] }));
    assert.equal(devnet.looked.length, 0);
});

test('connecting silently answers only a site connected already; disconnecting forgets the site', async () => {
    const w = await wallet();
    assert.deepEqual(result(await w.call('connect', { silent: true })), { accounts: [w.me], v1: true });
    assert.deepEqual(await w.call('connect', { silent: true }, 'https://new.app'), { ok: false, error: 'not connected' });
    assert.equal(w.approvals.length, 0);
    assert.equal(w.warmed.count, 1); // the connected site's page opened: its network reached ahead; not for another
    assert.equal(result(await w.call('disconnect', {})), null);
    assert.deepEqual(w.box.state.sites, {});
});

test('connecting, a site is told by its host from the first visit, and known again once it was disconnected', async () => {
    const w = await wallet();
    const lines = (a: Approval | undefined) => (a?.kind === 'connect' || a?.kind === 'signIn' ? a.findings.map((f) => `${f.tone}:${f.title}`) : null);
    result(await w.call('connect', {}, 'https://claim.vercel.app'));
    assert.deepEqual(lines(w.approvals.at(-1)), ['warn:Hosted on vercel.app', 'warn:New site']);
    result(await w.call('connect', {}, 'https://jup-claim.app'));
    assert.deepEqual(lines(w.approvals.at(-1)), ['warn:This site looks like jup.ag', 'warn:New site']);
    // jup.ag, first signed for two days ago: disconnected, its past is kept, and it connects again as known, with it.
    const past = { since: NOW / 1000 - 2 * 86_400, programs: [key(50)] };
    w.box.state = { ...w.box.state, sites: { [ORIGIN]: { account: w.me, signatures: 7, ...past } } };
    assert.equal(result(await w.call('disconnect', {})), null);
    assert.deepEqual([w.box.state.sites[ORIGIN], w.box.state.disconnected], [undefined, [{ origin: ORIGIN, ...past }]]);
    result(await w.call('connect', {}));
    assert.deepEqual(lines(w.approvals.at(-1)), ['ok:Known site']);
    assert.deepEqual([w.box.state.sites[ORIGIN], w.box.state.disconnected], [{ account: w.me, signatures: 0, ...past }, []]);
    // Its first transaction since is not a first one.
    result(await w.call('signTransaction', { account: w.me, transactions: [w.transfer()] }));
    const shown = w.approvals.at(-1);
    assert.ok(shown?.kind === 'transaction' && shown.findings.some((f) => f.title === 'Known site') && !shown.findings.some((f) => f.title === 'First transaction for this site'));
    // Signed for a few hours ago, and disconnected: new still, since then, connecting and signing.
    w.box.state = { ...w.box.state, sites: {}, disconnected: [{ origin: ORIGIN, since: NOW / 1000 - 3 * 3_600 }] };
    result(await w.call('connect', {}));
    const connecting = w.approvals.at(-1);
    assert.deepEqual(connecting?.kind === 'connect' && connecting.findings, [{ tone: 'notice', title: 'New site', note: 'You first signed a transaction for it 3 hours ago' }]);
    // Its transaction too (the review tells the age by the clock, not the fake extension's).
    w.box.state = { ...w.box.state, sites: { [ORIGIN]: { ...w.box.state.sites[ORIGIN], since: Math.floor(Date.now() / 1000) - 3 * 3_600 } } };
    result(await w.call('signTransaction', { account: w.me, transactions: [w.transfer()] }));
    const again = w.approvals.at(-1);
    assert.ok(again?.kind === 'transaction' && again.findings.some((f) => f.title === 'New site' && f.tone === 'notice'));
});

test('signing in connects a site with what was kept of it, told as connecting is; a connected one, as before', async () => {
    const w = await wallet();
    const input = { statement: 'Sign in', uri: ORIGIN, version: '1', nonce: 'abc12345', issuedAt: '2026-10-03T12:00:00Z' };
    result(await w.call('signIn', input));
    const first = w.approvals.at(-1);
    assert.deepEqual(first?.kind === 'signIn' && first.findings, []); // connected already
    const since = NOW / 1000 - 2 * 86_400;
    w.box.state = { ...w.box.state, sites: {}, disconnected: [{ origin: ORIGIN, since }] };
    result(await w.call('signIn', input));
    const shown = w.approvals.at(-1);
    assert.deepEqual(shown?.kind === 'signIn' && shown.findings.map((f) => f.title), ['Known site']);
    assert.deepEqual([w.box.state.sites[ORIGIN], w.box.state.disconnected], [{ account: w.me, signatures: 1, since }, []]);
});

test('a connect answered after a sign-in connected the site keeps what the sign-in brought back', async () => {
    const since = NOW / 1000 - 2 * 86_400;
    // While the connect window waits, the site signs in, which connects it with its past.
    const w = await wallet({ answer: (a, box) => (a.kind === 'connect' && (box.state = { ...box.state, sites: { [ORIGIN]: { account: box.state.active!, signatures: 1, since } }, disconnected: [] }), true) });
    w.box.state = { ...w.box.state, sites: {}, disconnected: [{ origin: ORIGIN, since }] };
    result(await w.call('connect', {}));
    assert.deepEqual(w.box.state.sites[ORIGIN], { account: w.me, signatures: 1, since });
});

test('an account removed while the connect window waits connects nothing', async () => {
    const w = await wallet({ answer: (a, box) => (a.kind === 'connect' && (box.state = { ...box.state, accounts: [] }), true) });
    w.box.state = { ...w.box.state, sites: {}, disconnected: [{ origin: ORIGIN, since: 5 }] };
    assert.deepEqual(await w.call('connect', {}), { ok: false, error: 'no account in Otus can sign: a watched one cannot connect' });
    assert.deepEqual([w.box.state.sites, w.box.state.disconnected], [{}, [{ origin: ORIGIN, since: 5 }]]);
});

test('a site disconnected while its transaction waits is not signed for, nor connected again', async () => {
    const w = await wallet({ answer: (a, box) => (a.kind === 'transaction' && (box.state = { ...box.state, sites: {}, disconnected: [{ origin: ORIGIN, since: 5 }] }), true) });
    w.box.state = { ...w.box.state, sites: { [ORIGIN]: { account: w.me, signatures: 1, since: 5 } } };
    assert.deepEqual(await w.call('signTransaction', { account: w.me, transactions: [w.transfer()] }), { ok: false, error: 'this site is not connected to that account' });
    assert.deepEqual([w.box.state.sites, w.box.state.disconnected], [{}, [{ origin: ORIGIN, since: 5 }]]);
});

test('a site disconnected with nothing to keep keeps nothing; at most 200 are kept, the latest', async () => {
    const w = await wallet();
    assert.equal(result(await w.call('disconnect', {})), null); // connected, never signed for
    assert.deepEqual(w.box.state.disconnected, []);
    // Kept in the order they went, whatever their names: the first gone is the first dropped.
    const many = Array.from({ length: 200 }, (_, i) => ({ origin: `https://${String.fromCharCode(122 - (i % 26))}${i}.app`, since: i }));
    w.box.state = { ...w.box.state, sites: { [ORIGIN]: { account: w.me, signatures: 1, since: 999 } }, disconnected: many };
    result(await w.call('disconnect', {}));
    const kept = w.box.state.disconnected.map((d) => d.origin);
    assert.deepEqual([kept.length, kept[0], kept.at(-1)], [200, many[1].origin, ORIGIN]);
});

test('a site’s transaction opens its window at once, saying who asks for which account; the review comes in it', async () => {
    const w = await wallet({ early: true, slow: 40 });
    const asked = performance.now();
    result(await w.call('signTransaction', { account: w.me, transactions: [w.transfer()] }));
    assert.deepEqual(w.opened.map((o) => [o.first, o.closed]), [[{ kind: 'pending', site: { origin: ORIGIN, host: 'jup.ag', note: 'Connected', tone: 'plain' }, account: { label: 'Me', address: w.me } }, false]]);
    assert.ok(w.opened[0].at - asked < 20, `opened after ${w.opened[0].at - asked} ms`); // before any answer of the network
    assert.ok(w.shownAt.first[0] - asked > 2 * 40); // the review, round trips later, in that window
    assert.equal(w.approvals[0].kind, 'transaction');
});

test('a site’s transaction that ends before it is shown says why in the window opened for it', async () => {
    const w = await wallet({ early: true, chain: { valid: async () => Promise.reject(new Error('down')) } });
    assert.equal((await w.call('signTransaction', { account: w.me, transactions: [w.transfer()] })).ok, false);
    assert.deepEqual(w.opened.map((o) => o.closed), ['Otus could not handle this request']);
    const named = await wallet({ early: true, validOn: [] });
    assert.deepEqual(await named.call('signTransaction', { account: named.me, chain: 'solana:mainnet', transactions: [named.transfer()] }), { ok: false, error: 'this transaction is not for mainnet' });
    assert.deepEqual(named.opened.map((o) => o.closed), ['this transaction is not for mainnet']);
    assert.equal(w.approvals.length + named.approvals.length, 0);
});

test('a no while a site’s transaction is reviewed ends the request at once; the site may ask again', async () => {
    const w = await wallet({ early: 'no', slow: 100 });
    for (let i = 0; i < 2; i++) {
        const asked = performance.now();
        assert.deepEqual(await w.call('signTransaction', { account: w.me, transactions: [w.transfer()] }), { ok: false, error: 'The user rejected the request', rejected: true });
        assert.ok(performance.now() - asked < 100, 'before the review');
    }
    assert.deepEqual([w.approvals.length, w.box.state.sites[ORIGIN].signatures, w.opened.map((o) => o.closed)], [0, 0, [true, true]]);
});

test('a message is shown as text with what is invisible marked, or as hex; signing it counts for the site', async () => {
    const w = await wallet();
    result(await w.call('signMessage', { account: w.me, message: base64(new TextEncoder().encode('pay‮me\u0007\nnow')) }));
    result(await w.call('signMessage', { account: w.me, message: base64(new Uint8Array([0xff, 0xfe, 0x00])) }));
    assert.deepEqual(w.approvals.map((a) => (a.kind === 'message' ? a.text : null)), ['pay�me�\nnow', '0xfffe00']);
    assert.equal(w.box.state.sites[ORIGIN].signatures, 2);
});

test('a sign-in shows and signs every field the site sets, in order', async () => {
    const w = await wallet();
    const input = { statement: 'Hi', uri: ORIGIN, version: '1', chainId: 'mainnet', nonce: 'n0nce123', issuedAt: '2026-10-03T12:00:00Z', expirationTime: '2026-10-04T12:00:00Z', notBefore: '2026-10-03T11:00:00Z', requestId: 'r1' };
    const s = result<{ signedMessage: string }>(await w.call('signIn', input));
    const lines = new TextDecoder().decode(bytes(s.signedMessage)).split('\n').slice(5); // after the address and the statement
    assert.deepEqual(lines, ['URI: https://jup.ag', 'Version: 1', 'Chain ID: mainnet', 'Nonce: n0nce123', 'Issued At: 2026-10-03T12:00:00Z', 'Expiration Time: 2026-10-04T12:00:00Z', 'Not Before: 2026-10-03T11:00:00Z', 'Request ID: r1']);
    const shown = w.approvals[0];
    assert.deepEqual(shown.kind === 'signIn' && shown.fields.map(([k]) => k), ['Domain', 'Address', 'Statement', 'URI', 'Version', 'Chain ID', 'Nonce', 'Issued At', 'Expiration Time', 'Not Before', 'Request ID']);
});

test('the day a site is known from stays the day of its first transaction', async () => {
    const w = await wallet();
    w.box.state = { ...w.box.state, sites: { [ORIGIN]: { account: w.me, signatures: 3, since: 5 } } };
    result(await w.call('signTransaction', { account: w.me, transactions: [w.transfer()] }));
    assert.deepEqual(w.box.state.sites[ORIGIN], { account: w.me, signatures: 4, since: 5, programs: [] });
});

test('a site keeps the programs its transactions call, and one it never called is a notice', async () => {
    const w = await wallet();
    const other = key(50);
    w.box.state = { ...w.box.state, sites: { [ORIGIN]: { account: w.me, signatures: 3, since: 5, programs: [] } } };
    // The transfer, and a call to a program that is not Solana's own.
    const call = base64(
        new Uint8Array(
            getTransactionEncoder().encode(
                compileTransaction(
                    pipe(
                        createTransactionMessage({ version: 0 }),
                        (m) => setTransactionMessageFeePayer(w.me, m),
                        (m) => setTransactionMessageLifetimeUsingBlockhash({ blockhash: blockhash(key(9)), lastValidBlockHeight: 0n }, m),
                        (m) => appendTransactionMessageInstruction(getTransferSolInstruction({ source: createNoopSigner(w.me), destination: key(2), amount: lamports(1_000_000n) }), m),
                        (m) => appendTransactionMessageInstruction({ programAddress: other, accounts: [], data: new Uint8Array() }, m),
                    ),
                ),
            ),
        ),
    );
    const isNew = (a: Approval) => a.kind === 'transaction' && a.findings.some((f) => f.title === 'New program for this site');
    result(await w.call('signTransaction', { account: w.me, transactions: [call] }));
    assert.ok(isNew(w.approvals[0]));
    assert.deepEqual(w.box.state.sites[ORIGIN].programs, [other]);
    result(await w.call('signTransaction', { account: w.me, transactions: [call] }));
    assert.ok(!isNew(w.approvals[1])); // kept: no longer new
});

test('a site\u2019s transaction whose blockhash runs out while the user decides is not signed', async () => {
    let checks = 0; // known when it came, no longer once approved
    const w = await wallet({ chain: { valid: async () => ++checks <= 1 } });
    assert.deepEqual(await w.call('signTransaction', { account: w.me, transactions: [w.transfer()] }), { ok: false, error: 'it expired before you signed it, so nothing was sent' });
    assert.equal(w.approvals.length, 1);
    assert.equal(w.box.state.sites[ORIGIN].signatures, 0);
    const shown = w.approvals[0];
    assert.equal(shown.kind === 'transaction' && shown.expiry, null); // no time shown: none tells a blockhash's age
});

test('while the user decides, the window hears about when the blockhash ends, by its place among the recent ones', async () => {
    const heard: unknown[] = [];
    const w = await wallet({ chain: { age: async () => 30, blockRate: async () => 3 } });
    w.shell.approve = (_a, follow) => new Promise((done) => follow?.((life) => (heard.push(life), done(false))));
    await w.call('signTransaction', { account: w.me, transactions: [w.transfer()] });
    assert.deepEqual(heard, [{ until: NOW + ((150 - 30) / 3) * 1000 }]); // 120 blocks at 3 a second: 40 s
});

test('off the recent list, the window hears it is gone once the network says it can no longer land', async () => {
    let alive = true;
    const heard: unknown[] = [];
    const w = await wallet({ chain: { age: async () => null, valid: async () => alive } });
    w.shell.approve = (_a, follow) =>
        new Promise((done) =>
            follow?.((life) => {
                heard.push(life);
                if ('expired' in life) return done(false);
                alive = false; // a block or two left: it dies while the user reads
            }),
        );
    const reply = await w.call('signTransaction', { account: w.me, transactions: [w.transfer()] });
    assert.deepEqual(heard, [{ until: NOW }, { expired: true }]);
    assert.equal(reply.ok, false);
});

test('a transfer made in the popup counts for the address it pays, and keeping count never changes how it went', async () => {
    const w = await wallet();
    // An address it only names, read-only beside the transfer to key(2): not one you sent to.
    const named = new Uint8Array(getTransactionEncoder().encode(compileTransaction(pipe(
        createTransactionMessage({ version: 0 }),
        (m) => setTransactionMessageFeePayer(w.me, m),
        (m) => setTransactionMessageLifetimeUsingBlockhash({ blockhash: blockhash(key(9)), lastValidBlockHeight: 0n }, m),
        (m) => appendTransactionMessageInstruction({ ...getTransferSolInstruction({ source: createNoopSigner(w.me), destination: key(2), amount: lamports(1_000_000n) }), accounts: [...getTransferSolInstruction({ source: createNoopSigner(w.me), destination: key(2), amount: lamports(1_000_000n) }).accounts, { address: key(3), role: AccountRole.READONLY }] }, m),
    ))));
    assert.equal(result<{ outcome: string }>(await own(named, w.me, key(3), w.shell)).outcome, 'confirmed');
    assert.deepEqual(w.box.state.sent, {});
    // Storage failing as it counts: the transfer still landed, and says so.
    const failing = await wallet();
    const update = failing.shell.update;
    failing.shell.update = async (change) => update((s) => {
        const part = change(s);
        if (part && 'sent' in part) throw new Error('storage');
        return part;
    });
    assert.equal(result<{ outcome: string }>(await own(bytes(failing.transfer()), failing.me, key(2), failing.shell)).outcome, 'confirmed');
});

// The Ledger in the window: it signs the message the approval carries, with the account's key.
const onDevice = (key: CryptoKey) => async (a: Approval) => (a.kind === 'transaction' && a.ledger ? signBytes(key, bytes(a.ledger.message)) : false);

test('a Ledger account signs in its window: the approval carries the message, and the signature is checked and put in place', async () => {
    const real: Awaited<ReturnType<typeof wallet>> = await wallet({ ledger: true, answer: (a) => onDevice(real.pair.privateKey)(a) });
    const { transactions } = result<{ transactions: string[] }>(await real.call('signTransaction', { account: real.me, transactions: [real.transfer()] }));
    const signed = getTransactionDecoder().decode(bytes(transactions[0]));
    const shown = real.approvals[0];
    assert.ok(shown.kind === 'transaction' && shown.signer === 'ledger' && shown.ledger);
    assert.deepEqual(shown.ledger, { path: LEDGER_PATH, message: base64(new Uint8Array(signed.messageBytes)) });
    assert.ok(await verifySignature(real.pair.publicKey, signed.signatures[real.me]!, signed.messageBytes));
    assert.equal(real.box.state.accounts[0].signatures, 1);
    assert.deepEqual(real.box.state.signedHere[real.me], [getBase58Decoder().decode(signed.signatures[real.me]!)]);
});

test('a Ledger signature of other bytes, by another key, or none at all, signs nothing', async () => {
    const other = await generateKeyPair();
    const answers: ((w: Awaited<ReturnType<typeof wallet>>) => (a: Approval) => Promise<boolean | SignatureBytes>)[] = [
        (w) => async () => signBytes(w.pair.privateKey, new Uint8Array([1, 2, 3])),
        () => onDevice(other.privateKey),
        () => async () => true,
    ];
    for (const answer of answers) {
        const w: Awaited<ReturnType<typeof wallet>> = await wallet({ ledger: true, answer: (a) => answer(w)(a) });
        const reply = await w.call('signTransaction', { account: w.me, transactions: [w.transfer()] });
        assert.deepEqual(reply, { ok: false, error: 'the Ledger did not sign it with this account' });
        assert.equal(w.box.state.accounts[0].signatures ?? 0, 0);
    }
});

test('a Ledger account signs no messages or sign-ins, asked like any other so a site learns nothing; and no v1 transactions', async () => {
    const w = await wallet({ ledger: true });
    const refused = { ok: false, error: 'a Ledger account signs transactions only, not messages' };
    assert.deepEqual(await w.call('signMessage', { account: w.me, message: base64(new TextEncoder().encode('Hello')) }), refused);
    assert.deepEqual(await w.call('signIn', { statement: 'Sign in' }), refused);
    assert.deepEqual(w.approvals.map((a) => [a.kind, 'signer' in a && a.signer]), [['message', 'ledger'], ['signIn', 'ledger']]); // the window says why it cannot
    // A v1 transaction is shown, with why it cannot be signed, and nothing for the device.
    const v1 = { ok: false, error: 'a Ledger cannot sign version 1 transactions' };
    assert.deepEqual(await w.call('signTransaction', { account: w.me, transactions: [w.transfer(w.me, w.me, 1)] }), v1);
    assert.deepEqual(await own(bytes(w.transfer(w.me, w.me, 1)), w.me, key(2), w.shell), v1);
    const shown = w.approvals[2];
    assert.ok(shown.kind === 'transaction' && shown.blocked && !shown.ledger);
    assert.equal(w.following.count, 0); // answered yes all the same, its window has nothing to follow: it closes
    // Connected, a site hears this account cannot sign v1, and builds what it can.
    w.box.state = { ...w.box.state, sites: { [ORIGIN]: { account: w.me, signatures: 0 } } };
    assert.deepEqual(result(await w.call('connect', { silent: true })), { accounts: [w.me], v1: false });
});

test('a transfer made in the popup from a Ledger account is signed on the device and sent', async () => {
    const w: Awaited<ReturnType<typeof wallet>> = await wallet({ ledger: true, answer: (a) => onDevice(w.pair.privateKey)(a) });
    const { outcome } = result<{ outcome: string }>(await own(bytes(w.transfer()), w.me, key(2), w.shell));
    assert.equal(outcome, 'confirmed');
    const sent = getTransactionDecoder().decode(w.sent[0]);
    assert.ok(await verifySignature(w.pair.publicKey, sent.signatures[w.me]!, sent.messageBytes));
    // SOL alone: no guards, so the device shows the transfer in clear; the review needs not say so.
    const shown = w.approvals[0];
    assert.deepEqual(shown.kind === 'transaction' && shown.guards, { held: false, text: '' });
    assert.ok(!(await decode(w.sent[0])).message.staticAccounts.includes(LIGHTHOUSE));
});

test('only a plain SOL transfer goes without guards from a Ledger: anything more keeps them', async () => {
    const w: Awaited<ReturnType<typeof wallet>> = await wallet({ ledger: true, answer: (a) => onDevice(w.pair.privateKey)(a) });
    const twice = base64(
        new Uint8Array(
            getTransactionEncoder().encode(
                compileTransaction(
                    pipe(
                        createTransactionMessage({ version: 0 }),
                        (m) => setTransactionMessageFeePayer(w.me, m),
                        (m) => setTransactionMessageLifetimeUsingBlockhash({ blockhash: blockhash(key(9)), lastValidBlockHeight: 0n }, m),
                        (m) => appendTransactionMessageInstruction(getTransferSolInstruction({ source: createNoopSigner(w.me), destination: key(2), amount: lamports(500_000n) }), m),
                        (m) => appendTransactionMessageInstruction(getTransferSolInstruction({ source: createNoopSigner(w.me), destination: key(2), amount: lamports(500_000n) }), m),
                    ),
                ),
            ),
        ),
    );
    result(await own(bytes(twice), w.me, key(2), w.shell));
    const shown = w.approvals[0];
    assert.ok(shown.kind === 'transaction' && shown.guards.held, 'guarded');
    assert.ok((await decode(w.sent[0])).message.staticAccounts.includes(LIGHTHOUSE));
});


test('shown as reviewed at once, then as prepared: no verdict, fee, guards or hash before, and only the final form is answered', async () => {
    const w = await wallet({ key: true });
    await w.call('signTransaction', { account: w.me, transactions: [w.transfer()] });
    const [first] = w.firsts;
    const [final] = w.approvals;
    assert.ok(first.kind === 'transaction' && final.kind === 'transaction');
    assert.equal(first.preparing, true);
    assert.deepEqual([first.hash, first.fee, first.guards.text, first.added], ['', '', '', []]);
    assert.ok(!first.balances.some((b) => b.lines.some((l) => l.note.includes('fee'))), 'no fee guessed');
    assert.ok(first.balances.length > 0, 'the balances, as reviewed');
    assert.equal(final.preparing, undefined);
    assert.ok(final.hash && final.fee && final.guards.held);
});

test('a transfer built in Send without a blockhash is sent with the one the network gave, as its final form shows it', async () => {
    for (const version of [0, 1] as const) {
        const w = await wallet({ key: true });
        const unset = { blockhash: '11111111111111111111111111111111' as Blockhash, lastValidBlockHeight: 0n };
        const built = await sendTransfer(w.me, { kind: 'wallet', address: key(2) }, { kind: 'sol' }, 1_000_000n, unset, version);
        result(await own(built, w.me, key(2), w.shell));
        const sent = await decode(w.sent[0]);
        assert.equal(sent.message.lifetimeToken, key(99), `v${version}: the network's blockhash`);
        const final = w.approvals[0];
        assert.ok(final.kind === 'transaction' && final.hash.replaceAll(' ', '') === sent.hash, `v${version}: the hash shown is the one sent`);
        const signature = getTransactionDecoder().decode(w.sent[0]).signatures[w.me]!;
        assert.ok(await verifySignature(w.pair.publicKey, signature, sent.messageBytes));
    }
});

test('a transfer made in the popup shows after two round trips (blockhash with the review), prepared after two more', async () => {
    const RTT = 60;
    const w = await wallet({ key: true, slow: RTT });
    const start = performance.now();
    result(await own(bytes(w.transfer()), w.me, key(2), w.shell));
    const first = w.shownAt.first[0] - start;
    const final = w.shownAt.final[0] - start;
    // The review: the accounts, then their simulation (the blockhash and the deploy dates read meanwhile).
    assert.ok(first >= 2 * RTT && first < 3 * RTT, `shown after ${Math.round(first)} ms`);
    // Prepared: the limit measured with the price asked meanwhile, then the transaction as signed simulated.
    assert.ok(final - first >= 2 * RTT && final - first < 3.5 * RTT, `prepared ${Math.round(final - first)} ms later`);
});


test('what the popup makes for stake is reviewed as Otus’s own, signed and sent; anything more is refused', async () => {
    const w = await wallet();
    const life = { blockhash: blockhash(key(9)), lastValidBlockHeight: 0n };
    const made = await staking(w.me, { kind: 'stake', seed: 'stake:0', lamports: 1_001_666_240n, vote: key(40) }, life);
    assert.equal(result<{ outcome: string }>(await stakeOwn(made, w.me, w.shell)).outcome, 'confirmed');
    const shown = w.approvals[0];
    assert.ok(shown.kind === 'transaction');
    assert.deepEqual([shown.site.host, shown.site.note], ['Otus', 'Your own stake']);
    const stake = await stakeAt(w.me, 'stake:0');
    assert.equal(result<{ outcome: string }>(await stakeOwn(await staking(w.me, { kind: 'unstake', stake }, life), w.me, w.shell)).outcome, 'confirmed');
    assert.equal(result<{ outcome: string }>(await stakeOwn(await staking(w.me, { kind: 'withdraw', stake, lamports: 5n }, life), w.me, w.shell)).outcome, 'confirmed');
    assert.equal(w.sent.length, 3);
    // Bytes changed in what Otus built: another withdrawer, an account the seed does not derive, another recipient.
    const bent = (bytes: Uint8Array, ix: number, change: (data: Uint8Array) => void, account?: [number, number]) => {
        const tx = getTransactionDecoder().decode(bytes);
        const message = getCompiledTransactionMessageDecoder().decode(tx.messageBytes) as { instructions: { data?: Uint8Array; accountIndices?: number[] }[] };
        const instructions = message.instructions.map((x, i) => {
            if (i !== ix) return x;
            const data = new Uint8Array(x.data ?? []);
            change(data);
            const accountIndices = [...(x.accountIndices ?? [])];
            if (account) accountIndices[account[0]] = account[1];
            return { ...x, data, accountIndices };
        });
        const messageBytes = getCompiledTransactionMessageEncoder().encode({ ...message, instructions } as never);
        return new Uint8Array(getTransactionEncoder().encode({ ...tx, messageBytes } as never));
    };
    const stranger = new Uint8Array(getBase58Encoder().encode(key(6)));
    const withdrawer = bent(made, 2, (d) => d.set(stranger, 36));
    assert.match(((await stakeOwn(withdrawer, w.me, w.shell)) as { error: string }).error, /does more than stake/);
    const locked = bent(made, 2, (d) => (d[68] = 1));
    assert.match(((await stakeOwn(locked, w.me, w.shell)) as { error: string }).error, /does more than stake/);
    const reseeded = bent(made, 1, (d) => (d[44] = 'x'.charCodeAt(0)));
    assert.match(((await stakeOwn(reseeded, w.me, w.shell)) as { error: string }).error, /does more than stake/);
    // A seed with a byte-order mark first is checked as its bytes, as the network derives the address: read as text,
    // the mark would be dropped and another address derived.
    const bom = await staking(w.me, { kind: 'stake', seed: '\uFEFFa', lamports: 1_001_666_240n, vote: key(40) }, life);
    assert.equal(result<{ outcome: string }>(await stakeOwn(bom, w.me, w.shell)).outcome, 'confirmed');
    // Withdrawn elsewhere, unstaked or delegated by another, paid or based elsewhere, or one instruction more.
    const withdraw = await staking(w.me, { kind: 'withdraw', stake, lamports: 5n }, life);
    const unstake = await staking(w.me, { kind: 'unstake', stake }, life);
    const indexOf = async (b: Uint8Array, a: string) => getCompiledTransactionMessageDecoder().decode(getTransactionDecoder().decode(b).messageBytes).staticAccounts.indexOf(a as never);
    const toStake = await indexOf(withdraw, stake);
    for (const [b, ix, at] of [[withdraw, 1, 1], [withdraw, 1, 2], [unstake, 1, 1], [made, 3, 2], [made, 1, 0], [made, 1, 2]] as const) {
        const other = b === made ? await indexOf(made, key(40)) : toStake; // another account of the same transaction
        assert.match(((await stakeOwn(bent(b, ix, () => {}, [at, other]), w.me, w.shell)) as { error: string }).error, /does more than stake/, `${ix}:${at}`);
    }
    const twice = getTransactionDecoder().decode(unstake);
    const message = getCompiledTransactionMessageDecoder().decode(twice.messageBytes) as { instructions: unknown[] };
    const doubled = new Uint8Array(getTransactionEncoder().encode({ ...twice, messageBytes: getCompiledTransactionMessageEncoder().encode({ ...message, instructions: [...message.instructions, message.instructions[1]] } as never) } as never));
    assert.match(((await stakeOwn(doubled, w.me, w.shell)) as { error: string }).error, /does more than stake/);
    // A transfer is no stake, nor is a stake another wallet signs.
    assert.match(((await stakeOwn(bytes(w.transfer()), w.me, w.shell)) as { error: string }).error, /does more than stake/);
    const theirs = await staking(key(5), { kind: 'unstake', stake }, life);
    assert.match(((await stakeOwn(theirs, w.me, w.shell)) as { error: string }).error, /does not sign this transaction/);
    assert.equal(w.sent.length, 4);
});


// SyncNative as Jupiter's routes have it: the account alone (the generated client adds the rent sysvar).
const syncNative = (account: Address) => ({ programAddress: TOKEN_PROGRAM_ADDRESS, accounts: [{ address: account, role: AccountRole.WRITABLE }], data: Uint8Array.of(17) });

const WSOL = address('So11111111111111111111111111111111111111112');
const USDC = address('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
// What the popup asked for: 0.01 SOL for USDC, quoted at 1 USDC, 0.5% slippage.
const ASKED: Asked = { input: WSOL, output: USDC, amount: 10_000_000n, out: 1_000_000n, slippageBps: 50 };

// Jupiter's route_v2 as its IDL lays it out: the amount in, the quote, the slippage, the platform fee and positive
// slippage share, an empty route plan; the taker, its source and destination accounts, the mints, their token
// programs, no other destination (Jupiter's own address), its event authority and itself.
function routeV2(me: Address, at: { wrapped: Address; usdc: Address }, terms: Partial<{ amount: bigint; quoted: bigint; slippage: number; fee: number; positive: number; source: Address; destination: Address; output: Address; elsewhere: Address }> = {}) {
    const data = new Uint8Array(8 + 8 + 8 + 2 + 2 + 2 + 4);
    data.set([0xbb, 0x64, 0xfa, 0xcc, 0x31, 0xc4, 0xaf, 0x14]);
    const view = new DataView(data.buffer);
    view.setBigUint64(8, terms.amount ?? ASKED.amount, true);
    view.setBigUint64(16, terms.quoted ?? ASKED.out, true);
    view.setUint16(24, terms.slippage ?? ASKED.slippageBps, true);
    view.setUint16(26, terms.fee ?? 0, true);
    view.setUint16(28, terms.positive ?? 0, true);
    const r = (a: Address, role = AccountRole.READONLY) => ({ address: a, role });
    return {
        programAddress: JUPITER,
        accounts: [r(me, AccountRole.WRITABLE_SIGNER), r(terms.source ?? at.wrapped, AccountRole.WRITABLE), r(terms.destination ?? at.usdc, AccountRole.WRITABLE), r(WSOL), r(terms.output ?? USDC), r(TOKEN_PROGRAM_ADDRESS), r(TOKEN_PROGRAM_ADDRESS), r(terms.elsewhere ?? JUPITER), r(key(30)), r(JUPITER)],
        data,
    };
}

// shared_accounts_route_v2 for the same swap, laid out as Otus's terms reader takes it (its id after the discriminator;
// the taker at 1, from 2 into 5, the mints at 6 and 7, their programs at 8 and 9): through Jupiter's own accounts.
function sharedV2(me: Address, at: { wrapped: Address; usdc: Address }) {
    const data = new Uint8Array(8 + 1 + 8 + 8 + 2 + 2 + 2 + 4);
    data.set([0xd1, 0x98, 0x53, 0x93, 0x7c, 0xfe, 0xd8, 0xe9]);
    const view = new DataView(data.buffer);
    view.setBigUint64(9, ASKED.amount, true);
    view.setBigUint64(17, ASKED.out, true);
    view.setUint16(25, ASKED.slippageBps, true);
    const r = (a: Address, role = AccountRole.READONLY) => ({ address: a, role });
    return {
        programAddress: JUPITER,
        accounts: [r(TOKEN_PROGRAM_ADDRESS), r(me, AccountRole.WRITABLE_SIGNER), r(at.wrapped, AccountRole.WRITABLE), r(key(31), AccountRole.WRITABLE), r(key(32), AccountRole.WRITABLE), r(at.usdc, AccountRole.WRITABLE), r(WSOL), r(USDC), r(TOKEN_PROGRAM_ADDRESS), r(TOKEN_PROGRAM_ADDRESS), r(key(30)), r(JUPITER)],
        data,
    };
}

// A swap as Otus builds it from a Jupiter route, SOL for USDC: the wrapped-SOL account opened, SOL moved in and synced,
// the USDC account opened, Jupiter's swap, the wrapped-SOL account closed back; `change` bends it.
async function swapFor(me: Address, change: (r: Route, at: { wrapped: Address; usdc: Address }) => void | Promise<void> = () => {}, tip = SENDER_TIPS[0]) {
    const [wrapped] = await findAssociatedTokenPda({ owner: me, mint: WSOL, tokenProgram: TOKEN_PROGRAM_ADDRESS });
    const [usdc] = await findAssociatedTokenPda({ owner: me, mint: USDC, tokenProgram: TOKEN_PROGRAM_ADDRESS });
    const signer = createNoopSigner(me);
    const route: Route = {
        ask: { input: WSOL, output: USDC, amount: ASKED.amount, taker: me, slippageBps: ASKED.slippageBps, maxAccounts: 64 },
        out: ASKED.out,
        least: 995_000n,
        impact: null,
        venues: [{ label: 'Whirlpool', share: 100 }],
        setup: [
            getCreateAssociatedTokenIdempotentInstruction({ payer: signer, ata: wrapped, owner: me, mint: WSOL }),
            getTransferSolInstruction({ source: signer, destination: wrapped, amount: ASKED.amount }),
            syncNative(wrapped),
            getCreateAssociatedTokenIdempotentInstruction({ payer: signer, ata: usdc, owner: me, mint: USDC }),
        ],
        swap: routeV2(me, { wrapped, usdc }),
        cleanup: [getCloseAccountInstruction({ account: wrapped, destination: me, owner: signer })],
        tables: {},
    };
    await change(route, { wrapped, usdc });
    return swapping(route, { blockhash: blockhash(key(9)), lastValidBlockHeight: 0n }, tip);
}

test('what the popup makes for a swap is reviewed as Otus’s own, signed and landed through Sender; anything more is refused', async () => {
    const w = await wallet();
    const landedFast: Uint8Array[] = [];
    const fast = { ...w.shell, fast: (c: Chain) => ({ ...c, send: async (tx: Uint8Array) => void landedFast.push(tx) }) };
    assert.equal(result<{ outcome: string }>(await swapOwn(await swapFor(w.me), w.me, ASKED, fast)).outcome, 'confirmed');
    const shown = w.approvals[0];
    assert.ok(shown.kind === 'transaction');
    assert.deepEqual([shown.site.host, shown.site.note], ['Otus', 'Your own swap']);
    assert.equal(landedFast.length, 1, 'sent through Sender');
    assert.equal(w.sent.length, 0, 'not through the RPC');
    const me = createNoopSigner(w.me);
    const stranger = key(6);
    const bent: [string, Promise<Uint8Array>][] = [
        // Around the swap: a transfer out, accounts opened otherwise, SOL moved or synced elsewhere, closed elsewhere.
        ['a transfer out', swapFor(w.me, (r) => void r.setup.push(getTransferSolInstruction({ source: me, destination: stranger, amount: 1n })))],
        ['an account for another', swapFor(w.me, (r) => void (r.setup[3] = getCreateAssociatedTokenIdempotentInstruction({ payer: me, ata: key(31), owner: stranger, mint: key(32) })))],
        ['an account with a fake token program', swapFor(w.me, async (r) => void (r.setup[3] = getCreateAssociatedTokenIdempotentInstruction({ payer: me, ata: (await findAssociatedTokenPda({ owner: w.me, mint: USDC, tokenProgram: key(33) }))[0], owner: w.me, mint: USDC, tokenProgram: key(33) })))],
        ['an account at an address it does not derive', swapFor(w.me, (r) => void (r.setup[3] = getCreateAssociatedTokenIdempotentInstruction({ payer: me, ata: key(34), owner: w.me, mint: USDC })))],
        ['an account opened twice', swapFor(w.me, (r) => void r.setup.push(r.setup[3]))],
        ['SOL elsewhere', swapFor(w.me, (r, a) => void (r.setup[1] = getTransferSolInstruction({ source: me, destination: a.usdc, amount: ASKED.amount })))],
        ['more SOL wrapped than asked', swapFor(w.me, (r, a) => void (r.setup[1] = getTransferSolInstruction({ source: me, destination: a.wrapped, amount: ASKED.amount * 50n })))],
        ['SOL wrapped twice', swapFor(w.me, (r) => void r.setup.splice(2, 0, r.setup[1]))],
        ['synced elsewhere', swapFor(w.me, (r, a) => void (r.setup[2] = syncNative(a.usdc)))],
        ['synced with more accounts', swapFor(w.me, (r, a) => void (r.setup[2] = getSyncNativeInstruction({ account: a.wrapped })))],
        ['a token account closed that is not wrapped SOL', swapFor(w.me, (r, a) => void (r.cleanup = [getCloseAccountInstruction({ account: a.usdc, destination: w.me, owner: me })]))],
        ['closed to another', swapFor(w.me, (r, a) => void (r.cleanup = [getCloseAccountInstruction({ account: a.wrapped, destination: stranger, owner: me })]))],
        // The swap's own terms: other than asked, with a fee, from or into other accounts.
        ['more in than asked', swapFor(w.me, (r, a) => void (r.swap = routeV2(w.me, a, { amount: ASKED.amount * 50n })))],
        ['a lower quote', swapFor(w.me, (r, a) => void (r.swap = routeV2(w.me, a, { quoted: 1n })))],
        ['a wider slippage', swapFor(w.me, (r, a) => void (r.swap = routeV2(w.me, a, { slippage: 10_000 })))],
        ['a platform fee', swapFor(w.me, (r, a) => void (r.swap = routeV2(w.me, a, { fee: 100 })))],
        ['a positive slippage share', swapFor(w.me, (r, a) => void (r.swap = routeV2(w.me, a, { positive: 50 })))],
        ['into another wallet', swapFor(w.me, async (r, a) => void (r.swap = routeV2(w.me, a, { destination: (await findAssociatedTokenPda({ owner: stranger, mint: USDC, tokenProgram: TOKEN_PROGRAM_ADDRESS }))[0] })))],
        ['to another destination', swapFor(w.me, (r, a) => void (r.swap = routeV2(w.me, a, { elsewhere: a.usdc })))],
        ['from another account', swapFor(w.me, (r, a) => void (r.swap = routeV2(w.me, a, { source: a.usdc })))],
        ['for another token', swapFor(w.me, (r, a) => void (r.swap = routeV2(w.me, a, { output: key(35) })))],
        ['another of Jupiter’s instructions', swapFor(w.me, (r, a) => void (r.swap = { ...routeV2(w.me, a), data: Uint8Array.of(1, 2, 3, 4, 5, 6, 7, 8, ...new Uint8Array(26)) }))],
        ['an account for a token the swap does not pass through', swapFor(w.me, async (r) => void r.setup.push(getCreateAssociatedTokenIdempotentInstruction({ payer: me, ata: (await findAssociatedTokenPda({ owner: w.me, mint: key(37), tokenProgram: TOKEN_PROGRAM_ADDRESS }))[0], owner: w.me, mint: key(37) })))],
        ['five accounts opened', swapFor(w.me, async (r) => {
            for (const n of [40, 41, 42]) {
                const [through] = await findAssociatedTokenPda({ owner: w.me, mint: key(n), tokenProgram: TOKEN_PROGRAM_ADDRESS });
                r.setup.push(getCreateAssociatedTokenIdempotentInstruction({ payer: me, ata: through, owner: w.me, mint: key(n) }));
                r.swap = { ...r.swap, accounts: [...r.swap.accounts!, { address: through, role: AccountRole.WRITABLE }] };
            }
        })],
        ['a third token, named, at an address not your account of it', swapFor(w.me, async (r) => {
            r.setup.push(getCreateAssociatedTokenIdempotentInstruction({ payer: me, ata: key(46), owner: w.me, mint: key(47) }));
            r.swap = { ...r.swap, accounts: [...r.swap.accounts!, { address: key(46), role: AccountRole.WRITABLE }] };
        })],
        ['a third token, named, opened as your account of another', swapFor(w.me, async (r) => {
            const [ofOther] = await findAssociatedTokenPda({ owner: w.me, mint: key(49), tokenProgram: TOKEN_PROGRAM_ADDRESS });
            r.setup.push(getCreateAssociatedTokenIdempotentInstruction({ payer: me, ata: ofOther, owner: w.me, mint: key(48) }));
            r.swap = { ...r.swap, accounts: [...r.swap.accounts!, { address: ofOther, role: AccountRole.WRITABLE }] };
        })],
        ['a third token, named, under a made-up token program', swapFor(w.me, async (r) => {
            const [fake] = await findAssociatedTokenPda({ owner: w.me, mint: key(51), tokenProgram: key(50) });
            r.setup.push(getCreateAssociatedTokenIdempotentInstruction({ payer: me, ata: fake, owner: w.me, mint: key(51), tokenProgram: key(50) }));
            r.swap = { ...r.swap, accounts: [...r.swap.accounts!, { address: fake, role: AccountRole.WRITABLE }] };
        })],
        ['a third token opened twice', swapFor(w.me, async (r) => {
            const [through] = await findAssociatedTokenPda({ owner: w.me, mint: key(52), tokenProgram: TOKEN_PROGRAM_ADDRESS });
            const create = getCreateAssociatedTokenIdempotentInstruction({ payer: me, ata: through, owner: w.me, mint: key(52) });
            r.setup.push(create, create);
            r.swap = { ...r.swap, accounts: [...r.swap.accounts!, { address: through, role: AccountRole.WRITABLE }] };
        })],
        ['a third token named only by a second swap', swapFor(w.me, async (r, a) => {
            const [through] = await findAssociatedTokenPda({ owner: w.me, mint: key(54), tokenProgram: TOKEN_PROGRAM_ADDRESS });
            const second = routeV2(w.me, a);
            r.setup.push(getCreateAssociatedTokenIdempotentInstruction({ payer: me, ata: through, owner: w.me, mint: key(54) }), { ...second, accounts: [...second.accounts, { address: through, role: AccountRole.WRITABLE }] });
        })],
        ['a third token named by the shared route', swapFor(w.me, async (r, a) => {
            const [through] = await findAssociatedTokenPda({ owner: w.me, mint: key(55), tokenProgram: TOKEN_PROGRAM_ADDRESS });
            r.setup.push(getCreateAssociatedTokenIdempotentInstruction({ payer: me, ata: through, owner: w.me, mint: key(55) }));
            const shared = sharedV2(w.me, a);
            r.swap = { ...shared, accounts: [...shared.accounts, { address: through, role: AccountRole.WRITABLE }] };
        })],
        ["another's account of a token passed through", swapFor(w.me, async (r) => {
            const [theirs] = await findAssociatedTokenPda({ owner: stranger, mint: key(43), tokenProgram: TOKEN_PROGRAM_ADDRESS });
            r.setup.push(getCreateAssociatedTokenIdempotentInstruction({ payer: me, ata: theirs, owner: stranger, mint: key(43) }));
            r.swap = { ...r.swap, accounts: [...r.swap.accounts!, { address: theirs, role: AccountRole.WRITABLE }] };
        })],
        ['a swap with its accounts cut short', swapFor(w.me, (r, a) => void (r.swap = { ...routeV2(w.me, a), accounts: routeV2(w.me, a).accounts.slice(0, 7) }))],
        ['Jupiter twice', swapFor(w.me, (r) => void r.setup.push(r.swap))],
        ['no swap', swapFor(w.me, (r) => void (r.swap = syncNative(key(36))))],
        ['a tip elsewhere', swapFor(w.me, () => {}, key(7))],
    ];
    const refusals = new Map<string, string>();
    for (const [what, made] of bent) {
        const { error } = (await swapOwn(await made, w.me, ASKED, fast)) as { error: string };
        assert.match(error, /does more than swap: /, what);
        refusals.set(what, error);
    }
    // Each says which part of it is not a swap as asked.
    const why: [string, RegExp][] = [
        ['a tip elsewhere', /its last instruction isn't the tip to Sender/],
        ['a platform fee', /the swap takes a fee/],
        ['a positive slippage share', /the swap takes a fee/],
        ['more in than asked', /the swap pays another amount than asked/],
        ['a lower quote', /quote or slippage isn't the one shown/],
        ['into another wallet', /pays into an account that isn't your token account/],
        ['from another account', /pays from an account that isn't your token account/],
        ['to another destination', /pays out to another account/],
        ['for another token', /for other tokens than asked/],
        ['an account for a token the swap does not pass through', /opens an account for a token the swap doesn't pass through/],
        ['five accounts opened', /opens more than four accounts/],
        ["another's account of a token passed through", /opens an account otherwise than for you/],
        ['a third token, named, at an address not your account of it', /opens an account that isn't your token account/],
        ['a third token, named, opened as your account of another', /opens an account that isn't your token account/],
        ['a third token, named, under a made-up token program', /opens an account that isn't your token account/],
        ['a third token opened twice', /opens the same account twice/],
        ['a third token named only by a second swap', /swaps more than once/],
        ['a third token named by the shared route', /opens an account for a token the swap doesn't pass through/],
        ['Jupiter twice', /swaps more than once/],
        ['no swap', /token instruction \(17\)|there is no swap/],
        ['closed to another', /token instruction \(9\)/],
    ];
    for (const [what, said] of why) assert.match(refusals.get(what) ?? '', said, what);
    // A route of several steps, through the taker's own accounts of two tokens between (route_v2 swaps through them):
    // opened, and named by the swap, they go.
    const hops = await swapFor(w.me, async (r) => {
        for (const n of [44, 45]) {
            const [through] = await findAssociatedTokenPda({ owner: w.me, mint: key(n), tokenProgram: TOKEN_PROGRAM_ADDRESS });
            r.setup.push(getCreateAssociatedTokenIdempotentInstruction({ payer: me, ata: through, owner: w.me, mint: key(n) }));
            r.swap = { ...r.swap, accounts: [...r.swap.accounts!, { address: through, role: AccountRole.WRITABLE }] };
        }
    });
    assert.equal(result<{ outcome: string }>(await swapOwn(hops, w.me, ASKED, fast)).outcome, 'confirmed');
    // Neither side SOL: nothing may close the wrapped-SOL account.
    const tokens: Asked = { ...ASKED, input: USDC, output: key(38) };
    const closing = await swapFor(w.me, async (r, a) => {
        const [out] = await findAssociatedTokenPda({ owner: w.me, mint: key(38), tokenProgram: TOKEN_PROGRAM_ADDRESS });
        r.setup = [getCreateAssociatedTokenIdempotentInstruction({ payer: me, ata: out, owner: w.me, mint: key(38) })];
        const swap = routeV2(w.me, { wrapped: a.usdc, usdc: out }, { output: key(38) });
        swap.accounts[3] = { address: USDC, role: AccountRole.READONLY };
        r.swap = swap;
    });
    assert.match(((await swapOwn(closing, w.me, tokens, fast)) as { error: string }).error, /does more than swap/);
    // The same swap without that close is one, and goes.
    const plain = await swapFor(w.me, async (r, a) => {
        const [out] = await findAssociatedTokenPda({ owner: w.me, mint: key(38), tokenProgram: TOKEN_PROGRAM_ADDRESS });
        r.setup = [getCreateAssociatedTokenIdempotentInstruction({ payer: me, ata: out, owner: w.me, mint: key(38) })];
        const swap = routeV2(w.me, { wrapped: a.usdc, usdc: out }, { output: key(38) });
        swap.accounts[3] = { address: USDC, role: AccountRole.READONLY };
        r.swap = swap;
        r.cleanup = [];
    });
    assert.equal(result<{ outcome: string }>(await swapOwn(plain, w.me, tokens, fast)).outcome, 'confirmed');
    // Asked for a token, nothing may wrap SOL.
    assert.match(((await swapOwn(await swapFor(w.me), w.me, { ...ASKED, input: USDC, output: WSOL }, fast)) as { error: string }).error, /does more than swap/);
    // The tip's amount, or the limit's place, changed in the bytes.
    const made = await swapFor(w.me);
    const tx = getTransactionDecoder().decode(made);
    const message = getCompiledTransactionMessageDecoder().decode(tx.messageBytes) as { instructions: { data?: Uint8Array }[] };
    const rewritten = (instructions: unknown[]) => new Uint8Array(getTransactionEncoder().encode({ ...tx, messageBytes: getCompiledTransactionMessageEncoder().encode({ ...message, instructions } as never) } as never));
    const more = message.instructions.map((x, i) => (i === message.instructions.length - 1 ? { ...x, data: Uint8Array.from([2, 0, 0, 0, ...new Uint8Array(new BigUint64Array([TIP + 1n]).buffer)]) } : x));
    assert.match(((await swapOwn(rewritten(more), w.me, ASKED, fast)) as { error: string }).error, /does more than swap/, 'a larger tip');
    assert.match(((await swapOwn(rewritten(message.instructions.slice(1)), w.me, ASKED, fast)) as { error: string }).error, /does more than swap/, 'no limit first');
    // A transfer is no swap; nor is a swap another wallet signs; nor one off mainnet.
    assert.match(((await swapOwn(bytes(w.transfer()), w.me, ASKED, fast)) as { error: string }).error, /does more than swap/);
    assert.match(((await swapOwn(await swapFor(key(5)), w.me, ASKED, fast)) as { error: string }).error, /does not sign this transaction/);
    await w.shell.update((s) => ({ settings: { ...s.settings, network: 'devnet' } }));
    assert.match(((await swapOwn(made, w.me, ASKED, fast)) as { error: string }).error, /mainnet only/);
    assert.equal(landedFast.length, 3);
});

test('a swap Otus could not guard is refused before it can be approved', async () => {
    // The review's simulation goes well; the guarded one fails, so preparing leaves it unguarded.
    let simulations = 0;
    const base = { error: null, logs: [], fee: 5000n, unitsConsumed: null, loaded: null, inner: [], innerListed: true };
    const w = await wallet({ chain: { simulate: async (_tx, watch) => ({ ...base, after: watch.map((address) => ({ exists: false as const, address })), ...(++simulations > 1 && { error: { InstructionError: [9, { Custom: 1 }] } as never }) }) } });
    const reply = (await swapOwn(await swapFor(w.me), w.me, ASKED, w.shell)) as { error: string };
    assert.equal(reply.error, "Otus can't add guards because the transaction fails with them, so nothing was sent");
    assert.equal(w.sent.length, 0);
});

test('several: all checked before any is signed, so one out of time counts nothing for the others', async () => {
    // The second, on a blockhash of its own, runs out of time right as the user says yes.
    let yes = false;
    const late = blockhash(key(8));
    const w = await wallet({ answer: () => ((yes = true), true), chain: { valid: async (hash: string) => !(yes && hash === late) } });
    const second = base64(
        new Uint8Array(
            getTransactionEncoder().encode(
                compileTransaction(
                    pipe(
                        createTransactionMessage({ version: 0 }),
                        (m) => setTransactionMessageFeePayer(w.me, m),
                        (m) => setTransactionMessageLifetimeUsingBlockhash({ blockhash: late, lastValidBlockHeight: 0n }, m),
                        (m) => appendTransactionMessageInstruction(getTransferSolInstruction({ source: createNoopSigner(w.me), destination: key(3), amount: lamports(2_000_000n) }), m),
                    ),
                ),
            ),
        ),
    );
    const reply = await w.call('signTransaction', { account: w.me, transactions: [w.transfer(), second] });
    assert.equal(reply.ok, false);
    assert.match(reply.ok ? '' : reply.error, /^transaction 2 of 2: /);
    assert.equal(w.box.state.sites[ORIGIN].signatures, 0);
    assert.equal(w.box.state.signedHere[w.me], undefined);
});

test('several the site sends: signed, Otus’s part is done, and the window says so at once', async () => {
    const w = await wallet();
    result<{ transactions: string[] }>(await w.call('signTransaction', { account: w.me, transactions: [w.transfer(), w.transfer(w.me, w.me, 1)] }));
    assert.deepEqual(w.outcomes, [{ phase: 'signed', host: 'jup.ag', words: 'Signed all 2: jup.ag sends them.' }]);
});