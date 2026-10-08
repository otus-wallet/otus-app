// What the background answers: sites' requests, and the transfers made in Otus's own popup. Each is checked, shown
// to the user and, once approved, signed with state as it is then. A reply never throws.
import { getBase58Decoder, getBase64Decoder, getPublicKeyFromAddress, isAddress, isSolanaError, SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR, verifySignature, type Address, type Signature, type SignatureBytes } from '@solana/kit';

import { ASSOCIATED_TOKEN_PROGRAM_ADDRESS } from '@solana-program/token';

import type { Chain } from '@otus-wallet/sdk/chain';
import { gate } from '../gate.ts';
import { intake, type Request } from '../intake.ts';
import { NO_KEY, Refused, type Reply } from '../protocol.ts';
import { decode } from '@otus-wallet/sdk/review/decode';
import type { Prepared } from '@otus-wallet/sdk/prepare/prepare';
import type { Review } from '@otus-wallet/sdk/review/review';
import { timedOut } from '@otus-wallet/sdk/rpc';
import type { Sent } from '../send/send.ts';
import { rpcFor } from '../settings.ts';
import { signInFields, signInText } from '../siws.ts';
import type { TokenInfo } from '../tokens.ts';
import { accountView, siteView, type Approval, type Life, type SiteView } from '../ui/view.ts';
import type { Answer } from './approvals.ts';
import { onDevice, sentTo, signs, type Account, type State } from './state.ts';
import { approved, clusterOf, landed, messageOf, Rejected, signerOf, unexpired, withSignature } from './transaction.ts';

/** What serve needs from the extension: its state, the user's answer (behind Otus's lock), the keystore, the network
 *  and the time. Tests pass fakes. */
export type Shell = {
    load(): Promise<State>;
    update(change: (state: State) => Partial<State> | null): Promise<void>; // one after another, from state as it is then
    approve(approval: Approval, follow?: (tell: (life: Life) => void) => void, later?: Promise<Approval>): Promise<Answer>; // yes or no (for a Ledger account, yes is its signature; to connect, yes may name another account); `follow`: its blockhash's life, for the window to show; `later`: the approval in its final form, which replaces the first and alone takes a yes (failing, it says no)
    sign(account: Account, data: Uint8Array): Promise<SignatureBytes>; // throws Refused when locked or without the key
    chain(rpc: string): Chain;
    send(signed: Uint8Array, chain: Chain): Promise<Sent>; // sent, then watched until it lands or cannot
    tokens(mints: string[]): Promise<Map<string, TokenInfo | null>>; // names and prices, from Jupiter
    now(): number; // ms since 1970
};

const NOT_CONNECTED = 'this site is not connected to that account';
const LEDGER_MESSAGES = 'a Ledger account signs transactions only, not messages';
const NO_ACCOUNT = 'there is no account in Otus yet';
const NO_SIGNER = 'no account in Otus can sign: a watched one cannot connect';
// A transfer made in the popup has no site: this stands for one in its review.
const OWN_SITE: SiteView = { origin: 'otus://popup', host: 'Otus', note: 'Your own transfer', tone: 'plain' };

