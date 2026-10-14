// What the approval window shows, worked out in the background from the review: text and tones only. The window
// renders it and decides nothing.
import { getBase64Decoder, type Address } from '@solana/kit';

import { plural, sol } from '@otus-wallet/sdk/format';
import type { IdlInstruction } from '@otus-wallet/sdk/idl/idl';
import type { Cluster } from './intake.ts';
import { described, lookalikes, ranked, type Finding, type Level, type Tone, type Verdict } from '@otus-wallet/sdk/review/assess';
import type { Effect } from '@otus-wallet/sdk/review/effects';
import type { Review } from '@otus-wallet/sdk/review/review';
import { lookalike } from '@otus-wallet/sdk/review/sites';
import { NOTHING_TO_HOLD, SIMULATION_FAILED, type Prepared } from '@otus-wallet/sdk/prepare/prepare';
import type { ProposalTold } from '@otus-wallet/sdk/review/squads';
import type { Account, Site } from './state.ts';
import type { TokenInfo } from './tokens.ts';
import { balances } from './view/balances.ts';
import { imitations, misread, noteOf } from './view/findings.ts';
import { keptIn, names, type Kept } from './view/names.ts';
import { programs, selfNamed } from './view/programs.ts';
import { partiesOf, proposalViews, type ProposalView } from './view/squads.ts';

export type { Tone };

/** Whether Otus can sign for the account, on which device, or not at all: an address you only watch. Locked, Otus
 *  shows its lock before any request. */
export type Signer = 'ready' | 'ledger' | 'none';

/** A token logo the extension carries. */
export type Logo = 'sol' | 'usdc' | 'usdt' | 'chain';

export type SiteView = { origin: string; host: string; note: string; tone: Tone };
export type AccountView = { label: string; address: string };
/** `source`: what reads it; 'idl', the program's own IDL, which tells its names and arguments and vouches for nothing. */
export type InstructionView = { number: number; name: string; args: string; source: 'core' | 'plugin' | 'idl' | 'unknown'; accounts: { name: string; role: string; tone: Tone }[]; effects: Effect[] };
export type ProgramView = {
    name: string; // Otus's, for a program it knows; for one it doesn't, what its own IDL calls it, or "Unknown program"
    address: string;
    standing: 'known' | 'described' | 'unknown'; // one Otus knows; one it doesn't, its own IDL describing it; neither
    tone: Tone; // known, ok; otherwise as what is found of it says
    sub: string; // what it gets from you
    subTone: Tone;
    meta: string; // whether it can still change, or built into Solana; empty when unknown
    metaTone: Tone | 'info';
    inner: string; // what it calls inside
    instructions: InstructionView[];
};
/** An asset of yours that moves: what it comes to, and each thing that moves it. `icon`: a verified token's own. */
export type AssetChange = { asset: string; logo: Logo; icon: string | null; verified: boolean; amount: string; tone: Tone; lines: BalanceLine[] };
/** One thing that moves an asset: where it goes or comes from, and by how much. */
export type BalanceLine = { note: string; amount: string; tone: Tone };
/** A finding as the window lists it: a title, and what it is about. */
export type Line = { title: string; note: string; tone: Tone };

/** What an approval window shows. */
export type Approval =
    | { kind: 'connect'; site: SiteView; account: AccountView; choices: AccountView[]; findings: Line[] } // choices: your accounts that sign, to connect another; the one in use may not be one; findings: what is known of the site
    | { kind: 'message'; site: SiteView; account: AccountView; text: string; findings: Line[]; signer: Signer } // findings: data, not words
    | { kind: 'signIn'; site: SiteView; account: AccountView; fields: [string, string][]; findings: Line[]; signer: Signer } // findings: what is known of the site, when signing in connects it
    | { kind: 'pending'; site: SiteView; account: AccountView; refused?: string } // a site's transaction, while it is reviewed: who asks, for which account; refused: why it ended before it was shown
    | TransactionView;

export type TransactionView = {
    kind: 'transaction';
    site: SiteView;
    account: AccountView;
    verdict: Verdict;
    title: string; // Looks safe, Caution, Not safe
    sub: string; // what the findings come to
    chip: { text: string; tone: Tone };
    signer: Signer;
    network: string | null; // the cluster, when it is not mainnet
    balances: AssetChange[];
    changes: Line[]; // what you would lose, or that it would fail: before anything else
    accounts: number; // how many accounts the transaction involves
    hash: string;
    wire: string; // the transaction as it will be signed, base64, to check it elsewhere; empty while it is prepared
    counts: { programs: number; instructions: number; inner: number };
    programs: ProgramView[];
    findings: Line[];
    fee: string;
    guards: { held: boolean; text: string; why?: string }; // whether guards hold the outcome, and how many or why not; empty when it goes without saying
    added: string[]; // what Otus added to the transaction or changed in it
    cluster: Cluster;
    expiry: Expiry | null; // null for a durable transaction, which waits for its nonce instead
    recipient?: string; // for a transfer made in Otus: the address typed, shown whole
    proposals: ProposalView[]; // the Squads proposals it creates, votes on or runs, and what each does
    ledger?: { path: string; message: string }; // for a Ledger account: the path of its key, and the message to sign (base64)
    blocked?: string; // why it cannot be signed at all, though shown
    preparing?: true; // shown as reviewed while Otus still adds its guards and fees: no verdict, no hash, no signing yet
    kept: Kept[]; // your other wallets and contacts it names (tagged), or like an address it names (to cut that one apart)
};

