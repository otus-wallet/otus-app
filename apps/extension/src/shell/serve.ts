// What the background answers: sites' requests, and the transfers made in Otus's own popup, and what it makes there to
// take access back. Each is checked, shown to the user and, once approved, signed with state as it is then. A reply
// never throws.
import {
    createAddressWithSeed,
    getBase58Decoder,
    getBase64Decoder,
    getPublicKeyFromAddress,
    getTransactionDecoder,
    isAddress,
    isSolanaError,
    SOLANA_ERROR__JSON_RPC__INTERNAL_ERROR,
    SOLANA_ERROR__JSON_RPC__SERVER_ERROR_MIN_CONTEXT_SLOT_NOT_REACHED,
    SOLANA_ERROR__JSON_RPC__SERVER_ERROR_NODE_UNHEALTHY,
    SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR,
    verifySignature,
    type Address,
    type Signature,
    type SignatureBytes,
} from '@solana/kit';

import { COMPUTE_BUDGET_PROGRAM_ADDRESS } from '@solana-program/compute-budget';
import { STAKE_PROGRAM_ADDRESS } from '@solana-program/stake';
import { SYSTEM_PROGRAM_ADDRESS } from '@solana-program/system';
import { ASSOCIATED_TOKEN_PROGRAM_ADDRESS, findAssociatedTokenPda, TOKEN_PROGRAM_ADDRESS } from '@solana-program/token';

import type { Chain, Tables } from '@otus-wallet/sdk/chain';
import { gate } from '../gate.ts';
import { intake, type Cluster, type Request } from '@otus-wallet/core/intake.ts';
import { NO_KEY, Refused, type Reply } from '@otus-wallet/core/protocol.ts';
import { cap } from '@otus-wallet/sdk/format';
import { decode } from '@otus-wallet/sdk/review/decode';
import { siteFindings } from '@otus-wallet/sdk/review/assess';
import { messageFindings } from '@otus-wallet/sdk/review/message';
import { NOTHING_TO_HOLD, SIMULATION_FAILED, type Prepared } from '@otus-wallet/sdk/prepare/prepare';
import type { Review } from '@otus-wallet/sdk/review/review';
import { programsCalled } from '@otus-wallet/sdk/review/sites';
import { delegatesGiven, waitingOn } from '@otus-wallet/sdk/access/access';
import { isTokenProgram, WSOL } from '@otus-wallet/sdk/programs/addresses';
import { timedOut } from '@otus-wallet/sdk/rpc';
import type { Sent } from '@otus-wallet/core/send/send.ts';
import { STAKE_SPACE } from '@otus-wallet/core/send/stake.ts';
import { SENDER_TIPS, TIP } from '@otus-wallet/core/swap/build.ts';
import { JUPITER } from '@otus-wallet/core/swap/route.ts';
import { termsOf, throughOwn, type Asked } from '@otus-wallet/core/swap/terms.ts';
import { explorerOf, networkOf, OTUS_RPC, rpcFor } from '@otus-wallet/core/settings.ts';
import { signInFields, signInText } from '../siws.ts';
import type { TokenInfo } from '@otus-wallet/core/tokens.ts';
import { accountView, siteView, type Approval, type Life, type Line, type Outcome, type SiteView } from '@otus-wallet/core/view.ts';
import type { Answer, Early } from './approvals.ts';
import { connectSite, disconnectSite, MAX_SIGNED_HERE, onDevice, sentTo, signs, type Account, type State } from '@otus-wallet/core/state.ts';
import { approved, approvedAll, channel, clusterOf, followed, landed, messageOf, Rejected, settled, signerOf, unexpired, withSignature } from './transaction.ts';

/** What serve needs from the extension: its state, the user's answer (behind Otus's lock), the keystore, the network
 *  and the time. Tests pass fakes. */
export type Shell = {
    load(): Promise<State>;
    update(change: (state: State) => Partial<State> | null): Promise<void>; // one after another, from state as it is then
    approve(approval: Approval, follow?: (tell: (life: Life) => void) => void, later?: Promise<Approval>, after?: (tell: (outcome: Outcome) => void) => void): Promise<Answer>; // yes or no (for a Ledger account, yes is its signature; to connect, yes may name another account); `follow`: its blockhash's life, for the window to show; `later`: the approval in its final form, which replaces the first and alone takes a yes (failing, it says no); `after`: approved, the window hears how it goes
    early?(first: Approval): Early; // the window opened at once, showing `first` until its approve gives it what to answer (see approvals.ts)
    sign(account: Account, data: Uint8Array): Promise<SignatureBytes>; // throws Refused when locked or without the key
    chain(rpc: string): Chain;
    send(signed: Uint8Array, chain: Chain): Promise<Sent>; // sent, then watched until it lands or cannot
    tokens(mints: string[]): Promise<Map<string, TokenInfo | null>>; // names and prices, from Jupiter
    now(): number; // ms since 1970
    fast?(chain: Chain): Chain; // the chain a swap lands through: Helius Sender's, by Otus's server; without it, the chain itself
    tables?: Tables; // mainnet's lookup tables, kept: read again only past what they held
    warm?(): void; // the wallet's network reached ahead, for a site's first request to find the connection open
    settled?(): void; // a transaction Otus signed landed, failed onchain, or went out unseen yet: Otus's pages read again what it changed
};

const NOT_CONNECTED = 'this site is not connected to that account';
const LEDGER_MESSAGES = 'a Ledger account signs transactions only, not messages';
const NO_ACCOUNT = 'there is no account in Otus yet';
const NO_SIGNER = 'no account in Otus can sign: a watched one cannot connect';
// A transfer made in the popup has no site: this stands for one in its review.
const OWN_SITE: SiteView = { origin: 'otus://popup', host: 'Otus', note: 'Your own transfer', tone: 'plain' };
const TAKING_BACK: SiteView = { origin: 'otus://popup', host: 'Otus', note: 'Taking access back', tone: 'plain' };
const STAKING: SiteView = { origin: 'otus://popup', host: 'Otus', note: 'Your own stake', tone: 'plain' };
const SWAPPING: SiteView = { origin: 'otus://popup', host: 'Otus', note: 'Your own swap', tone: 'plain' };

