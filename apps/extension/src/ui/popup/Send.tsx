// Sending: an asset you hold, how much, and to whom. Otus builds the transfer and the background reviews it as any
// site's, guards included; the review shows here, the same as a site's in its window, with the time left to sign. Once
// signed, it stays here until it lands or fails, and a transfer that did not go builds again with one click.
import { getAddressDecoder, getBase64Decoder, getBase64Encoder, isAddress, isOffCurveAddress, type Address, type Blockhash } from '@solana/kit';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';

import { cap } from '@otus-wallet/sdk/format';
import { isTokenProgram, TOKEN_2022_PROGRAM_ADDRESS } from '@otus-wallet/sdk/programs/addresses';
import { rpcAt } from '@otus-wallet/sdk/rpc';
import { platform, type Changes, type Port } from '../../platform.ts';
import { SIGN_WITHIN } from '../../send/lifetime.ts';
import { feeOn, transfer, unplain, units as unitsOf, type Asset, type Lifetime, type Recipient } from '../../send/transfer.ts';
import { explorerOf, networkOf, walletRpc, type Settings } from '../../settings.ts';
import { acquaintance, lookalike, named, nameTaken, onDevice, type Account, type Contact, type State } from '../../shell/state.ts';
import { Button } from '../components/ui/button.tsx';
import { Input } from '../components/ui/input.tsx';
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from '../components/ui/select.tsx';
import { Icon, Tile } from '../components/icons.tsx';
import { short } from '../dom.ts';
import { cn } from '../lib/cn.ts';
import type { Holding } from '../holdings.ts';
import { Approve } from '../review/Approve.tsx';
import { Answer, Frame, Left, Steps, useNow } from '../review/Frame.tsx';
import { filled, MARK } from '../review/tone.ts';
import { To } from '../review/Transaction.tsx';
import type { AccountView, Approval, Life, SiteView, Tone } from '../view.ts';
import type { Screen } from './App.tsx';
import { Bar, ErrorLine, Heading, Sheet, TokenLogo } from './common.tsx';
import { amount, decimal, dollars, NOTHING } from './money.ts';
import { current, edit, said, useHoldings } from './store.ts';

const RESERVE = 2_000_000n; // lamports Max leaves for the fee, a priority fee, and the wallet's own rent
const SYSTEM = '11111111111111111111111111111111';
const LOOK_AFTER = 200; // ms after the last keystroke
const REVIEW_WAIT = 60_000; // ms for the review to come; each RPC request gives up sooner
const OWN_SITE: SiteView = { origin: 'otus://popup', host: 'Otus', note: 'Your own transfer', tone: 'plain' };
// No blockhash yet: the background reads one while it reviews the transfer, and puts it in.
const UNSET: Lifetime = { blockhash: '11111111111111111111111111111111' as Blockhash, lastValidBlockHeight: 0n };
const keyOf = (a: Holding) => (a.native ? 'native' : a.mint); // SOL and wrapped SOL share a mint, and are two assets
const nameOf = (a: Holding) => (a.native ? 'SOL' : a.symbol || short(a.mint));

// What was typed for a wallet, kept while the popup is open, across screens.
let draft = { account: '', asset: 'native', amount: '', to: '' };

// What the background says on the transfer's port: its review, a program added to the wallet's list, or how it ended.
type Reply = { ok: boolean; error?: string; result?: { signature?: unknown; outcome?: unknown } };
type Heard = { review: Approval } | { life: Life } | { done: Reply };
// One transfer as asked: built again as it is when it did not go, or ran out of time.
type Request = { to: Address; recipient: Recipient; asset: Asset; units: bigint };
// The review on show: at once on Send, with the recipient; then the review; then, once signed, how it goes.
type Shown = { request: Request; lifetime: { from: number; until: number } | null; approval: Approval | null; outcome: 'sending' | Reply | null; life?: Life };
// The account at the address typed, read once typing stops: who gets it is known before Send.
type Looked = { found: Found } | { failed: string };
type Found = { owner: string; data: readonly [string, string] } | null;