/** How a site's transaction went once approved, for its window: on its way (Otus sends it, or the site does and Otus
 *  watches for it), signed for the site to send when Otus can't follow it (another account pays, unsigned yet), then
 *  how it ended: landed (worked or failed), not seen landing (`expired`: its blockhash ran out first), or refused. */
export type Outcome =
    | { phase: 'sending' }
    | { phase: 'waiting'; host: string; link: string }
    | { phase: 'signed'; host: string }
    | { phase: 'landed'; failed: boolean; link: string }
    | { phase: 'unseen'; expired: boolean; link: string }
    | { phase: 'refused'; error: string };

/** How long a transaction's blockhash lives, as the network tells while the user decides: until about when (ms since
 *  1970), or gone. */
export type Life = { until: number } | { expired: true };

/** When the transaction can no longer be signed to land: from when its blockhash was read, or its request came. */
export type Expiry = { from: number; until: number };

/** What is known besides the review: Jupiter's names and prices of its tokens, the mints' decimals, and its instructions
 *  no plugin reads as their programs' IDLs tell them, by their place. */
export type Known = { tokens: Map<string, TokenInfo | null>; decimals: Map<string, number>; told?: Map<number, IdlInstruction>; squads?: ProposalTold[] };

/** What the window shows besides the review: for which site and account, whether Otus can sign, on which
 *  cluster, what is known of the tokens, and for a transfer made in Otus the address typed. `later`: the site only
 *  asks for the signature, and sends the transaction when it chooses. */
/** `away`: the transaction is for another network than the one the wallet shows, which the window then names, mainnet
 *  included. */
/** `kept`: your other wallets and your contacts, by your names for them. */
export type Shown = { site: SiteView; account: AccountView; signer: Signer; cluster: Cluster; known: Known; expiry?: Expiry | null; recipient?: string; later?: boolean; away?: boolean; kept?: Kept[] };

// Findings shown on the first step, before anything else: what you would lose, and a transaction that would fail.
const FIRST = new Set(['simulation-failed', 'wallet-change', 'owner-change', 'token-owner-change', 'authority-change', 'delegate', 'close-authority', 'program-change', 'lookalike-address']);

export function siteView(origin: string, site: Site | undefined): SiteView {
    const host = new URL(origin).host;
    const like = lookalike(host);
    if (site && site.signatures > 0) return { origin, host, note: `Connected · ${plural(site.signatures, 'signature')}`, tone: like ? 'warn' : 'plain' };
    const first = site ? 'Connected' : 'Not connected';
    return { origin, host, note: like ? `${first} · looks like ${like}` : first, tone: like ? 'warn' : 'plain' };
}
export const accountView = (a: Account): AccountView => ({ label: a.label, address: a.address });

/** Review, the transaction as prepared, and what else is shown → what the window shows. `p` null: shown as reviewed
 *  while it is being prepared, with nothing that preparing decides (guards, fee, hash, the verdict). */
export function describe(r: Review, p: Prepared | null, { site, account, signer, cluster, known, expiry = null, recipient, later = false, away = false, kept = [] }: Shown): TransactionView {
    const wallet = account.address as Address;
    const mainnet = cluster === 'solana:mainnet';
    const told = known.told ?? new Map();
    const named = selfNamed(r, told);
    const held = p !== null && p.unguarded === null && !later; // guards hold what it does, and it lands now
    const n = names(r, known, wallet, mainnet);
    const proposals = proposalViews(known.squads ?? [], n);
    const { verdict, findings } = ranked([...described(r.assessment.findings, named, r.assessment.programs, held), ...(p?.findings ?? []), ...imitations(known.tokens, mainnet), ...misread(known), ...proposedTo(proposals, r, wallet, kept)]);
    const note = (f: Finding) => noteOf(f, r, p, n);
    const view: Omit<TransactionView, 'kept'> = {
        kind: 'transaction',
        site,
        account,
        verdict,
        ...summary(verdict, findings),
        signer,
        network: mainnet && !away ? null : cluster.slice('solana:'.length),
        balances: balances(r, p, wallet, n, verdict),
        proposals,
        changes: findings.filter((f) => FIRST.has(f.code) && f.level !== 'ok').map((f) => ({ title: f.text, note: note(f), tone: f.level })),
        accounts: r.assessment.kinds.size,
        hash: p ? (p.hash.match(/.{1,4}/g)?.join(' ') ?? p.hash) : '', // of the message signed: the site's, with guards and fees when prepared
        wire: p ? getBase64Decoder().decode(p.bytes) : '',
        counts: { programs: r.assessment.programs.length, instructions: r.message.instructions.length, inner: r.simulation.inner.reduce((k, g) => k + g.calls.length, 0) },
        programs: programs(r, findings, names(r, known, wallet, mainnet, true), verdict, told, named),
        findings: findings.map((f) => ({ tone: f.level, title: f.text, note: note(f) })),
        fee: p ? `${sol(p.fee)} SOL` : '',
        guards: p ? guards(p) : { held: false, text: '' },
        added: p ? added(p, r.message.version === 1) : [],
        cluster,
        expiry,
        ...(recipient !== undefined && { recipient }),
        ...(p === null && { preparing: true as const }),
    };
    return { ...view, kept: keptIn(view, kept.filter((k) => k.address !== wallet)) }; // yours in use is "you"
}