/** A site's call and the origin the browser gave → the reply for the site. */
export function serve(call: unknown, origin: string, shell: Shell): Promise<Reply> {
    return reply(
        async () => {
            const request = intake(call, origin);
            const state = await shell.load();
            return handle(gate(request), state, shell);
        },
        { rejected: 'The user rejected the request', failed: 'Otus could not handle this request' },
    );
}

async function handle(request: Request, state: State, shell: Shell): Promise<unknown> {
    const { origin } = request;
    const approve = async (approval: Approval) => {
        if ((await shell.approve(approval)) !== true) throw new Rejected();
    };
    switch (request.kind) {
        case 'connect': {
            // `v1`: whether the account can sign v1 transactions, for the site to build what it can (a Ledger cannot).
            const site = state.sites[origin];
            const known = site && accountOf(state, site.account);
            if (known) shell.warm?.(); // its page opened: a request may follow
            if (known) return { accounts: [known.address], v1: !known.ledger };
            if (request.silent) throw new Refused('not connected');
            // The account in use, or another of yours chosen in the window, which is then the one in use: one that signs, as
            // a watched account cannot, so a site has no use for it.
            const active = need(accountOf(state, state.active), NO_ACCOUNT);
            const choices = state.accounts.filter(signs);
            if (!choices.length) throw new Refused(NO_SIGNER);
            const findings = siteLines(origin, state, shell);
            const answer = await shell.approve({ kind: 'connect', site: siteView(origin, undefined), account: accountView(active), choices: choices.map(accountView), findings });
            if (answer !== true && !(typeof answer === 'object' && 'account' in answer)) throw new Rejected();
            const account = need(choices.find((c) => c.address === (answer === true ? active.address : answer.account)), NO_SIGNER);
            // As they are now: the user may have changed them while deciding, removed that account even.
            let removed = false;
            await shell.update((s) => (s.accounts.some((a) => a.address === account.address && signs(a)) ? { ...connectSite(s, origin, account.address), active: account.address } : ((removed = true), null)));
            if (removed) throw new Refused(NO_SIGNER);
            return { accounts: [account.address], v1: !account.ledger };
        }
        case 'disconnect': {
            await shell.update((s) => disconnectSite(s, origin));
            return null;
        }
        case 'transaction': {
            const { account, site } = connected(state, origin, request.account);
            const list = request.transactions; // at most MAX_BATCH: the gate says so
            // What the bytes alone refuse, refused before any network work; and one at a time from a site, which
            // could otherwise spend the user's RPC on reviews no window ever shows.
            for (const [i, bytes] of list.entries()) {
                const which = list.length > 1 ? `transaction ${i + 1} of ${list.length}: ` : '';
                const { signers, signed } = await decode(bytes);
                if (!signers.includes(account.address)) throw new Refused(`${which}this wallet does not sign this transaction`);
                if (request.send && signers.some((s) => s !== account.address && !signed.includes(s))) throw new Refused(`${which}another signature is missing, so it cannot be sent`);
            }
            return list.length > 1 ? transactAll(request, account, site, state, shell) : transact(request, list[0], account, site, state, shell);
        }
        case 'message': {
            const { account, site } = connected(state, origin, request.account);
            // Asked like any other, so a site learns nothing from it; the window says a Ledger cannot sign it.
            const findings = messageFindings(request.message).map((f) => ({ title: f.text, note: f.note ?? '', tone: f.level }));
            await approve({ kind: 'message', site: siteView(origin, site), account: accountView(account), text: readable(request.message), findings, signer: signerOf(account) });
            if (account.ledger) throw new Refused(LEDGER_MESSAGES);
            const signature = await signFor(account, request.message, shell, { origin }, undefined, false);
            return { signedMessage: base64(request.message), signature: base64(signature) };
        }
        case 'signIn': {
            // A site connected to an account signs in with it; any other gets the account in use, whatever address it
            // names: refusing an address Otus does not hold would tell the site which ones it does.
            const site = state.sites[origin];
            const account = need(accountOf(state, site?.account ?? null) ?? accountOf(state, state.active), NO_ACCOUNT);
            if (site && request.input.address !== undefined && request.input.address !== account.address) throw new Refused('that account is not connected to this site');
            const input = { ...request.input, domain: new URL(origin).host, address: account.address };
            const findings = site ? [] : siteLines(origin, state, shell); // signing in connects it
            await approve({ kind: 'signIn', site: siteView(origin, site), account: accountView(account), fields: signInFields(input), findings, signer: signerOf(account) });
            if (account.ledger) throw new Refused(LEDGER_MESSAGES);
            const message = new TextEncoder().encode(signInText(input));
            const signature = await signFor(account, message, shell, { origin, connects: true }, undefined, false);
            return { account: account.address, signedMessage: base64(message), signature: base64(signature) };
        }
    }
}

const reviewing = new Set<string>(); // sites whose transaction is being reviewed or decided

// A transaction for another cluster than the one guessed, and which it is.
class Elsewhere extends Error {
    found: { cluster: Cluster; chain: Chain };
    constructor(found: { cluster: Cluster; chain: Chain }) {
        super(`the transaction is for ${found.cluster}`);
        this.found = found;
    }
}

// What is known of a site asked to connect: from its host, and from what was kept of it when it was disconnected.
const siteLines = (origin: string, state: State, shell: Shell): Line[] =>
    siteFindings({ host: new URL(origin).host, signedBefore: state.disconnected.find((d) => d.origin === origin)?.since ?? null, now: Math.floor(shell.now() / 1000) }, true).map((f) => ({ title: f.text, note: f.note ?? '', tone: f.level }));

