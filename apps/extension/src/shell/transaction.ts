// A transaction's way from bytes to the signature: the cluster it lands on, its review with the checks of whoever
// asked, the transaction as prepared and what is known of its tokens (read meanwhile), the window's view and the
// user's answer; then the signature in its place, and the send, watched until it lands. Sites' requests and the
// popup's own transfers go the same way.
import {
    getBase58Decoder,
    getBase64Decoder,
    getTransactionDecoder,
    getTransactionEncoder,
    isSolanaError,
    SOLANA_ERROR__INSTRUCTION_ERROR__CUSTOM,
    SOLANA_ERROR__JSON_RPC__SERVER_ERROR_NODE_UNHEALTHY,
    SOLANA_ERROR__JSON_RPC__SERVER_ERROR_SEND_TRANSACTION_PREFLIGHT_FAILURE,
    SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR,
    SOLANA_ERROR__TRANSACTION_ERROR__ALREADY_PROCESSED,
    SOLANA_ERROR__TRANSACTION_ERROR__BLOCKHASH_NOT_FOUND,
    SOLANA_ERROR__TRANSACTION_ERROR__INSUFFICIENT_FUNDS_FOR_FEE,
    SOLANA_ERROR__TRANSACTION_ERROR__INSUFFICIENT_FUNDS_FOR_RENT,
    type Address,
    type Signature,
    type SignatureBytes,
} from '@solana/kit';

import { SYSTEM_PROGRAM_ADDRESS } from '@solana-program/system';

import type { Chain } from '@otus-wallet/sdk/chain';
import { toldByIdl, type IdlInstruction } from '@otus-wallet/sdk/idl/idl';
import type { Cluster } from '@otus-wallet/core/intake.ts';
import { Refused } from '@otus-wallet/core/protocol.ts';
import { LIGHTHOUSE } from '@otus-wallet/sdk/programs/addresses';
import { isMint, type Context } from '@otus-wallet/sdk/review/assess';
import { read, type State } from '@otus-wallet/sdk/review/changes';
import { decode, durable, encode, type Message } from '@otus-wallet/sdk/review/decode';
import { review, type Review } from '@otus-wallet/sdk/review/review';
import { notice, squadsTold, type Inside, type ProposalTold } from '@otus-wallet/sdk/review/squads';
import { SQUADS_V4 } from '@otus-wallet/sdk/programs/squads';
import { prepare, type Prepared } from '@otus-wallet/sdk/prepare/prepare';
import type { Sent } from '@otus-wallet/core/send/send.ts';
import { networkOf, rpcFor, type Settings } from '@otus-wallet/core/settings.ts';
import { accountView, describe, LEDGER_CLEAR, type Known, type Life, type Outcome, type Signer, type SiteView, type TransactionView } from '@otus-wallet/core/view.ts';
import type { Answer } from './approvals.ts';
import type { Shell } from './serve.ts';
import type { Account } from '@otus-wallet/core/state.ts';
import type { Kept } from '@otus-wallet/core/view/names.ts';

/** The user said no. */
export class Rejected extends Error {}

/** How Otus signs for the account: with its key, on its Ledger, or not at all (an address only watched). */
export function signerOf(a: Account): Signer {
    if (a.key) return 'ready';
    return a.ledger ? 'ledger' : 'none';
}

const GUESSES: Cluster[] = ['solana:mainnet', 'solana:devnet', 'solana:testnet'];

/** The cluster the transaction can land on, and the chain to it: the one whose recent blockhashes include its own or,
 *  for a durable one, whose nonce account holds its nonce. Reviewed on any other, it would show what it does where it
 *  cannot land. */
export async function clusterOf(bytes: Uint8Array, named: Cluster | null, settings: Settings, shell: Shell): Promise<{ cluster: Cluster; chain: Chain }> {
    const { message } = await decode(bytes);
    let failure: unknown = null;
    // A validator of your own (a local one) is guessed too, while it is the network the wallet shows.
    const guesses = networkOf(settings) === 'solana:localnet' ? [...GUESSES, 'solana:localnet' as const] : GUESSES;
    for (const cluster of named ? [named] : guesses) {
        try {
            const chain = shell.chain(rpcFor(cluster, settings));
            if (await landsOn(message, chain)) return { cluster, chain };
        } catch (e) {
            failure ??= e; // a network that did not answer may still be the one: say so, unless another is
        }
    }
    if (failure) throw failure;
    throw new Refused(named ? `this transaction is not for ${named.slice('solana:'.length)}` : 'this transaction is for no network Otus knows, or its blockhash expired');
}