// Who a Squads proposal you vote on would pay, or make a member or a spender, when that one only looks like an address you
// keep, one of your wallets or one you sent to: the review reads proposals apart, so it is checked here, before the vote.
function proposedTo(proposals: ProposalView[], r: Review, wallet: Address, kept: Kept[]): Finding[] {
    const said = new Set(r.assessment.findings.filter((f) => f.code === 'lookalike-address').map((f) => f.subject));
    const parties = proposals.flatMap((p) => p.lines.flatMap((l) => partiesOf(l.text).parties)).filter((a) => !said.has(a as Address)) as Address[];
    const of = (kind: Kept['kind']) => kept.filter((k) => k.kind === kind);
    return lookalikes(parties, { wallet, wallets: of('wallet').map((k) => k.address as Address), contacts: new Map(of('contact').map((k) => [k.address as Address, k.label])), sent: of('sent').map((k) => k.address as Address) });
}

// The verdict in words: its title, what the findings come to, and the chip beside the steps.
function summary(verdict: Verdict, findings: Finding[]): Pick<TransactionView, 'title' | 'sub' | 'chip'> {
    const count = (level: Level) => findings.filter((f) => f.level === level).length;
    const [danger, warn, notice] = [count('danger'), count('warn'), count('notice')];
    const notices = notice ? plural(notice, 'notice') : '';
    if (verdict === 'danger') return { title: 'Not safe', sub: [`${danger} critical`, warn && plural(warn, 'warning'), notices].filter(Boolean).join(' · '), chip: { text: `${danger} critical`, tone: 'danger' } };
    if (verdict === 'warn') return { title: 'Caution', sub: `${plural(warn, 'warning')} · nothing critical`, chip: { text: plural(warn, 'warning'), tone: 'warn' } };
    if (notice) return { title: 'Looks safe', sub: notices, chip: { text: notices, tone: 'notice' } };
    return { title: 'Looks safe', sub: 'No warnings', chip: { text: 'All clear', tone: 'ok' } };
}

/** Why a transfer a Ledger shows in clear goes without guards: its own screen shows it whole. */
export const LEDGER_CLEAR = 'its Ledger shows it in clear';

// Why Otus left a transaction as it came that go without saying: nothing to hold, or a failure the verdict says already.
const UNSAID = new Set([NOTHING_TO_HOLD, SIMULATION_FAILED]);

// Whether guards hold the outcome, in words. Left as it came (no limits set either), why, unless it goes without
// saying; one Otus set limits on and needs none (its own that only takes access back, a transfer a Ledger shows in
// clear) says nothing of them.
function guards(p: Prepared): TransactionView['guards'] {
    if (p.unguarded === null) return { held: true, text: p.holds.length === 1 ? 'One guard locks your account to what you see' : `${p.holds.length} guards lock your accounts to what you see` };
    if (p.units !== null || UNSAID.has(p.unguarded)) return { held: false, text: '' };
    return { held: false, text: `None: ${p.unguarded}`, why: p.unguarded };
}

// What Otus added to the transaction, or changed in it: its guards, and the limits and priority fee it set, in the
// message itself for v1, in Compute Budget instructions for legacy and v0.
function added(p: Prepared, v1: boolean): string[] {
    const out: string[] = [];
    if (p.holds.length > 0) out.push(`Lighthouse: ${p.holds.length === 1 ? 'one guard' : `${p.holds.length} guards`} on your accounts`);
    if (p.units === null) return out;
    const set = [`${p.units.toLocaleString('en-US')} compute units`];
    if (p.room !== null) set.push(`${Math.ceil(p.room / 1024).toLocaleString('en-US')} KiB of account data`);
    if (p.priority) set.push(`${sol(p.priority)} SOL priority fee`);
    const said = set.length > 1 ? `${set.slice(0, -1).join(', ')} and ${set.at(-1)}` : set[0];
    out.push(v1 ? said : `Compute Budget: ${said}`);
    return out;
}