/** A site's call and the origin the browser gave → the reply for the site. */
export function serve(call: unknown, origin: string, shell: Shell): Promise<Reply> {
    return reply(
        async () => {
            const request = intake(call, origin);
            const state = await shell.load();
            return handle(gate(request, state.settings), state, shell);
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
            if (known) return { accounts: [known.address], v1: !known.ledger };
            if (request.silent) throw new Refused('not connected');
            // The account in use, or another of yours chosen in the window, which is then the one in use: one that signs, as
            // a watched account cannot, so a site has no use for it.
            const active = need(accountOf(state, state.active), NO_ACCOUNT);
            const choices = state.accounts.filter(signs);
            if (!choices.length) throw new Refused(NO_SIGNER);
            const answer = await shell.approve({ kind: 'connect', site: siteView(origin, undefined), account: accountView(active), choices: choices.map(accountView) });
            if (answer !== true && !(typeof answer === 'object' && 'account' in answer)) throw new Rejected();
            const account = need(choices.find((c) => c.address === (answer === true ? active.address : answer.account)), NO_SIGNER);
            await shell.update((s) => ({ sites: { ...s.sites, [origin]: { account: account.address, signatures: 0 } }, active: account.address })); // as they are now: the user may have changed them while deciding
            return { accounts: [account.address], v1: !account.ledger };
        }
        case 'disconnect': {
            await shell.update((s) => {
                const { [origin]: _, ...rest } = s.sites;
                return { sites: rest };
            });
            return null;
        }
        case 'transaction': {
            const { account, site } = connected(state, origin, request.account);
            if (request.transactions.length > 1) throw new Refused('several transactions in one call are not supported yet');
            const bytes = request.transactions[0];
            // What the bytes alone refuse, refused before any network work; and one at a time from a site, which
            // could otherwise spend the user's RPC on reviews no window ever shows.
            const { signers, signed } = await decode(bytes);
            if (!signers.includes(account.address)) throw new Refused('this wallet does not sign this transaction');
            if (request.send && signers.some((s) => s !== account.address && !signed.includes(s))) throw new Refused('another signature is missing, so it cannot be sent');
            return transact(request, bytes, account, site, state, shell);
        }
        case 'message': {
            const { account, site } = connected(state, origin, request.account);
            // Asked like any other, so a site learns nothing from it; the window says a Ledger cannot sign it.
            await approve({ kind: 'message', site: siteView(origin, site), account: accountView(account), text: readable(request.message), signer: signerOf(account) });
            if (account.ledger) throw new Refused(LEDGER_MESSAGES);
            const signature = await signFor(account, request.message, shell, { origin });
            return { signedMessage: base64(request.message), signature: base64(signature) };
        }
        case 'signIn': {
            // A site connected to an account signs in with it; any other gets the account in use, whatever address it
            // names: refusing an address Otus does not hold would tell the site which ones it does.
            const site = state.sites[origin];
            const account = need(accountOf(state, site?.account ?? null) ?? accountOf(state, state.active), NO_ACCOUNT);
            if (site && request.input.address !== undefined && request.input.address !== account.address) throw new Refused('that account is not connected to this site');
            const input = { ...request.input, domain: new URL(origin).host, address: account.address };
            await approve({ kind: 'signIn', site: siteView(origin, site), account: accountView(account), fields: signInFields(input), signer: signerOf(account) });
            if (account.ledger) throw new Refused(LEDGER_MESSAGES);
            const message = new TextEncoder().encode(signInText(input));
            const signature = await signFor(account, message, shell, { origin, connects: true });
            return { account: account.address, signedMessage: base64(message), signature: base64(signature) };
        }
    }
}

const reviewing = new Set<string>(); // sites whose transaction is being reviewed or decided

// A site's transaction, checked: its cluster, the review and the user's answer, one at a time per site; then signed,
// and sent if asked.
async function transact(request: Extract<Request, { kind: 'transaction' }>, bytes: Uint8Array, account: Account, site: State['sites'][string], state: State, shell: Shell): Promise<unknown> {
    const { origin } = request;
    if (reviewing.has(origin)) throw new Refused('Otus is already asking you about a request from this site');
    reviewing.add(origin);
    let decided: { r: Review; p: Prepared; signature?: SignatureBytes; chain: Chain };
    try {
        const { cluster, chain } = await clusterOf(bytes, request.chain, state.settings, shell);
        const way = { cluster, chain, site: siteView(origin, site), later: !request.send, context: { signedBefore: site.since ?? null, host: new URL(origin).host } };
        decided = { ...(await approved(bytes, account, way, shell, () => {})), chain };
    } finally {
        reviewing.delete(origin);
    }
    const { r, p, signature, chain } = decided;
    // Signed on a Ledger right as its blockhash ran out, it goes to the network all the same:
    // it may still land, and if not the network says so. Otus's own key doesn't sign what can no longer land.
    if (!signature) await unexpired(r, chain);
    const signed = withSignature(p.bytes, account.address, await signFor(account, messageOf(p.bytes), shell, { origin, transaction: true }, signature));
    return request.send ? { signatures: [(await landed(signed, chain, shell)).signature] } : { transactions: [base64(signed)] };
}