export function Send({ state, go }: { state: State; go: (to: Screen) => void }) {
    const account = current(state);
    const rpc = walletRpc(state.settings);
    const r = useHoldings(rpc, account.address, networkOf(state.settings) === 'solana:mainnet');
    if (draft.account !== account.address) draft = { account: account.address, asset: 'native', amount: '', to: '' };
    const [typed, setTyped] = useState(draft);
    const [failure, setFailure] = useState('');
    const [shown, setShown] = useState<Shown | null>(null);
    const attempt = useRef(0); // the build that counts: one rejected or left before its review came is dropped
    const waiting = useRef<Port | null>(null); // the port of the review on show, until answered
    const sending = useRef<Port | null>(null); // the port of a signed transfer, until it lands or fails
    const approvedAt = useRef(0); // when the transfer on its way was approved: what the background kept before is another's
    useEffect(() => () => (attempt.current++, waiting.current?.disconnect()), []); // leaving says no
    // A transfer left not confirmed yet, as when Otus stopped while sending it: the background that starts again checks
    // it, and what it finds shows here.
    const unsure = shown?.outcome && shown.outcome !== 'sending' && shown.outcome.ok && shown.outcome.result?.outcome === 'unknown' ? shown.outcome.result.signature : null;
    useEffect(() => {
        if (typeof unsure !== 'string') return;
        const heard = (changes: Changes, area: string) => {
            const last = changes.lastTransfer?.newValue as Reply | undefined;
            if (area === 'session' && last?.ok === true && last.result?.signature === unsure && last.result.outcome !== 'unknown') setShown((s) => s && { ...s, outcome: last });
        };
        platform.storage.onChanged.addListener(heard);
        return () => platform.storage.onChanged.removeListener(heard);
    }, [unsure]);
    const address = typed.to.trim();
    const settled = useSettled(address, LOOK_AFTER);
    // Tried again a little later when it fails, as any read; the answer for an address stays known a while.
    const lookup = useQuery({
        queryKey: ['account', rpc, settled],
        queryFn: async (): Promise<Found> => (await rpcAt(rpc).getAccountInfo(settled as Address, { encoding: 'base64', commitment: 'confirmed' }).send()).value,
        enabled: isAddress(settled) && settled !== account.address,
        staleTime: 30_000,
    });
    // A Token-2022 token's mint, read once picked: some can't go in a plain transfer.
    const token = r === undefined || r instanceof Error ? undefined : r.assets.find((a) => !a.native && keyOf(a) === typed.asset);
    const mint = useQuery({
        queryKey: ['mint', rpc, token?.mint],
        queryFn: async () => ({ mint: token!.mint, account: (await rpcAt(rpc).getAccountInfo(token!.mint as Address, { encoding: 'base64', commitment: 'confirmed' }).send()).value }),
        enabled: token?.source?.program === TOKEN_2022_PROGRAM_ADDRESS,
        staleTime: 300_000,
    });
    const update = (part: Partial<typeof draft>) => {
        draft = { ...draft, ...part };
        setTyped(draft);
        setFailure('');
    };
    const back = (why: string) => ((waiting.current = null), setShown(null), setFailure(why));

    // Builds the transfer and has the background review it, on a port of its own; the background puts in a fresh
    // blockhash, read while it reviews. A review on show is dropped first: building again says no to it.
    const start = async (request: Request) => {
        const mine = ++attempt.current;
        waiting.current?.disconnect();
        waiting.current = null;
        setShown({ request, lifetime: null, approval: null, outcome: null });
        try {
            const from = Date.now(); // before the blockhash is read: the time to sign counted short, never long
            const bytes = await transfer(account.address, request.recipient, request.asset, request.units, UNSET, onDevice(account) ? 0 : 1);
            if (attempt.current !== mine) return;
            setShown((s) => s && { ...s, lifetime: { from, until: from + SIGN_WITHIN } });
            const port = platform.connect('own');
            waiting.current = port;
            const late = setTimeout(() => waiting.current === port && (port.disconnect(), back('Otus did not answer in time: nothing was sent')), REVIEW_WAIT);
            port.onMessage.addListener((m: Heard) => {
                clearTimeout(late);
                if ('review' in m) return setShown((s) => s && { ...s, approval: m.review });
                if ('life' in m) return setShown((s) => s && { ...s, life: m.life }); // its blockhash's, by the network's word
                port.disconnect();
                if (waiting.current === port) return back(m.done.error ?? 'Otus could not send it'); // refused before any answer
                if (sending.current !== port) return;
                sending.current = null;
                setShown((s) => s && { ...s, outcome: m.done });
            });
            port.onDisconnect.addListener(() => {
                clearTimeout(late);
                if (waiting.current === port) return back('Otus stopped before you answered: nothing was sent');
                if (sending.current !== port) return;
                sending.current = null;
                void platform.storage.session.get('lastTransfer').then(({ lastTransfer }) => setShown((s) => s && { ...s, outcome: stopped(lastTransfer, approvedAt.current) }));
            });
            port.postMessage({ own: getBase64Decoder().decode(bytes), account: account.address, to: request.to });
        } catch (e) {
            if (attempt.current === mine) back(said(e));
        }
    };

    if (shown) {
        // No goes back to the form as it was; yes stays here while it goes, and says how it went.
        const answer = (yes: boolean, signature?: string) => {
            const port = waiting.current;
            waiting.current = null;
            attempt.current++;
            if (!yes || !port) return void (port?.disconnect(), setShown(null)); // a port closed says no
            sending.current = port;
            approvedAt.current = Date.now();
            try {
                port.postMessage({ approve: true, ...(signature && { signature }) });
            } catch {
                return back('Otus stopped before you answered: nothing was sent'); // the port went the moment before
            }
            setShown((s) => s && { ...s, outcome: 'sending' });
        };
        const view = { label: account.label, address: account.address };
        const again = () => void start(shown.request);
        const { outcome } = shown;
        if (outcome) {
            // Seen here, the outcome needs no banner in the lobby; one still on its way, or not confirmed yet, keeps it.
            const leave = (sent: boolean) => {
                const unknown = outcome === 'sending' || (outcome.ok && outcome.result?.outcome === 'unknown');
                if (!unknown) void platform.storage.session.remove('lastTransfer');
                if (sent) draft = { account: account.address, asset: 'native', amount: '', to: '' };
                if (sent) go('activity'); // where it now shows
                else if (outcome === 'sending') go('lobby');
                else setShown(null);
            };
            return <Outcome account={view} to={shown.request.to} outcome={outcome} leave={leave} again={again} settings={state.settings} />;
        }
        const expiry = shown.lifetime ? { ...shown.lifetime, refresh: again } : undefined;
        if (!shown.approval) return <Pending account={view} to={shown.request.to} lifetime={shown.lifetime} reject={() => answer(false)} />;
        return <Approve approval={shown.approval} answers={{ answer }} expiry={expiry} life={shown.life} />;
    }

    if (r instanceof Error) {
        return (
            <Sheet bar={<Bar title="Send" back={() => go('lobby')} />}>
                <p className="text-[10.5px] text-warn">{`Your RPC did not answer: ${said(r)}`}</p>
                <Button size="sm" className="self-start" onClick={() => go('settings')}>
                    Settings
                </Button>
            </Sheet>
        );
    }
    // While the balances are read, the form shows zeros and waits to check amounts.
    const known = r !== undefined;
    const assets = (r ?? NOTHING).assets.filter((a) => a.native || (a.units > 0n && a.source));
    const picked = assets.find((a) => keyOf(a) === typed.asset);
    const chosen = picked ?? assets[0];
    // A token is sent from the one account of yours that holds most of it.
    const available = chosen.native ? (chosen.units > RESERVE ? chosen.units - RESERVE : 0n) : (chosen.source?.units ?? 0n);
    const minted = mint.data?.account && picked?.mint === mint.data.mint ? getBase64Encoder().encode(mint.data.account.data[0]) : null;
    const unsendable = minted ? unplain(minted) : null;
    const amountText = typed.amount.trim();
    const units = amountText ? unitsOf(amountText, chosen.decimals) : null;
    const fee = minted && units !== null ? feeOn(minted, units) : 0n; // what the token's transfer fee keeps
    // Who gets it, once the account at the address typed is read; an address no one holds a key for, or a program's
    // account, is said before Send.
    const look = lookedAt(address, settled, lookup);
    let recipient: Recipient | null = null;
    let refused = '';
    if (look && 'found' in look) {
        try {
            recipient = recipientOf(address as Address, look.found, chosen);
        } catch (e) {
            refused = said(e);
        }
    }
    const odd = look !== null && 'found' in look && recipient !== null && unheld(recipient, look.found);
    const like = isAddress(address) ? lookalike(state, address) : null;
    const problem = unsendable ?? problemOf({ known, picked: picked !== undefined, chosen, amountText, units, available, address, wallet: account.address, look, refused });
    const ready = known && units !== null && !problem && recipient !== null;
    const send = () => {
        if (!ready || recipient === null || units === null) return;
        const asset: Asset = chosen.native ? { kind: 'sol' } : { kind: 'token', mint: chosen.mint as Address, program: chosen.source!.program, source: chosen.source!.account, decimals: chosen.decimals };
        void start({ to: address as Address, recipient, asset, units });
    };
    const others = state.accounts.filter((a) => a.address !== account.address);
    const contacts = state.contacts.filter((c) => !state.accounts.some((a) => a.address === c.address));

    return (
        <Sheet bar={<Bar title="Send" back={() => go('lobby')} />} className="send">
            <div className="flex flex-col gap-1.5">
                <Heading>Asset</Heading>
                <Select value={keyOf(chosen)} onValueChange={(asset) => update({ asset, amount: '' })}>
                    <SelectTrigger aria-label="Asset" className="h-[34px] w-full bg-panel text-xs">
                        <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                        {assets.map((a) => (
                            <SelectItem key={keyOf(a)} value={keyOf(a)} className="text-xs">
                                <TokenLogo asset={a} size={18} />
                                {`${nameOf(a)} · ${amount(a)}${a.verified ? '' : ' · unverified'}`}
                            </SelectItem>
                        ))}
                    </SelectContent>
                </Select>
            </div>
            <div className="flex flex-col gap-1.5">
                <Heading
                    extra={
                        <Button size="xs" onClick={() => update({ amount: decimal(available, chosen.decimals) })}>
                            Max
                        </Button>
                    }
                >
                    Amount
                </Heading>
                <Input inputMode="decimal" placeholder="0" autoComplete="off" spellCheck={false} aria-label="Amount" autoFocus value={typed.amount} onChange={(e) => update({ amount: e.target.value })} />
                {units !== null && <p className="text-[10.5px] text-ink-3">{`You send ${decimal(units, chosen.decimals)} ${nameOf(chosen)}${chosen.price === null ? '' : ` · ≈ ${dollars((Number(units) / 10 ** chosen.decimals) * chosen.price)}`}`}</p>}
                {fee > 0n && <p className="text-[10.5px] text-warn">{`The token's transfer fee keeps up to ${decimal(fee, chosen.decimals)}: they get the rest`}</p>}
            </div>
            <div className="flex flex-col gap-1.5">
                <Heading>To</Heading>
                <div className="flex gap-1.5">
                    <Input placeholder="Solana address" autoComplete="off" spellCheck={false} aria-label="To" className="min-w-0 flex-1" value={typed.to} onChange={(e) => update({ to: e.target.value })} />
                    {others.length + contacts.length > 0 && <Recipients accounts={others} contacts={contacts} pick={(to) => update({ to })} />}
                </div>
                {isAddress(address) && address !== account.address && <Acquainted key={address} address={address} state={state} like={like} />}
                {odd && <p className="text-[10.5px] text-warn">This address belongs to a program, not to someone with a key: what you send may not come back.</p>}
            </div>
            <ErrorLine>{problem || failure}</ErrorLine>
            <Button variant="default" disabled={!ready} onClick={send}>
                {odd || like ? 'Send anyway' : 'Send'}
            </Button>
        </Sheet>
    );
}

