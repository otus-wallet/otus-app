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
    createNoopSigner,
    createTransactionMessage,
    generateKeyPair,
    getAddressFromPublicKey,
    getBase58Encoder,
    getBase64Decoder,
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
async function wallet(o: { key?: boolean; ledger?: boolean; locked?: boolean; answer?: (a: Approval, s: { state: State }) => Answer | Promise<Answer>; validOn?: string[]; chain?: Partial<Chain>; slow?: number } = {}) {
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
        ? (Object.fromEntries(Object.entries(quick).map(([k, f]) => [k, async (...args: unknown[]) => (await new Promise((r) => setTimeout(r, o.slow)), (f as (...a: unknown[]) => unknown)(...args))])) as Chain)
        : quick;
    const looked: string[][] = []; // the mints Jupiter was asked about
    const outcomes: Outcome[] = []; // what approved windows heard
    const settled = { count: 0 }; // how many times Otus's pages were told a transaction landed
    const shell: Shell = {
        load: async () => box.state,
        update: async (change) => void (box.state = { ...box.state, ...(change(box.state) ?? {}) }),
        // As the window: the first form shown, the final one (when it comes) the only one answered.
        approve: async (a, _follow, later, after) => {
            firsts.push(a);
            shownAt.first.push(performance.now());
            const final = later ? await later : a;
            shownAt.final.push(performance.now());
            approvals.push(final);
            const answer = o.answer ? await o.answer(final, box) : true;
            if (answer !== false) after?.((outcome) => outcomes.push(outcome)); // the window stays, and hears how it goes
            return answer;
        },
        sign: async (_account, data): Promise<SignatureBytes> => {
            if (o.locked) throw new Refused('Otus is locked');
            return signBytes(pair.privateKey, data);
        },
        chain: (rpc) => ({ ...chain, valid: o.chain?.valid ?? (async () => !o.validOn || o.validOn.includes(rpc)) }), // validOn: the RPCs that know the blockhash
        send: (tx, on) => send(tx, on, async () => {}),
        tokens: async (mints) => (looked.push(mints), new Map()),
        now: () => NOW,
        settled: () => void settled.count++,
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
    return { me, pair, box, approvals, firsts, shownAt, sent, looked, outcomes, settled, transfer, call, shell };
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

test('Otus’s pages hear when a transaction it signed lands, sent by Otus or by the site; not when nothing landed', async () => {
    const sends = await wallet();
    result(await sends.call('signAndSendTransaction', { account: sends.me, transactions: [sends.transfer()] }));
    assert.equal(sends.settled.count, 1);
    await own(bytes(sends.transfer()), sends.me, key(2), sends.shell);
    assert.equal(sends.settled.count, 2);
    const signs = await wallet();
    result(await signs.call('signTransaction', { account: signs.me, transactions: [signs.transfer()] }));
    for (let i = 0; i < 20 && signs.settled.count < 1; i++) await new Promise((r) => setTimeout(r, 10));
    assert.equal(signs.settled.count, 1);
    // Refused by the network, expired, or never seen: nothing to read again.
    const refused = await wallet({ chain: { send: async () => { throw blockhashNotFound(); } } });
    await refused.call('signAndSendTransaction', { account: refused.me, transactions: [refused.transfer()] });
    let checks = 0;
    const late = await wallet({ chain: { status: async () => null, valid: async () => ++checks <= 2 } });
    await late.call('signAndSendTransaction', { account: late.me, transactions: [late.transfer()] });
    const unseen = await wallet({ chain: { status: async () => null } });
    unseen.shell.send = async () => ({ signature: key(10) as never, outcome: 'unknown', error: null });
    result(await unseen.call('signAndSendTransaction', { account: unseen.me, transactions: [unseen.transfer()] }));
    assert.deepEqual([refused.settled.count, late.settled.count, unseen.settled.count], [0, 0, 0]);
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
    assert.equal((await wallet({ validOn: [] })).approvals.length, 0);
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
    assert.deepEqual(shown.kind === 'transaction' && shown.guards, { held: false, text: '' }); // no guards, and nothing said of why
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

test('several transactions in one call are refused before any review', async () => {
    const w = await wallet();
    const reply = await w.call('signTransaction', { account: w.me, transactions: [w.transfer(), w.transfer()] });
    assert.equal(reply.ok, false);
    assert.equal(w.approvals.length, 0);
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
    assert.equal(result(await w.call('disconnect', {})), null);
    assert.deepEqual(w.box.state.sites, {});
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
        ['an account for a third token', swapFor(w.me, async (r) => void r.setup.push(getCreateAssociatedTokenIdempotentInstruction({ payer: me, ata: (await findAssociatedTokenPda({ owner: w.me, mint: key(37), tokenProgram: TOKEN_PROGRAM_ADDRESS }))[0], owner: w.me, mint: key(37) })))],
        ['a swap with its accounts cut short', swapFor(w.me, (r, a) => void (r.swap = { ...routeV2(w.me, a), accounts: routeV2(w.me, a).accounts.slice(0, 7) }))],
        ['Jupiter twice', swapFor(w.me, (r) => void r.setup.push(r.swap))],
        ['no swap', swapFor(w.me, (r) => void (r.swap = syncNative(key(36))))],
        ['a tip elsewhere', swapFor(w.me, () => {}, key(7))],
    ];
    for (const [what, made] of bent) assert.match(((await swapOwn(await made, w.me, ASKED, fast)) as { error: string }).error, /does more than swap/, what);
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
    assert.equal(landedFast.length, 2);
});

test('a swap Otus could not guard is refused before it can be approved', async () => {
    // The review's simulation goes well; the guarded one fails, so preparing leaves it unguarded.
    let simulations = 0;
    const base = { error: null, logs: [], fee: 5000n, unitsConsumed: null, loaded: null, inner: [], innerListed: true };
    const w = await wallet({ chain: { simulate: async (_tx, watch) => ({ ...base, after: watch.map((address) => ({ exists: false as const, address })), ...(++simulations > 1 && { error: { InstructionError: [9, { Custom: 1 }] } as never }) }) } });
    const reply = (await swapOwn(await swapFor(w.me), w.me, ASKED, w.shell)) as { error: string };
    assert.match(reply.error, /could not lock this swap/);
    assert.equal(w.sent.length, 0);
});