async function landsOn(m: Message, chain: Chain): Promise<boolean> {
    if (!durable(m)) return chain.valid(m.lifetimeToken, 'processed');
    const at = m.instructions[0].accountIndices[0];
    if (at === undefined || at >= m.staticAccounts.length) return false; // the runtime wants the nonce account among the static ones
    const { accounts: [nonce] } = await chain.accounts([m.staticAccounts[at]]);
    // A nonce account: System's, 80 bytes; its version and state (4 bytes each, state 1: initialized), its authority
    // (32), then the nonce (32).
    return (
        nonce.exists &&
        nonce.programAddress === SYSTEM_PROGRAM_ADDRESS &&
        nonce.data.length === 80 &&
        [1, 0, 0, 0].every((b, i) => nonce.data[4 + i] === b) &&
        getBase58Decoder().decode(nonce.data.subarray(40, 72)) === m.lifetimeToken
    );
}

/** How a transaction is to be reviewed and shown: on which cluster and chain, for which site (or Otus itself), what
 *  the review needs to know of who asks, and whether the site sends it later itself. */
/** `blockhash`: for a transaction Otus built without one, the blockhash it gets, read while it is reviewed (a
 *  simulation takes any). */
/** `bare`: why Otus adds no guards, for what needs none (a transaction of its own that only takes access back). */
export type Way = { cluster: Cluster; chain: Chain; site: SiteView; recipient?: Address; later?: boolean; blockhash?: Promise<string>; bare?: string; trade?: bigint; context: Pick<Context, 'signedBefore' | 'programsBefore' | 'host' | 'own' | 'to'> };

/**
 * A transaction for this account → reviewed; refused by `checks` when whoever asked says so; shown as reviewed at once,
 * while it is prepared (guards, fees: two more simulations) and its programs' IDLs are read, then shown again as
 * prepared, the only form that can be approved; its blockhash watched meanwhile. Throws Rejected when the user says
 * no, or what went wrong preparing it; `ready` may refuse it as prepared, before it can be approved.
 */