// A site's transaction, checked: its cluster, the review and the user's answer, one at a time per site; then signed,
// and sent if asked.
async function transact(request: Extract<Request, { kind: 'transaction' }>, bytes: Uint8Array, account: Account, site: State['sites'][string], state: State, shell: Shell): Promise<unknown> {
    const { origin } = request;
    if (reviewing.has(origin)) throw new Refused('Otus is already asking you about a request from this site');
    reviewing.add(origin);
    let decided: { r: Review; p: Prepared; signature?: SignatureBytes; chain: Chain; cluster: Cluster };
    const outcome = channel<Outcome>(); // approved, the window stays and says how it goes
    // The window opens at once, saying who asks for which account, while the transaction is reviewed.
    let window: Early | undefined;
    try {
        window = shell.early?.({ kind: 'pending', site: siteView(origin, site), account: accountView(account) });
        const asking = window ? { ...shell, approve: window.approve } : shell;
        const reviewed = (cluster: Cluster, chain: Chain, confirmed?: Promise<unknown>) => {
            const way = { cluster, chain, site: siteView(origin, site), later: !request.send, confirmed, kept: state, context: { signedBefore: site.since ?? null, programsBefore: site.programs, host: new URL(origin).host } };
            return approved(bytes, account, way, asking, () => {}, outcome.follow).then((d) => ({ ...d, chain, cluster }));
        };
        // Reviewed on the network the site names, or the wallet shows, while that is checked to be the transaction's;
        // on the one it is, when it is another. Only where it goes anyway: the network named, or the wallet's own
        // endpoint (Otus's server, or yours); not a public one the transaction may not be for.
        const guess = request.chain ?? networkOf(state.settings);
        const chain = shell.chain(rpcFor(guess, state.settings));
        const checked = clusterOf(bytes, request.chain, state.settings, shell);
        const ahead = request.chain !== null || [OTUS_RPC, state.settings.rpc].includes(rpcFor(guess, state.settings));
        const deciding = ahead
            ? reviewed(guess, chain, checked.then((found) => found.cluster === guess || Promise.reject(new Elsewhere(found)))).catch((e: unknown) => {
                  if (!(e instanceof Elsewhere)) throw e;
                  return reviewed(e.found.cluster, e.found.chain);
              })
            : checked.then((found) => reviewed(found.cluster, found.chain));
        // A no while it is reviewed ends the request at once: the review is left to end on its own.
        deciding.catch(() => {});
        decided = await (window ? Promise.race([deciding, window.no.then(() => Promise.reject(new Rejected()))]) : deciding);
    } catch (e) {
        window?.close(e instanceof Rejected ? undefined : (told(e) ?? 'Otus could not handle this request')); // ended before the user answered: the window says why, or goes on a no
        throw e;
    } finally {
        reviewing.delete(origin);
    }
    const { r, p, signature, chain, cluster } = decided;
    const host = new URL(origin).host;
    const link = (id: string) => explorerOf(state.settings, cluster).tx(id);
    try {
        // Signed on a Ledger right as its blockhash ran out, it goes to the network all the same:
        // it may still land, and if not the network says so. Otus's own key doesn't sign what can no longer land.
        if (!(signature && onDevice(account))) await unexpired(r, chain);
        const mine = await signFor(account, messageOf(p.bytes), shell, { origin, programs: programsCalled(r.message) }, signature);
        await shell.update((s) => usable(s, r, account.address, host, shell.now())).catch(() => {}); // keeping them never changes the signing
        const signed = withSignature(p.bytes, account.address, mine);
        if (request.send) {
            outcome.tell({ phase: 'sending' });
            const sent = await landed(signed, chain, shell);
            outcome.tell(sent.outcome === 'confirmed' || sent.outcome === 'failed' ? { phase: 'landed', failed: sent.outcome === 'failed', link: link(sent.signature) } : { phase: 'unseen', expired: false, link: link(sent.signature) });
            return { signatures: [sent.signature] };
        }
        // The site sends it: Otus follows it by its id, the fee payer's signature, only when that is this account's
        // own. Another payer's, the site's to give, could be any bytes while the transaction lands under the real one.
        const id = r.signers[0] === account.address ? idOf(signed, account.address) : null;
        if (!id) outcome.tell({ phase: 'signed', host });
        else {
            outcome.tell({ phase: 'waiting', host, link: link(id) });
            void followed(id, r, chain).then((f) => {
                outcome.tell('failed' in f ? { phase: 'landed', failed: f.failed, link: link(id) } : { phase: 'unseen', expired: f.expired, link: link(id) });
                if ('failed' in f) settled(shell);
            });
        }
        return { transactions: [base64(signed)] };
    } catch (e) {
        outcome.tell({ phase: 'refused', error: e instanceof Refused ? cap(e.message) : 'Otus could not finish it' });
        throw e;
    }
}