// A value once it stops changing for `ms`: the address looked up once typing stops.
function useSettled<T>(value: T, ms: number): T {
    const [settled, setSettled] = useState(value);
    useEffect(() => {
        const t = setTimeout(() => setSettled(value), ms);
        return () => clearTimeout(t);
    }, [value, ms]);
    return settled;
}

// What the lookup says of the address as typed now: nothing while it is typed or read, or tried again.
function lookedAt(address: string, settled: string, lookup: { data?: Found; isError: boolean; error: unknown }): Looked | null {
    if (settled !== address) return null;
    if (lookup.data !== undefined) return { found: lookup.data };
    if (lookup.isError) return { failed: said(lookup.error) };
    return null;
}

// What keeps the form from going on, in words, checked in the order it is read; empty when nothing does.
function problemOf(f: { known: boolean; picked: boolean; chosen: Holding; amountText: string; units: bigint | null; available: bigint; address: string; wallet: string; look: Looked | null; refused: string }): string {
    const { chosen, available } = f;
    if (f.known && !f.picked) return 'You no longer hold the token you picked';
    if (f.amountText.includes(',')) return 'Use a point for decimals: 0.05, not 0,05';
    if (f.amountText && f.units === null) return `An amount above 0, with at most ${chosen.decimals} decimals`;
    if (f.known && f.units !== null && f.units > available) {
        if (chosen.native) return `At most ${decimal(available, 9)} SOL: some stays for fees`;
        if (available < chosen.units) return `At most ${decimal(available, chosen.decimals)} at once: your ${nameOf(chosen)} is in more than one account`;
        return `More than you hold: ${amount(chosen)} ${nameOf(chosen)}`;
    }
    if (f.address && !isAddress(f.address)) return 'Not a Solana address';
    if (f.address === f.wallet) return 'That is this wallet';
    if (f.look && 'failed' in f.look) return `Your RPC did not answer: ${f.look.failed}`;
    return f.refused;
}