export async function approved(bytes: Uint8Array, account: Account, way: Way, shell: Shell, checks: (r: Review) => void | Promise<void>, after?: (tell: (outcome: Outcome) => void) => void, ready?: (p: Prepared) => void): Promise<{ r: Review; p: Prepared; signature?: SignatureBytes }> {
    // A Ledger's Solana app misreads v1: shown all the same, so the user hears why it cannot be signed.
    const unsignable = account.ledger !== undefined && (await decode(bytes)).message.version === 1;
    // Yours, and the addresses you keep: what lands with them is not someone else's.
    const { accounts, contacts, sent, settings } = await shell.load();
    const yours = { wallets: accounts.map((a) => a.address), contacts: new Map(contacts.map((c) => [c.address, c.label])), sent: Object.keys(sent) as Address[] };
    const [reviewed, blockhash] = await Promise.all([review(bytes, { ...way.context, ...yours, wallet: account.address }, way.chain), way.blockhash]);
    const r = blockhash === undefined ? reviewed : await stamped(reviewed, blockhash);
    await notMainnet(r, way.cluster, settings, shell);
    await checks(r);
    // A Ledger shows a plain SOL transfer in clear, amount and recipient, where guards would leave it only a hash.
    const clear = way.context.own === true && account.ledger !== undefined && plainTransfer(r);
    const bare = clear ? LEDGER_CLEAR : way.bare;
    // Prepared and its IDLs read while it is shown as reviewed. Squads proposals first: their tokens are named with
    // the transaction's.
    const preparing = Promise.all([prepare(r, account.address, way.chain, way.context.own === true, bare, way.trade), idlTold(r, way.chain)]);
    preparing.catch(() => {}); // heard through `prepared`, below
    const known = await squadsIn(r, way.chain).then(async (squads) => ({ ...(await tokenInfo(r, way, shell, mintsInside(squads))), squads }));
    // A site's transaction tells nothing of its blockhash's age, and may come with little of its minute left (a Jupiter
    // order, about half): the network is asked instead, while the user decides.
    const away = way.cluster !== networkOf(settings); // for another network than the wallet shows: said in the window
    // Your wallets, watched ones too, and contacts, to tag; the addresses you sent to, to cut a copy apart from.
    const kept: Kept[] = [...accounts.map(({ address, label }) => ({ address, label, kind: 'wallet' as const })), ...contacts.map(({ address, label }) => ({ address, label, kind: 'contact' as const })), ...yours.sent.map((address) => ({ address, label: '', kind: 'sent' as const }))];
    const shown = { site: way.site, account: accountView(account), signer: signerOf(account), cluster: way.cluster, known, expiry: null, recipient: way.recipient, later: way.later, away, kept };
    const blocked = unsignable ? LEDGER_V1 : undefined;
    const prepared = preparing.then(([p, told]): { p: Prepared; approval: TransactionView } => {
        ready?.(p); // refused as prepared: the window says no before it can be approved
        const view = describe(r, p, { ...shown, known: { ...known, told } });
        // A Ledger signs in the window, on approval: it gets the very message to sign, and its signature comes back.
        const ledger = account.ledger && { path: account.ledger.path, message: getBase64Decoder().decode(messageOf(p.bytes)) };
        return { p, approval: { ...view, ...(ledger && !blocked && { ledger }), ...(blocked && { blocked }) } };
    });
    // What went wrong preparing it is heard first, before the window, which then says no: the request ends with it.
    let failed: { error: unknown } | null = null;
    prepared.catch((error: unknown) => (failed ??= { error }));
    const later = prepared.then((d) => d.approval);
    later.catch(() => {}); // a window that never opened never hears it
    const watch = durable(r.message) ? null : watched(r.message.lifetimeToken, way.chain, shell.now);
    let answer: Answer;
    try {
        answer = await shell.approve({ ...describe(r, null, shown), ...(blocked && { blocked }) }, watch?.follow, later, after);
    } finally {
        watch?.stop();
    }
    if (failed) throw (failed as { error: unknown }).error;
    if (!answer || (typeof answer === 'object' && 'account' in answer)) throw new Rejected(); // an account chosen answers a connect alone
    if (blocked) throw new Refused('a Ledger cannot sign version 1 transactions');
    // Approved: only the prepared form can be (the window and the popup take no yes before it).
    const { p } = await prepared;
    return { r, p, signature: answer === true ? undefined : answer };
}

const LEDGER_V1 = "A Ledger can't sign version 1 transactions yet: ask the site for an older one (v0).";

// The review of a transaction built before its blockhash came, with the blockhash in place: what it does is the same
// (its simulation replaced whatever blockhash it had), its bytes and hash are those of what will be signed.
async function stamped(r: Review, blockhash: string): Promise<Review> {
    const signatures = Object.fromEntries(r.signers.map((a) => [a, null]));
    const bytes = new Uint8Array(getTransactionEncoder().encode({ messageBytes: encode({ ...r.message, lifetimeToken: blockhash }), signatures }));
    return { ...r, ...(await decode(bytes)) };
}
const WATCH_EVERY = 2_000; // ms between asking the network about the blockhash
const LISTED = 150; // blocks a blockhash stays among the recent ones; it can land about as long (measured)
const FAST = 6; // blocks a second assumed when the network does not say: more than it makes (5, at 200 ms), so the time is short of real