// Several transactions of a site's, asked together: checked as one is, on the one network they are for, reviewed and
// approved together (all or none), then signed in their order. Sent, when asked, in that order too, each once the one
// before it landed, so one that needs another finds it there; one that fails or isn't seen landing stops the rest.
async function transactAll(request: Extract<Request, { kind: 'transaction' }>, account: Account, site: State['sites'][string], state: State, shell: Shell): Promise<unknown> {
    const { origin } = request;
    const list = request.transactions;
    if (reviewing.has(origin)) throw new Refused('Otus is already asking you about a request from this site');
    reviewing.add(origin);
    let decided: { items: { r: Review; p: Prepared }[]; signatures?: SignatureBytes[]; chain: Chain; cluster: Cluster };
    const outcome = channel<Outcome>();
    let window: Early | undefined;
    try {
        window = shell.early?.({ kind: 'pending', site: siteView(origin, site), account: accountView(account) });
        const asking = window ? { ...shell, approve: window.approve } : shell;
        const reviewed = (cluster: Cluster, chain: Chain, confirmed?: Promise<unknown>) => {
            const way = { cluster, chain, site: siteView(origin, site), later: !request.send, confirmed, kept: state, context: { signedBefore: site.since ?? null, programsBefore: site.programs, host: new URL(origin).host } };
            return approvedAll(list, account, way, asking, () => {}, outcome.follow).then((d) => ({ ...d, chain, cluster }));
        };
        // As for one: reviewed where the site says, or the wallet shows, while that is checked; elsewhere if not.
        const guess = request.chain ?? networkOf(state.settings);
        const chain = shell.chain(rpcFor(guess, state.settings));
        const checked = oneCluster(list, request.chain, state.settings, shell);
        const ahead = request.chain !== null || [OTUS_RPC, state.settings.rpc].includes(rpcFor(guess, state.settings));
        const deciding = ahead
            ? reviewed(guess, chain, checked.then((found) => found.cluster === guess || Promise.reject(new Elsewhere(found)))).catch((e: unknown) => {
                  if (!(e instanceof Elsewhere)) throw e;
                  return reviewed(e.found.cluster, e.found.chain);
              })
            : checked.then((found) => reviewed(found.cluster, found.chain));
        deciding.catch(() => {});
        decided = await (window ? Promise.race([deciding, window.no.then(() => Promise.reject(new Rejected()))]) : deciding);
    } catch (e) {
        window?.close(e instanceof Rejected ? undefined : (told(e) ?? 'Otus could not handle this request'));
        throw e;
    } finally {
        reviewing.delete(origin);
    }
    const { items, signatures, chain, cluster } = decided;
    const host = new URL(origin).host;
    const link = (id: string) => explorerOf(state.settings, cluster).tx(id);
    const of = items.length;
    try {
        const signed: Uint8Array[] = [];
        for (const [i, { r, p }] of items.entries()) {
            const which = `transaction ${i + 1} of ${of}`;
            if (!(signatures && onDevice(account))) await unexpired(r, chain).catch((e: unknown) => Promise.reject(e instanceof Refused ? new Refused(`${which}: ${e.message}`) : e));
            const mine = await signFor(account, messageOf(p.bytes), shell, { origin, programs: programsCalled(r.message) }, signatures?.[i]);
            await shell.update((s) => usable(s, r, account.address, host, shell.now())).catch(() => {});
            signed.push(withSignature(p.bytes, account.address, mine));
        }
        if (!request.send) {
            outcome.tell({ phase: 'signed', host });
            return { transactions: signed.map(base64) };
        }
        outcome.tell({ phase: 'sending' });
        const ids: Signature[] = [];
        for (const [i, tx] of signed.entries()) {
            const which = `transaction ${i + 1} of ${of}`;
            const before = i === 0 ? '' : `; the ${i === 1 ? 'one' : i} before it landed`;
            const sent = await landed(tx, chain, shell).catch((e: unknown) => Promise.reject(e instanceof Refused ? new Refused(`${which}: ${e.message}${before}`) : e));
            ids.push(sent.signature);
            if (sent.outcome === 'confirmed') continue;
            outcome.tell(sent.outcome === 'failed' ? { phase: 'landed', failed: true, link: link(sent.signature) } : { phase: 'unseen', expired: false, link: link(sent.signature) });
            throw new Refused(`${which} ${sent.outcome === 'failed' ? 'failed onchain' : "wasn't seen landing"}, so Otus sent none after it`);
        }
        outcome.tell({ phase: 'landed', failed: false, link: link(ids[ids.length - 1]) });
        return { signatures: ids };
    } catch (e) {
        outcome.tell({ phase: 'refused', error: e instanceof Refused ? cap(e.message) : 'Otus could not finish it' });
        throw e;
    }
}

// The one network transactions asked together are for: each blockhash (or nonce) checked once; several are refused.
async function oneCluster(list: Uint8Array[], named: Cluster | null, settings: State['settings'], shell: Shell): Promise<{ cluster: Cluster; chain: Chain }> {
    const firsts = new Map<string, Uint8Array>();
    for (const bytes of list) {
        const { message } = await decode(bytes);
        if (!firsts.has(message.lifetimeToken)) firsts.set(message.lifetimeToken, bytes);
    }
    const found = await Promise.all([...firsts.values()].map((b) => clusterOf(b, named, settings, shell)));
    if (found.some((f) => f.cluster !== found[0].cluster)) throw new Refused('the transactions are for different networks');
    return found[0];
}

// A transaction's id: its fee payer's signature, once there; null while that account has not signed yet.
function idOf(signed: Uint8Array, payer: Address): Signature | null {
    const signature = getTransactionDecoder().decode(signed).signatures[payer];
    return signature ? (getBase58Decoder().decode(signature) as Signature) : null;
}

/** A transfer the popup made for one of your accounts to the address typed → reviewed and approved like a site's,
 *  with that address shown whole, then signed and sent on the network the wallet shows; `signed` hears the signature
 *  before it is sent. It is that account's alone to sign. The reply says whether it landed or failed onchain. */
export function own(bytes: Uint8Array, address: string, to: string, shell: Shell, signed?: (signature: Signature) => Promise<unknown>): Promise<Reply> {
    return reply(
        async () => {
            const state = await shell.load();
            const account = accountOf(state, address);
            if (!account || !signs(account)) throw new Refused(NO_KEY);
            if (!isAddress(to)) throw new Refused('that is not a Solana address');
            const cluster = networkOf(state.settings); // the network the wallet shows
            const chain = shell.chain(rpcFor(cluster, state.settings));
            // Built in the popup without a blockhash: it comes from the network while the transfer is reviewed.
            const way = { cluster, chain, site: OWN_SITE, recipient: to, blockhash: chain.latest(), context: { signedBefore: null, own: true, to } } as const;
            const { r, p, signature: signedOnDevice } = await approved(bytes, account, way, shell, (r) => {
                if (r.signers.some((s) => s !== account.address)) throw new Refused('another account would have to sign it');
                if (!r.accounts.some((a) => a.address === to)) throw new Refused('the transfer does not name the address you typed');
                // A token account of its own opened for a token account or a mint: no key could ever move what lands there.
                const kind = r.assessment.kinds.get(to as Address);
                if ((kind === 'tokens' || kind === 'mints') && opensFor(r, to)) throw new Refused('that address is a token account or a mint, not a wallet');
            });
            if (!(signedOnDevice && onDevice(account))) await unexpired(r, chain); // signed on a device: sent all the same (as for a site's)
            const signature = await signFor(account, messageOf(p.bytes), shell, null, signedOnDevice);
            await signed?.(getBase58Decoder().decode(signature) as Signature);
            const { signature: sent, outcome } = await landed(withSignature(p.bytes, account.address, signature), chain, shell);
            // Counted where it was paid, as the review saw it; keeping count never changes how the transfer went.
            const paid = r.assessment.flows.some((f) => f.change < 0n && f.others.some((o) => o.address === to || o.holder === to));
            if (outcome === 'confirmed' && paid) await shell.update((s) => sentTo(s, to)).catch(() => {});
            return { signature: sent, outcome };
        },
        { rejected: 'You rejected it', failed: 'Otus could not send it' },
    );
}

/** What the popup made to take access back (a delegate revoked, a nonce moved on) → reviewed and approved like a site's
 *  transaction, then signed and sent on the network the wallet shows; `signed` hears the signature before it is sent.
 *  It is that account's alone to sign, and does nothing else. The reply says whether it landed or failed onchain. */