// Your other wallets and the addresses you know, any of them a recipient: picked from beside the address field.
function Recipients({ accounts, contacts, pick }: { accounts: Account[]; contacts: Contact[]; pick: (address: string) => void }) {
    const item = (a: Account | Contact) => (
        <SelectItem key={a.address} value={a.address} className="text-xs">
            <span className="flex items-center gap-2">
                <Tile address={a.address} size={14} />
                <span className="font-bold">{a.label}</span>
                <span className="text-ink-3">{short(a.address)}</span>
            </span>
        </SelectItem>
    );
    const group = (title: string, list: (Account | Contact)[]) =>
        list.length > 0 && (
            <SelectGroup>
                <SelectLabel className="px-2 pt-2 pb-1 text-[10px] font-bold text-ink-3">{title}</SelectLabel>
                {list.map(item)}
            </SelectGroup>
        );
    return (
        <Select value="" onValueChange={pick}>
            <SelectTrigger aria-label="Recipients" className="h-[34px] w-auto shrink-0 gap-1 bg-panel px-2.5">
                <Icon name="book" size={14} />
            </SelectTrigger>
            <SelectContent position="popper" align="end">
                {group('Your wallets', accounts)}
                {group('Known addresses', contacts)}
            </SelectContent>
        </Select>
    );
}