// Its blockhash's life, asked of the network until it ends: where it stands among the recent blockhashes (one place a
// block), at the network's pace, gives about when it ends; once off the list, the network says whether it is gone.
// `follow` hears each change, the last one at once; `stop` ends the watch.
function watched(blockhash: string, chain: Chain, now: () => number): { follow: (tell: (life: Life) => void) => void; stop: () => void } {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    let last: Life | null = null;
    const listeners = new Set<(life: Life) => void>();
    const tell = (life: Life) => {
        const moved = !last || 'expired' in life || 'expired' in last || Math.abs(life.until - last.until) > 500;
        last = life;
        if (moved) listeners.forEach((l) => l(life));
    };
    const pace = chain.blockRate().then((rate) => (rate > 0 ? rate : FAST), () => FAST);
    const check = async () => {
        const age = await chain.age(blockhash).catch(() => undefined); // undefined: no answer this time
        if (age === null) {
            const valid = await chain.valid(blockhash, 'processed').catch(() => true);
            if (stopped) return;
            if (!valid) return tell({ expired: true });
            tell({ until: now() }); // off the list, still landing: a block or two left
        } else if (age !== undefined) {
            const until = now() + (Math.max(0, LISTED - age) / (await pace)) * 1000;
            if (stopped) return;
            tell({ until });
        }
        if (!stopped) timer = setTimeout(() => void check(), WATCH_EVERY);
    };
    void check();
    const follow = (listener: (life: Life) => void) => {
        listeners.add(listener);
        if (last) listener(last);
    };
    const stop = () => {
        stopped = true;
        clearTimeout(timer);
        listeners.clear();
    };
    return { follow, stop };
}

// One System transfer and nothing else, as Send makes it: the transfer's index (2) and the amount, u64.
function plainTransfer(r: Review): boolean {
    const [ix, ...rest] = r.message.instructions;
    if (!ix || rest.length > 0 || r.accounts[ix.programAddressIndex].address !== SYSTEM_PROGRAM_ADDRESS) return false;
    return ix.data.length === 12 && ix.data[0] === 2 && ix.data[1] === 0 && ix.data[2] === 0 && ix.data[3] === 0;
}

/** What one side tells and another follows from whenever it starts: the last thing said at once, then each new one. */
export function channel<T>(): { tell: (value: T) => void; follow: (listener: (value: T) => void) => void } {
    let last: { value: T } | null = null;
    let listener: ((value: T) => void) | null = null;
    return {
        tell: (value) => ((last = { value }), listener?.(value)),
        follow: (l) => ((listener = l), last && l(last.value)),
    };
}

const FOLLOW_EVERY = 2_000; // ms between asking the network about a transaction someone else sends
const FOLLOW_MOST = 120_000; // ms it is followed at most: past its blockhash's life
const FOLLOW_DURABLE = 180_000; // ms one on a durable nonce is followed, as it can be sent at any time

/** A signed transaction someone else sends, followed by its id until it lands, or can no longer: its blockhash expired
 *  without it, as the network said with its last answers; or, after a while (longer on a durable nonce), not seen. A
 *  read that fails proves nothing: it never says expired. */
export async function followed(id: Signature, r: Review, chain: Chain): Promise<{ failed: boolean } | { expired: boolean }> {
    const lasting = durable(r.message);
    const until = Date.now() + (lasting ? FOLLOW_DURABLE : FOLLOW_MOST);
    const status = () => chain.status(id).catch(() => undefined); // undefined: no answer
    for (;;) {
        const s = await status();
        if (s?.confirmed) return { failed: s.error !== null };
        if (!lasting && s !== undefined && (await chain.valid(r.message.lifetimeToken).catch(() => true)) === false) {
            const last = await status();
            if (last?.confirmed) return { failed: last.error !== null };
            return { expired: last === null };
        }
        if (Date.now() > until) return { expired: false };
        await new Promise((done) => setTimeout(done, FOLLOW_EVERY));
    }
}

/** Refuses a transaction for another network than mainnet that would land on mainnet all the same. An endpoint of your
 *  own says which network it serves, and could say devnet while it passes everything to mainnet: Otus's own mainnet
 *  RPC is asked whether it knows the transaction's blockhash (or holds its nonce). A real devnet one is unknown there.
 *  Solana's public endpoints are taken at their word. */
export async function notMainnet(r: Review, cluster: Cluster, settings: Settings, shell: Shell) {
    if (cluster === 'solana:mainnet' || rpcFor(cluster, settings) !== settings.rpc) return;
    const mainnet = shell.chain(rpcFor('solana:mainnet', { ...settings, network: 'mainnet' }));
    const lands = await landsOn(r.message, mainnet).catch(() => null);
    if (lands === null) throw new Refused("Otus couldn't check that this transaction is not for mainnet: try again");
    if (lands) throw new Refused(`your RPC says it serves ${cluster.slice('solana:'.length)}, but this transaction is for mainnet`);
}