export function takeBack(bytes: Uint8Array, address: string, shell: Shell, signed?: (signature: Signature) => Promise<unknown>): Promise<Reply> {
    return reply(
        async () => {
            const state = await shell.load();
            const account = accountOf(state, address);
            if (!account || !signs(account)) throw new Refused(NO_KEY);
            const cluster = networkOf(state.settings); // the network the wallet shows
            const chain = shell.chain(rpcFor(cluster, state.settings));
            const way = { cluster, chain, site: TAKING_BACK, blockhash: chain.latest(), bare: 'it only takes access back', context: { signedBefore: null, own: true } } as const;
            const { r, p, signature: signedOnDevice } = await approved(bytes, account, way, shell, (r) => {
                if (r.signers.some((s) => s !== account.address)) throw new Refused('another account would have to sign it');
                if (!takesBack(r, account.address)) throw new Refused('it does more than take access back');
            });
            if (!(signedOnDevice && onDevice(account))) await unexpired(r, chain);
            const signature = await signFor(account, messageOf(p.bytes), shell, null, signedOnDevice);
            await signed?.(getBase58Decoder().decode(signature) as Signature);
            return landed(withSignature(p.bytes, account.address, signature), chain, shell);
        },
        { rejected: 'You rejected it', failed: 'Otus could not send it' },
    );
}

/** What the popup made for native staking (a stake account of the wallet's made and delegated; a stake of its unstaked,
 *  or withdrawn to it) → reviewed and approved like a site's transaction, then signed and sent on the network the
 *  wallet shows; `signed` hears the signature before it is sent. It is that account's alone to sign, and does nothing
 *  else. The reply says whether it landed or failed onchain. */
export function stakeOwn(bytes: Uint8Array, address: string, shell: Shell, signed?: (signature: Signature) => Promise<unknown>): Promise<Reply> {
    return reply(
        async () => {
            const state = await shell.load();
            const account = accountOf(state, address);
            if (!account || !signs(account)) throw new Refused(NO_KEY);
            const cluster = networkOf(state.settings); // the network the wallet shows
            const chain = shell.chain(rpcFor(cluster, state.settings));
            const way = { cluster, chain, site: STAKING, blockhash: chain.latest(), context: { signedBefore: null, own: true } } as const;
            const { r, p, signature: signedOnDevice } = await approved(bytes, account, way, shell, async (r) => {
                if (r.signers.some((s) => s !== account.address)) throw new Refused('another account would have to sign it');
                if (!(await stakesOnly(r, account.address))) throw new Refused('it does more than stake');
            });
            if (!(signedOnDevice && onDevice(account))) await unexpired(r, chain);
            const signature = await signFor(account, messageOf(p.bytes), shell, null, signedOnDevice);
            await signed?.(getBase58Decoder().decode(signature) as Signature);
            return landed(withSignature(p.bytes, account.address, signature), chain, shell);
        },
        { rejected: 'You rejected it', failed: 'Otus could not send it' },
    );
}

/** What the popup made for a swap (a Jupiter route, built by Otus with a tip to Helius Sender), as `asked` there →
 *  reviewed and approved like a site's transaction, guarded, then signed and landed through Sender, on mainnet only;
 *  `signed` hears the signature before it is sent. It is that account's alone to sign, does nothing else, and swaps on
 *  the very terms asked. The reply says whether it landed or failed onchain. */
export function swapOwn(bytes: Uint8Array, address: string, asked: Asked, shell: Shell, signed?: (signature: Signature) => Promise<unknown>): Promise<Reply> {
    return reply(
        async () => {
            const state = await shell.load();
            const account = accountOf(state, address);
            if (!account || !signs(account)) throw new Refused(NO_KEY);
            const cluster = networkOf(state.settings); // the network the wallet shows
            if (cluster !== 'solana:mainnet') throw new Refused('swaps are on mainnet only');
            void shell.tokens([asked.input, asked.output]).catch(() => {}); // asked while it is reviewed: the window waits for their names
            const chain = shell.chain(rpcFor(cluster, state.settings));
            // Its guards hold what it gets to the slippage asked, as Jupiter's own least does, not a site's trade's tenth: a
            // quote set low by a bad route then costs no more than the slippage, measured against the honest simulation.
            const way = { cluster, chain, site: SWAPPING, blockhash: chain.latest(), trade: BigInt(asked.slippageBps), context: { signedBefore: null, own: true } } as const;
            const checks = async (r: Review) => {
                if (r.signers.some((s) => s !== account.address)) throw new Refused('another account would have to sign it');
                const why = await swapRefusal(r, account.address, asked);
                if (why) throw new Refused(`it does more than swap: ${why}`);
            };
            // Unguarded, a swap would rest on the route's own least alone: never signed so. One that fails as it is now
            // (more than you hold, a price gone) says so.
            const ready = (p: Prepared) => {
                if (p.unguarded === SIMULATION_FAILED) throw new Refused('the swap would fail as it is now (check what you hold, and quote it again), so nothing was sent');
                if (p.unguarded !== null || p.holds.length === 0) throw new Refused(`${p.unguarded === null || p.unguarded === NOTHING_TO_HOLD ? 'Otus found nothing of yours to guard in this swap' : p.unguarded}, so nothing was sent`);
            };
            const { r, p, signature: signedOnDevice } = await approved(bytes, account, way, shell, checks, undefined, ready);
            if (!(signedOnDevice && onDevice(account))) await unexpired(r, chain);
            const signature = await signFor(account, messageOf(p.bytes), shell, null, signedOnDevice);
            await signed?.(getBase58Decoder().decode(signature) as Signature);
            return landed(withSignature(p.bytes, account.address, signature), shell.fast?.(chain) ?? chain, shell);
        },
        { rejected: 'You rejected it', failed: 'Otus could not send it' },
    );
}