// What Otus knows of the address typed: one of your wallets, one you know, how many times you sent to it; that it
// only looks like one of those (`like`); or that you never sent there, to check it before sending. One you sent to can
// be kept from here, by a name.
function Acquainted({ address, state, like }: { address: Address; state: State; like: { label: string | null } | null }) {
    const known = acquaintance(state, address);
    const [naming, setNaming] = useState(false);
    const times = known.sent === 1 ? 'once' : `${known.sent} times`;
    if (like) {
        // A known address looks like it: forged, or this one is, if it was kept or sent to.
        const other = like.label ? `${like.label}'s address` : 'an address you sent to';
        return <Hint tone="danger">{known.as || known.sent ? `This looks like ${other}: one of them may be forged. Check every character.` : `Looks like ${other}, but it isn't. Check every character.`}</Hint>;
    }
    if (known.as === 'account') return <Hint>{`Your wallet ${known.label}`}</Hint>;
    if (known.as === 'watched') return <Hint>{`A wallet you watch: ${known.label}`}</Hint>;
    if (known.as === 'contact') return <Hint tone="ok">{`Known: ${known.label} · ${known.sent ? `sent ${times}` : 'never sent from Otus'}`}</Hint>;
    if (known.sent === 0) return <Hint tone="warn">You've never sent here from Otus. Double-check it.</Hint>;
    if (naming) return <Naming address={address} state={state} done={() => setNaming(false)} />;
    return (
        <div className="flex items-center justify-between gap-2">
            <Hint>{`Sent ${times} from Otus`}</Hint>
            <Button size="xs" onClick={() => setNaming(true)}>
                Add to known
            </Button>
        </div>
    );
}