/** Refuses a transaction no block can take any more: one read for longer than its blockhash lives would not land. */
export async function unexpired(r: Review, chain: Chain) {
    if (durable(r.message)) return;
    if (!(await chain.valid(r.message.lifetimeToken).catch(() => true))) throw new Refused('it expired before you signed it, so nothing was sent');
}

/** The bytes a signature covers. */
export const messageOf = (bytes: Uint8Array) => new Uint8Array(getTransactionDecoder().decode(bytes).messageBytes);

/** The transaction with this account's signature in its place. */
export function withSignature(bytes: Uint8Array, address: Address, signature: SignatureBytes): Uint8Array {
    const tx = getTransactionDecoder().decode(bytes);
    return new Uint8Array(getTransactionEncoder().encode({ ...tx, signatures: { ...tx.signatures, [address]: signature } }));
}

/** Sent and watched until it lands, even to fail onchain, which Otus's pages hear (as they do when it is not seen yet:
 *  it may land in a moment); one the network refuses, or that can no longer land, is refused in words. */
export async function landed(signed: Uint8Array, chain: Chain, shell: Shell): Promise<Sent> {
    const s = await shell.send(signed, chain).catch((e: unknown) => {
        throw new Refused(refusal(e));
    });
    if (s.outcome === 'expired') throw new Refused('it expired before it landed, so nothing was sent');
    settled(shell);
    return s;
}

/** Tells Otus's pages a transaction it signed went out, to read again what it changed: telling them never changes how
 *  it went. */
export function settled(shell: Pick<Shell, 'settled'>) {
    try {
        shell.settled?.();
    } catch (e) {
        console.error('Otus: telling pages', e);
    }
}

// Why the RPC refused to send a transaction, in words: kit's errors carry only a code in this build. A preflight is
// the RPC's own simulation, with the real blockhash and the state as it is then.
function refusal(e: unknown): string {
    const line = (x: unknown) => (x instanceof Error ? x.message.split(/[\n;]/)[0].slice(0, 160) : String(x));
    if (isSolanaError(e, SOLANA_ERROR__JSON_RPC__SERVER_ERROR_SEND_TRANSACTION_PREFLIGHT_FAILURE)) {
        const cause = e.cause;
        if (isSolanaError(cause, SOLANA_ERROR__TRANSACTION_ERROR__BLOCKHASH_NOT_FOUND)) return 'it expired before it was sent, so nothing was sent';
        if (isSolanaError(cause, SOLANA_ERROR__TRANSACTION_ERROR__ALREADY_PROCESSED)) return 'the network has it already';
        if (isSolanaError(cause, SOLANA_ERROR__TRANSACTION_ERROR__INSUFFICIENT_FUNDS_FOR_FEE)) return 'there is not enough SOL for the fee, so nothing was sent';
        if (isSolanaError(cause, SOLANA_ERROR__TRANSACTION_ERROR__INSUFFICIENT_FUNDS_FOR_RENT)) return 'an account would be left without its rent, so nothing was sent';
        if ((e.context.logs ?? []).some((l) => l.includes(`${LIGHTHOUSE} failed`))) return 'a guard stopped it: what it does changed since your review, so nothing was sent';
        if (isSolanaError(cause, SOLANA_ERROR__INSTRUCTION_ERROR__CUSTOM)) return `instruction ${cause.context.index + 1} would fail (error ${cause.context.code}), so nothing was sent`;
        return `the network's check failed (${line(cause ?? e)}), so nothing was sent`;
    }
    if (isSolanaError(e, SOLANA_ERROR__JSON_RPC__SERVER_ERROR_NODE_UNHEALTHY)) return 'your RPC is behind the network, so nothing was sent';
    if (isSolanaError(e, SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR)) return `the RPC refused it (HTTP ${e.context.statusCode}), so nothing was sent`;
    return `the RPC refused it (${line(e)}), so nothing was sent`;
}

const IDL_WAIT = 3_000; // ms the review waits for IDLs, which only add words to it
const SQUADS_WAIT = 6_000; // ms it waits to read Squads proposals: without them, what a proposal does goes unsaid