// A v0 message with Compute Budget's SetComputeUnitLimit (2) first and a tip to one of Sender's accounts last (System's
// Transfer, 2, of exactly TIP from the owner), and between them only what a Jupiter route sets up, swaps and cleans up
// for this owner, as asked:
// - at most four of its own token accounts opened (Associated Token's CreateIdempotent, 1, paid by it, with the System
//   Program, a token program, and the very address the three derive): for the swap's two tokens, or for a token a route
//   of several steps passes through, when the swap itself names that account (route_v2 swaps through the taker's own);
// - paying SOL, that amount moved into its wrapped-SOL account (Transfer) and synced (a token program's SyncNative, 17);
// - Jupiter's one swap (route_v2 or shared_accounts_route_v2), signed by it, with the amount, quote and slippage asked
//   and no fee, from its own account of the mint paid into its own account of the mint asked for (see `termsOf`);
// - its wrapped-SOL account closed back to it (CloseAccount, 9), when SOL is on one side.
// The route plan is Jupiter's: the review simulates it, and the guards hold what comes of it. Why it is not one, in a few
// words, or null when it is.
const MOST_OPENED = 4; // the token got, wrapped SOL, and two a route passes through

async function swapRefusal(r: Review, owner: Address, asked: Asked): Promise<string | null> {
    type Ix = Review['message']['instructions'][number];
    const program = (ix: Ix) => r.accounts[ix.programAddressIndex].address;
    const at = (ix: Ix, i: number) => r.accounts[ix.accountIndices[i]]?.address;
    const transfer = (ix: Ix, to: (a: Address | undefined) => boolean, lamports?: bigint) =>
        program(ix) === SYSTEM_PROGRAM_ADDRESS && ix.data.length === 12 && ix.accountIndices.length === 2 && new DataView(ix.data.buffer, ix.data.byteOffset, 12).getUint32(0, true) === 2 && at(ix, 0) === owner && to(at(ix, 1)) && (lamports === undefined || new DataView(ix.data.buffer, ix.data.byteOffset, 12).getBigUint64(4, true) === lamports);
    const instructions = r.message.instructions;
    const [limit] = instructions;
    const tip = instructions.at(-1);
    if (r.message.version !== 0 || instructions.length < 3 || !limit || !tip || program(limit) !== COMPUTE_BUDGET_PROGRAM_ADDRESS || limit.data.length !== 5 || limit.data[0] !== 2) return 'not the compute limit first';
    if (!transfer(tip, (a) => a !== undefined && SENDER_TIPS.includes(a), TIP)) return "its last instruction isn't the tip to Sender";
    const ownAccount = async (mint: Address | undefined, program: Address | undefined) => mint && program && isTokenProgram(program) && (await findAssociatedTokenPda({ owner, mint, tokenProgram: program }))[0];
    const [wrapped] = await findAssociatedTokenPda({ owner, mint: WSOL, tokenProgram: TOKEN_PROGRAM_ADDRESS });
    const paysSol = asked.input === WSOL;
    // The accounts route_v2 names: a token it passes through is swapped in the taker's own account of it. (The shared
    // route swaps through Jupiter's own: it opens none of the taker's.) Whether it writes one can't be told here: a
    // message's accounts are writable for all its instructions, and the create makes it so; the popup's reading of the
    // route, which has each instruction's roles, asks it.
    const swapNames = new Set(
        instructions
            .filter((ix) => program(ix) === JUPITER && throughOwn(ix.data))
            .flatMap((ix) => ix.accountIndices.map((i) => r.accounts[i]?.address))
            .filter((a): a is Address => a !== undefined),
    );
    const opened = new Set<Address | undefined>();
    let [swaps, wraps] = [0, 0];
    for (const ix of instructions.slice(1, -1)) {
        const p = program(ix);
        if (p === JUPITER) {
            swaps++;
            const t = termsOf(ix.data, (i) => at(ix, i), ix.accountIndices.length);
            if (t === null) return "Jupiter's instruction isn't a swap";
            if (t.signer !== owner) return 'the swap is signed by another account';
            if (t.inputMint !== asked.input || t.outputMint !== asked.output) return 'the swap is for other tokens than asked';
            if (t.amount !== asked.amount) return 'the swap pays another amount than asked';
            if (t.quoted !== asked.out || t.slippageBps !== asked.slippageBps) return "the swap's quote or slippage isn't the one shown";
            if (t.platformFeeBps !== 0 || t.positiveSlippageBps !== 0) return 'the swap takes a fee';
            if (t.elsewhere !== null && t.elsewhere !== JUPITER) return 'the swap pays out to another account';
            if (t.source !== (await ownAccount(t.inputMint, t.inputProgram))) return "the swap pays from an account that isn't your token account";
            if (t.destination !== (await ownAccount(t.outputMint, t.outputProgram))) return "the swap pays into an account that isn't your token account";
        } else if (p === ASSOCIATED_TOKEN_PROGRAM_ADDRESS) {
            if (ix.data.length !== 1 || ix.data[0] !== 1 || ix.accountIndices.length !== 6 || at(ix, 0) !== owner || at(ix, 2) !== owner || at(ix, 4) !== SYSTEM_PROGRAM_ADDRESS) return 'it opens an account otherwise than for you, paid by you';
            if (at(ix, 1) === undefined || at(ix, 3) === undefined) return 'it opens an account it does not name';
            if (at(ix, 3) !== asked.input && at(ix, 3) !== asked.output && !swapNames.has(at(ix, 1)!)) return "it opens an account for a token the swap doesn't pass through";
            if (at(ix, 1) !== (await ownAccount(at(ix, 3), at(ix, 5)))) return "it opens an account that isn't your token account";
            if (opened.has(at(ix, 1))) return 'it opens the same account twice';
            opened.add(at(ix, 1));
        } else if (p === SYSTEM_PROGRAM_ADDRESS) {
            if (!paysSol || ++wraps > 1 || !transfer(ix, (a) => a === wrapped, asked.amount)) return "it moves SOL other than the amount wrapped to pay";
        } else if (isTokenProgram(p)) {
            const syncs = paysSol && ix.data.length === 1 && ix.data[0] === 17 && ix.accountIndices.length === 1 && at(ix, 0) === wrapped;
            const closes = (paysSol || asked.output === WSOL) && ix.data.length === 1 && ix.data[0] === 9 && ix.accountIndices.length === 3 && at(ix, 0) === wrapped && at(ix, 1) === owner && at(ix, 2) === owner;
            if (!syncs && !closes) return `it runs a token instruction (${ix.data[0] ?? 'none'}) other than wrapping or unwrapping SOL`;
        } else return `it calls another program, ${p}`;
    }
    if (swaps !== 1) return swaps === 0 ? 'there is no swap in it' : 'it swaps more than once';
    if (opened.size > MOST_OPENED) return 'it opens more than four accounts';
    return null;
}