const HINT = { ok: 'text-ok', warn: 'text-warn', danger: 'text-danger', plain: 'text-ink-3' };
const Hint = ({ tone = 'plain', children }: { tone?: keyof typeof HINT; children: string }) => <p className={cn('text-[10.5px]', HINT[tone])}>{children}</p>;

// A name for an address you sent to, to keep it among the ones you know.
function Naming({ address, state, done }: { address: Address; state: State; done: () => void }) {
    const [label, setLabel] = useState('');
    const [error, setError] = useState('');
    const keep = async () => {
        const name = named(label);
        if (!name) return;
        if (nameTaken(state, name, address)) return setError(`You have one named ${name} already`);
        const reply = (await edit({ edit: 'keep', address, label })) as { ok: boolean; error?: string } | undefined;
        if (reply && !reply.ok) return setError(reply.error ?? 'Otus could not save it');
        done();
    };
    return (
        <>
            <div className="flex gap-1.5">
                <Input placeholder="Its name" aria-label="Name" autoFocus maxLength={32} spellCheck={false} autoComplete="off" className="h-[30px] min-w-0 flex-1 text-xs" value={label} onChange={(e) => (setLabel(e.target.value), setError(''))} onKeyDown={(e) => (e.key === 'Enter' ? void keep() : e.key === 'Escape' && done())} />
                <Button size="sm" variant="default" disabled={!named(label)} onClick={() => void keep()}>
                    Keep
                </Button>
                <Button size="sm" onClick={done}>
                    Cancel
                </Button>
            </div>
            <ErrorLine>{error}</ErrorLine>
        </>
    );
}

// The review's frame at once, with the recipient, while the background simulates the transfer: Next waits for it.
function Pending({ account, to, lifetime, reject }: { account: AccountView; to: string; lifetime: Shown['lifetime']; reject: () => void }) {
    const now = useNow(lifetime ? 250 : null);
    const actions = (
        <>
            <Answer onClick={reject}>Reject</Answer>
            <Answer variant="default" disabled onClick={() => {}}>
                Next
            </Answer>
        </>
    );
    return (
        <Frame site={OWN_SITE} account={account} network={null} steps={<Steps at={0} />} left={lifetime && <Left from={lifetime.from} until={lifetime.until} now={now} />} actions={actions}>
            <To address={to} />
        </Frame>
    );
}