// The Squads proposals the transaction acts on. When the chain does not answer in time, or reading fails, that is said:
// what a proposal does never goes unsaid in silence.
function squadsIn(r: Review, chain: Chain): Promise<ProposalTold[]> {
    const first = r.message.instructions.findIndex((ix) => r.accounts[ix.programAddressIndex].address === SQUADS_V4);
    if (first < 0) return Promise.resolve([]);
    const failed = [notice(first, 'time')];
    return Promise.race([squadsTold(r, chain).catch(() => failed), new Promise<ProposalTold[]>((done) => setTimeout(() => done(failed), SQUADS_WAIT))]);
}

const MAX_INSIDE_MINTS = 32; // tokens of proposals named; their names are only words

// The mints what the proposals would move: of their token accounts, spent with a spending limit, or limited by one.
function mintsInside(squads: ProposalTold[]): Address[] {
    const of = (inside: Inside): Address[] => {
        if (inside.kind === 'vault') return inside.accounts.flatMap((a) => (a.token ? [a.token.mint] : []));
        if (inside.kind === 'batch') return inside.runs.flatMap(of);
        if (inside.kind === 'spend' && inside.mint) return [inside.mint];
        if (inside.kind === 'config') return inside.actions.flatMap((a) => (a.kind === 'addSpendingLimit' ? [a.mint] : []));
        return [];
    };
    return [...new Set(squads.flatMap(({ inside }) => of(inside)))].slice(0, MAX_INSIDE_MINTS);
}

// The instructions no plugin reads, as their programs' IDLs tell them. Never fails the review, nor holds it up: without
// them, those instructions show as unknown.
function idlTold(r: Review, chain: Chain): Promise<Map<number, IdlInstruction>> {
    const none = new Map<number, IdlInstruction>();
    return Promise.race([toldByIdl(r, chain).catch(() => none), new Promise<typeof none>((done) => setTimeout(() => done(none), IDL_WAIT))]);
}

// What the window needs of the transaction's tokens: their decimals and, on mainnet, their names and prices (on
// another cluster the same addresses are other tokens). Never fails the review: without them, amounts show as units.
async function tokenInfo(r: Review, way: Way, shell: Shell, more: Address[] = []): Promise<Known> {
    const mints = [...new Set([...mintsOf(r), ...more])];
    const [decimals, tokens] = await Promise.all([decimalsOf(r, mints, way.chain), way.cluster === 'solana:mainnet' ? shell.tokens(mints) : Promise.resolve(new Map())]);
    return { tokens, decimals };
}

// Every mint the transaction moves or names: of the token accounts it writes, and the mints among its accounts.
function mintsOf(r: Review): Address[] {
    const written = r.changes.accounts.flatMap((c) => [c.before?.token?.mint, c.after?.token?.mint]);
    const named = [...r.assessment.kinds].filter(([, kind]) => kind === 'mints').map(([a]) => a);
    return [...new Set([...written, ...named].filter((m) => m !== undefined))];
}

// A mint keeps its decimals at byte 44, after its mint authority and supply, and its "initialized" flag at 45; once
// initialized, it never changes them. Each mint as the transaction leaves it when it writes it (it may initialize it),
// else as the review loaded it, else asked for.
export async function decimalsOf(r: Review, mints: Address[], chain: Chain): Promise<Map<string, number>> {
    const written = new Map(r.changes.accounts.map((c) => [c.address, c.after]));
    const loaded = new Map(r.accounts.map((a) => [a.address, a.state]));
    const decimals = new Map<string, number>();
    const add = (mint: Address, s: State) => s && isMint(s) && s.data[45] === 1 && decimals.set(mint, s.data[44]);
    const missing: Address[] = [];
    for (const m of mints) {
        const state = written.has(m) ? written.get(m)! : loaded.get(m)?.exists ? read(loaded.get(m)!) : undefined;
        if (state === undefined) missing.push(m);
        else add(m, state);
    }
    const { accounts } = missing.length ? await chain.accounts(missing).catch(() => ({ accounts: [] })) : { accounts: [] };
    for (const a of accounts) if (a.exists) add(a.address, read(a));
    return decimals;
}