// A legacy or v0 message (v1's limits and fee live in its config) with Compute Budget's SetComputeUnitLimit (2) first,
// then only what Otus builds for stake: a stake account made at the address a seed of the owner's derives (System's
// CreateAccountWithSeed, 3), set to answer to the owner alone with no lockup (Stake's Initialize, 0) and delegated by
// it (DelegateStake, 2); or a stake unstaked by the owner (Deactivate, 5); or one withdrawn to the owner (Withdraw, 4).
async function stakesOnly(r: Review, owner: Address): Promise<boolean> {
    const [limit, ...rest] = r.message.instructions;
    type Ix = Review['message']['instructions'][number];
    const program = (ix: Ix) => r.accounts[ix.programAddressIndex].address;
    const at = (ix: Ix, i: number) => r.accounts[ix.accountIndices[i]]?.address;
    const is = (ix: Ix, of: Address, n: number, accounts: number) => program(ix) === of && ix.accountIndices.length === accounts && ix.data.length >= 4 && new DataView(ix.data.buffer, ix.data.byteOffset, 4).getUint32(0, true) === n;
    const b58 = getBase58Decoder();
    // No lookup table either: what Otus builds names every account itself, and a table read from the RPC could be told wrong.
    if (r.message.version === 1 || r.message.lookups.length > 0 || !limit || program(limit) !== COMPUTE_BUDGET_PROGRAM_ADDRESS || limit.data.length !== 5 || limit.data[0] !== 2) return false;
    if (rest.length === 1) {
        const [ix] = rest;
        if (is(ix, STAKE_PROGRAM_ADDRESS, 5, 2)) return ix.data.length === 4 && at(ix, 1) === owner;
        if (is(ix, STAKE_PROGRAM_ADDRESS, 4, 3)) return ix.data.length === 12 && at(ix, 1) === owner && at(ix, 2) === owner;
        return false;
    }
    if (rest.length !== 3) return false;
    const [create, init, delegate] = rest;
    if (!is(create, SYSTEM_PROGRAM_ADDRESS, 3, 3) || !is(init, STAKE_PROGRAM_ADDRESS, 0, 1) || !is(delegate, STAKE_PROGRAM_ADDRESS, 2, 3)) return false;
    // CreateAccountWithSeed: its base (32), its seed (u64 length, text), lamports, space (u64 each), the new owner (32).
    const d = create.data;
    if (d.length < 4 + 32 + 8) return false;
    const view = new DataView(d.buffer, d.byteOffset, d.byteLength);
    const length = view.getBigUint64(36, true);
    if (length > 32n || d.length !== 4 + 32 + 8 + Number(length) + 8 + 8 + 32) return false;
    const after = 44 + Number(length);
    // The seed's very bytes derive the address, as the network does it: text decoding would drop a leading BOM.
    const seed = d.subarray(44, after);
    try {
        new TextDecoder('utf-8', { fatal: true }).decode(seed);
    } catch {
        return false;
    }
    const stake = at(create, 1);
    const fits =
        b58.decode(d.subarray(4, 36)) === owner &&
        at(create, 0) === owner &&
        at(create, 2) === owner &&
        view.getBigUint64(after + 8, true) === STAKE_SPACE &&
        b58.decode(d.subarray(after + 16)) === STAKE_PROGRAM_ADDRESS &&
        stake === (await createAddressWithSeed({ baseAddress: owner, programAddress: STAKE_PROGRAM_ADDRESS, seed }));
    // Initialize: the owner stakes and withdraws (32 each), with no lockup (48 zero bytes). DelegateStake: by the owner.
    const i = init.data;
    const answers = i.length === 4 + 64 + 48 && b58.decode(i.subarray(4, 36)) === owner && b58.decode(i.subarray(36, 68)) === owner && i.subarray(68).every((b) => b === 0);
    return fits && answers && at(init, 0) === stake && delegate.data.length === 4 && at(delegate, 0) === stake && at(delegate, 2) === owner;
}

// A legacy or v0 message (v1's limits and fee live in its config) with Compute Budget's SetComputeUnitLimit (2) first,
// then only what takes access back: a token program's Revoke (5) of an account this owner signs for, or the System
// Program's AdvanceNonceAccount (4) of a nonce whose authority it is.
function takesBack(r: Review, owner: Address): boolean {
    const [limit, ...rest] = r.message.instructions;
    const program = (ix: Review['message']['instructions'][number]) => r.accounts[ix.programAddressIndex].address;
    if (r.message.version === 1 || !limit || program(limit) !== COMPUTE_BUDGET_PROGRAM_ADDRESS || limit.data.length !== 5 || limit.data[0] !== 2 || rest.length === 0) return false;
    return rest.every((ix) => {
        const at = (i: number) => r.accounts[ix.accountIndices[i]]?.address;
        if (isTokenProgram(program(ix))) return ix.data.length === 1 && ix.data[0] === 5 && at(1) === owner;
        return program(ix) === SYSTEM_PROGRAM_ADDRESS && ix.data.length === 4 && [4, 0, 0, 0].every((b, i) => ix.data[i] === b) && at(2) === owner;
    });
}

// A request's outcome as the reply its caller gets: what it returned, or why not, in words.
async function reply(work: () => Promise<unknown>, words: { rejected: string; failed: string }): Promise<Reply> {
    try {
        return { ok: true, result: await work() };
    } catch (e) {
        if (e instanceof Rejected) return { ok: false, error: words.rejected, rejected: true };
        const error = told(e);
        if (error === null) console.error('Otus:', e);
        return { ok: false, error: error ?? words.failed };
    }
}