/** A transfer the popup made for one of your accounts to the address typed → reviewed and approved like a site's,
 *  with that address shown whole, then signed and sent on mainnet; `signed` hears the signature before it is sent. It
 *  is that account's alone to sign. The reply says whether it landed or failed onchain. */
export function own(bytes: Uint8Array, address: string, to: string, shell: Shell, signed?: (signature: Signature) => Promise<unknown>): Promise<Reply> {
    return reply(
        async () => {
            const state = await shell.load();
            const account = accountOf(state, address);
            if (!account || !signs(account)) throw new Refused(NO_KEY);
            if (!isAddress(to)) throw new Refused('that is not a Solana address');
            const cluster = 'solana:mainnet';
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
            if (!signedOnDevice) await unexpired(r, chain); // signed on a device: sent all the same (as for a site's)
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

// A request's outcome as the reply its caller gets: what it returned, or why not, in words.
async function reply(work: () => Promise<unknown>, words: { rejected: string; failed: string }): Promise<Reply> {
    try {
        return { ok: true, result: await work() };
    } catch (e) {
        if (e instanceof Rejected) return { ok: false, error: words.rejected, rejected: true };
        if (e instanceof Refused) return { ok: false, error: e.message };
        if (isSolanaError(e, SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR)) return { ok: false, error: `the RPC refused Otus's request (HTTP ${e.context.statusCode})` };
        if (timedOut(e)) return { ok: false, error: 'the RPC did not answer in time' };
        console.error('Otus:', e);
        return { ok: false, error: words.failed };
    }
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

type Asker = { origin: string; connects?: boolean; transaction?: boolean };

// Once the user says yes, from state as it is now: the site may have been disconnected, or the account removed,
// while they decided. The account counts the signature; so does the site that asked, if any (null: your own transfer).
// A Ledger account's signature came with the yes (`fromDevice`): it counts only over these very bytes, by
// its own key.
async function signFor(account: Account, data: Uint8Array, shell: Shell, asker: Asker | null, fromDevice?: SignatureBytes): Promise<SignatureBytes> {
    const { accounts, sites } = await shell.load();
    const now = accounts.find((a) => a.address === account.address);
    if (asker && (!now || (!asker.connects && sites[asker.origin]?.account !== account.address))) throw new Refused(NOT_CONNECTED);
    if (!now || !signs(now)) throw new Refused(NO_KEY);
    const signature = onDevice(now) ? await deviceSigned(now, data, fromDevice) : await shell.sign(now, data);
    await shell.update((s) => ({
        accounts: s.accounts.map((a) => (a.address === account.address ? { ...a, signatures: (a.signatures ?? 0) + 1 } : a)),
        ...(asker && signedFor(s.sites, asker, account.address, shell.now())),
    }));
    return signature;
}

async function deviceSigned(account: Account, data: Uint8Array, signature: SignatureBytes | undefined): Promise<SignatureBytes> {
    if (signature?.length !== 64 || !(await verifySignature(await getPublicKeyFromAddress(account.address), signature, data))) {
        throw new Refused('the Ledger did not sign it with this account');
    }
    return signature;
}

// A site once it got a signature: counted, connected by a sign-in, and known from the day after its first transaction.
function signedFor(sites: State['sites'], { origin, connects = false, transaction = false }: Asker, address: Address, now: number): Pick<State, 'sites'> | null {
    const site = sites[origin];
    const same = site?.account === address;
    if (!connects && !same) return null;
    const since = (same ? site.since : undefined) ?? (transaction ? Math.floor(now / 1000) : undefined);
    return { sites: { ...sites, [origin]: { account: address, signatures: same ? site.signatures + 1 : 1, ...(since !== undefined && { since }) } } };
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