// A signed transfer, in the same frame: on its way, then sent, failed onchain, or not sent. One that did not go builds
// again with a fresh blockhash.
function Outcome({ account, to, outcome, leave, again, settings }: { account: AccountView; to: string; outcome: 'sending' | Reply; leave: (sent: boolean) => void; again: () => void; settings: Settings }) {
    const signature = outcome !== 'sending' && typeof outcome.result?.signature === 'string' ? outcome.result.signature : null;
    const [tone, title, words] = told(outcome);
    const actions = () => {
        if (outcome === 'sending') return <Answer onClick={() => leave(false)}>Close</Answer>;
        if (outcome.ok && outcome.result?.outcome !== 'failed') {
            return (
                <Answer variant="default" onClick={() => leave(true)}>
                    Done
                </Answer>
            );
        }
        return (
            <>
                <Answer onClick={() => leave(false)}>Back</Answer>
                <Answer variant="default" onClick={again}>
                    Try again
                </Answer>
            </>
        );
    };
    return (
        <Frame site={OWN_SITE} account={account} network={null} actions={actions()}>
            <To address={to} />
            <div role="status" className={`outcome flex items-center gap-3 rounded-[3px] border p-3.5 ${tone === 'plain' ? 'border-rule text-ink' : `border-current ${filled(tone)}`}`}>
                <Icon name={outcome === 'sending' ? 'refresh' : MARK[tone]} size={28} stroke={2.5} />
                <div className="flex min-w-0 flex-col gap-1">
                    <p className="title pixel text-[22px] leading-[1.1]">{title}</p>
                    <p className="font-bold">{words}</p>
                    {signature && (
                        <a href={explorerOf(settings).tx(signature)} target="_blank" rel="noreferrer" className="inline-flex items-center gap-[3px] text-[11px] font-bold text-inherit">
                            {short(signature)}
                            <Icon name="external" size={11} stroke={2.5} />
                        </a>
                    )}
                </div>
            </div>
        </Frame>
    );
}

// What an outcome says: its tone, its title and its words.
function told(outcome: 'sending' | Reply): [Tone, string, string] {
    if (outcome === 'sending') return ['plain', 'Sending', 'Signed. The network confirms it in a few seconds.'];
    if (!outcome.ok) return ['danger', 'Not sent', cap(outcome.error ?? 'it failed')];
    if (outcome.result?.outcome === 'confirmed') return ['ok', 'Sent', 'Confirmed by the network.'];
    if (outcome.result?.outcome === 'failed') return ['danger', 'Failed onchain', 'It landed and failed: only the fee was spent.'];
    return ['warn', 'Not confirmed yet', 'It may still land: check it before sending again.'];
}

// Where no one's key is: a wallet address off the curve or held by a program, or a token account such an address owns.
function unheld(recipient: Recipient, found: Found): boolean {
    if (recipient.kind === 'token-account') return found !== null && isOffCurveAddress(getAddressDecoder().decode(getBase64Encoder().encode(found.data[0]), 32));
    return isOffCurveAddress(recipient.address) || (found !== null && found.owner !== SYSTEM);
}

// What a transfer cut short while sending comes to, from what the background kept of it since it was approved: signed,
// it may have gone out, so not confirmed yet, or how it went once a background checked it; not signed, nothing was sent.
function stopped(last: unknown, since: number): Reply {
    const l = last as { ok?: boolean; at?: unknown; signature?: unknown; result?: { signature?: unknown; outcome?: unknown } } | undefined;
    if (typeof l?.at !== 'number' || l.at < since) return { ok: false, error: 'Otus stopped before it was signed: nothing was sent' }; // another transfer's
    if (l.ok === true && typeof l.result?.signature === 'string') return { ok: true, result: l.result };
    if (typeof l?.signature === 'string') return { ok: true, result: { signature: l.signature, outcome: 'unknown' } };
    return { ok: false, error: 'Otus stopped before it was signed: nothing was sent' };
}

// Who gets it: a wallet, or for a token, a token account named directly, which must hold that same token.
function recipientOf(address: Address, found: Found, chosen: Holding): Recipient {
    if (!found || !isTokenProgram(found.owner)) return { kind: 'wallet', address };
    const data = getBase64Encoder().encode(found.data[0]);
    if (data.length === 355) throw new Error('This is a token multisig, not someone to send to');
    if (data.length === 82 || (data.length > 165 && data[165] === 1)) throw new Error('This address is a token mint, not someone to send to');
    if (data.length < 165) throw new Error('This address is no token account anyone can receive with');
    if (chosen.native) throw new Error('This is a token account: send SOL to its owner’s address');
    if (getAddressDecoder().decode(data, 0) !== chosen.mint) throw new Error(`This token account holds another token than ${nameOf(chosen)}`);
    return { kind: 'token-account', address };
}