// What a failure tells the site, and the user: its words, the RPC's, or null for one Otus does not say (a no among them).
function told(e: unknown): string | null {
    if (e instanceof Refused) return e.message;
    if (isSolanaError(e, SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR)) return `the RPC refused Otus's request (HTTP ${e.context.statusCode})`;
    if (timedOut(e)) return 'the RPC did not answer in time';
    // Behind the network, or failing inside: a moment later it answers.
    const busy = [SOLANA_ERROR__JSON_RPC__SERVER_ERROR_MIN_CONTEXT_SLOT_NOT_REACHED, SOLANA_ERROR__JSON_RPC__SERVER_ERROR_NODE_UNHEALTHY, SOLANA_ERROR__JSON_RPC__INTERNAL_ERROR] as const;
    if (busy.some((code) => isSolanaError(e, code))) return 'the RPC could not answer just now: try again';
    if (e instanceof TypeError && /fetch/i.test(e.message)) return "Otus couldn't reach the RPC";
    return null;
}

const accountOf = (state: State, address: string | null): Account | undefined => state.accounts.find((a) => a.address === address);

// Whether the transaction opens an associated token account owned by this address: the ATA program's create, its
// owner third.
const opensFor = (r: Review, owner: string) =>
    r.message.instructions.some((ix) => r.accounts[ix.programAddressIndex].address === ASSOCIATED_TOKEN_PROGRAM_ADDRESS && r.accounts[ix.accountIndices[2]]?.address === owner);

function need<T>(value: T | undefined, refusal: string): T {
    if (value === undefined) throw new Refused(refusal);
    return value;
}

// A request to sign comes from a site connected to that very account.
function connected(state: State, origin: string, address: Address) {
    const site = state.sites[origin];
    if (site?.account !== address) throw new Refused(NOT_CONNECTED);
    return { site, account: need(accountOf(state, address), NOT_CONNECTED) };
}

/** `programs`: for a transaction, those it calls (programsCalled). */
type Asker = { origin: string; connects?: boolean; programs?: Address[] };

// Once the user says yes, from state as it is now: the site may have been disconnected, or the account removed,
// while they decided. The account counts the signature; so does the site that asked, if any (null: your own transfer).
// A Ledger account's signature came with the yes (`fromDevice`): it counts only over these very bytes, by
// its own key. A transaction's signature is kept with the account, to tell those it signs elsewhere from Otus's.
async function signFor(account: Account, data: Uint8Array, shell: Shell, asker: Asker | null, fromDevice?: SignatureBytes, transaction = true): Promise<SignatureBytes> {
    const { accounts, sites } = await shell.load();
    const now = accounts.find((a) => a.address === account.address);
    if (asker && (!now || (!asker.connects && sites[asker.origin]?.account !== account.address))) throw new Refused(NOT_CONNECTED);
    if (!now || !signs(now)) throw new Refused(NO_KEY);
    const signature = onDevice(now) ? await deviceSigned(now, data, fromDevice) : await shell.sign(now, data);
    await shell.update((s) => ({
        accounts: s.accounts.map((a) => (a.address === account.address ? { ...a, signatures: (a.signatures ?? 0) + 1 } : a)),
        ...(asker && signedFor(s, asker, account.address, shell.now())),
        // Not for an account removed in the meantime: its entry went with it.
        ...(transaction && s.accounts.some((a) => a.address === account.address) && { signedHere: { ...s.signedHere, [account.address]: [...(s.signedHere[account.address] ?? []), getBase58Decoder().decode(signature)].slice(-MAX_SIGNED_HERE) } }),
    }));
    return signature;
}

async function deviceSigned(account: Account, data: Uint8Array, signature: SignatureBytes | undefined): Promise<SignatureBytes> {
    if (signature?.length !== 64 || !(await verifySignature(await getPublicKeyFromAddress(account.address), signature, data))) {
        throw new Refused('the Ledger did not sign it with this account');
    }
    return signature;
}

const MAX_SITE_PROGRAMS = 32; // kept for a site, the latest last

// A site once it got a signature: counted, connected by a sign-in (with what was kept of it, if it was disconnected),
// known from the day after its first transaction, and the programs its transactions call kept.
function signedFor(state: Pick<State, 'sites' | 'disconnected'>, { origin, connects = false, programs }: Asker, address: Address, now: number): Partial<Pick<State, 'sites' | 'disconnected'>> | null {
    if (!connects && state.sites[origin]?.account !== address) return null;
    const restored = !Object.hasOwn(state.sites, origin); // connected by this sign-in: what was kept of it comes back
    const { sites, disconnected } = restored ? connectSite(state, origin, address) : state;
    const site = sites[origin];
    const same = site.account === address;
    const since = (same ? site.since : undefined) ?? (programs ? Math.floor(now / 1000) : undefined);
    const kept = same ? site.programs : undefined;
    const called = programs ? [...(kept ?? []).filter((p) => !programs.includes(p)), ...programs].slice(-MAX_SITE_PROGRAMS) : kept; // the latest used last
    return { sites: { ...sites, [origin]: { account: address, signatures: same ? site.signatures + 1 : 1, ...(since !== undefined && { since }), ...(called && { programs: called }) } }, ...(restored && { disconnected }) };
}

const MAX_USABLE = 32; // transactions waiting, and delegates given, kept: the latest

// What a site can use once signed for, besides the transaction: the transaction itself, while it waits on a durable
// nonce; and the delegates it gives on token accounts of yours. Kept with the site, for Access to say who.
export function usable(s: State, r: Review, wallet: Address, host: string, now: number): Partial<State> | null {
    const at = Math.floor(now / 1000);
    const waits = waitingOn(r.message);
    const given = delegatesGiven(r.assessment.yours);
    if (!waits && given.length === 0) return null;
    return {
        ...(waits && { waiting: [...s.waiting.filter((w) => w.account !== waits.account || w.nonce !== waits.nonce), { wallet, ...waits, host, at }].slice(-MAX_USABLE) }),
        ...(given.length > 0 && { given: [...s.given.filter((g) => !given.some((x) => x.account === g.account)), ...given.map((g) => ({ ...g, host, at }))].slice(-MAX_USABLE) }),
    };
}

const base64 = (bytes: Uint8Array) => getBase64Decoder().decode(bytes);

// A message as text when it is UTF-8, with invisible and control characters shown as such; otherwise as hex.
function readable(message: Uint8Array): string {
    try {
        return new TextDecoder('utf-8', { fatal: true }).decode(message).replace(/(?![\n\t])[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, '�');
    } catch {
        return `0x${Array.from(message, (b) => b.toString(16).padStart(2, '0')).join('')}`;
    }
}
