// The lobby: everything on it belongs to the wallet in use. Its icon opens what you can do with it; its name, the list
// of all wallets. The balance in the middle, Receive, Send and Swap under it, then the wallet's tokens; at the bottom,
// the way to its activity and to settings.
import { useEffect, useState } from 'react';

import { explorerOf, networkName, networkOf, walletRpc, type Settings } from '../../settings.ts';
import { signs, type State } from '../../shell/state.ts';
import { Button } from '../components/ui/button.tsx';
import { Icon, Tile } from '../components/icons.tsx';
import { short } from '../dom.ts';
import type { Holding } from '../holdings.ts';
import { cn } from '../lib/cn.ts';
import type { Screen } from './App.tsx';
import { CopyAddress, IconButton, Seal, TabBar, Tip, TokenLogo, Trend } from './common.tsx';
import { amount, balanceSize, dayChange, dollars, NOTHING, price, trendOf } from './money.ts';
import { current, said, useHoldings } from './store.ts';

export function Lobby({ state, go }: { state: State; go: (to: Screen) => void }) {
    const account = current(state);
    const mainnet = networkOf(state.settings) === 'solana:mainnet';
    const r = useHoldings(walletRpc(state.settings), account.address, mainnet);
    const read = r && !(r instanceof Error) ? r : null;
    const { usd, sol, assets } = read ?? NOTHING; // while it is read, or when it cannot be: zeros, in grey
    const day = mainnet && read && dayChange(read);
    // Off mainnet nothing has a price: the balance is its SOL.
    const total = mainnet ? dollars(usd) : `${amount({ units: sol, decimals: 9 })} SOL`;
    return (
        <main className="flex h-full flex-col">
            <WalletBar state={state} go={go} />
            <Banner settings={state.settings} />
            <section className="scroll flex min-h-0 flex-1 flex-col gap-2.5 px-4 pt-1.5 pb-3.5">
                <div className={cn('balance flex flex-col items-center gap-1.5 pt-[22px] pb-2.5 text-center', !read && 'unread')}>
                    <p className={cn('usd leading-[1.05] font-extrabold tracking-[-0.02em]', !read && 'text-ink-3')} style={{ fontSize: `${balanceSize(total)}px` }}>
                        {total}
                    </p>
                    {day && (
                        <Tip text="Last 24 hours">
                            <p className={cn('day inline-flex cursor-default items-center gap-2 text-[14px] font-bold', { up: 'text-ok', down: 'text-danger', flat: 'text-ink-3' }[trendOf(day.percent).way])}>
                                {`${day.delta < 0 ? '−' : '+'}${dollars(Math.abs(day.delta))}`}
                                <Trend change={day.percent} className="px-[7px] text-[11.5px]" />
                            </p>
                        </Tip>
                    )}
                    {r instanceof Error && <p className="text-[10.5px] text-warn">{`${{ custom: 'Your RPC', devnet: "Solana's devnet RPC", mainnet: "Otus's RPC" }[state.settings.network]} did not answer: ${said(r)}`}</p>}
                    {(!signs(account) || r instanceof Error) && (
                        <div className="mt-1.5 flex items-center justify-center gap-2">
                            {!signs(account) && (
                                <span className="inline-flex items-center gap-1 rounded-[3px] border border-current px-[7px] py-0.5 text-[10.5px] font-bold uppercase">
                                    <Icon name="eye" size={11} stroke={2.5} />
                                    Watch only
                                </span>
                            )}
                            {r instanceof Error && (
                                <Button size="sm" onClick={() => go('settings')}>
                                    Settings
                                </Button>
                            )}
                        </div>
                    )}
                </div>
                <div className="acts flex gap-2 pt-1 pb-1.5">
                    <Act name="receive" label="Receive" onClick={() => go('receive')} />
                    <Act name="send" label="Send" onClick={signs(account) ? () => go('send') : undefined} tip={signs(account) ? undefined : 'Watch only: Otus holds no key for it'} />
                    <Act name="swap" label="Swap" soon />
                    <Act name="stake" label="Stake" onClick={() => go('stake')} />
                </div>
                <ul className={cn('assets', !read && 'unread')}>
                    {assets.filter((a) => a.verified).map((a) => <Asset key={a.native ? 'native' : a.mint} asset={a} dim={!read} />)}
                </ul>
                {assets.some((a) => !a.verified) && (
                    <>
                        <h2 className="pixel text-[10px] text-ink-2">Unverified</h2>
                        <ul className="assets unverified">
                            {assets.filter((a) => !a.verified).map((a) => <Asset key={a.mint} asset={a} />)}
                        </ul>
                    </>
                )}
            </section>
            <TabBar at="lobby" go={go} />
        </main>
    );
}

/** The wallet in use, on top of its lobby and its activity: its icon opens what you can do with it; its name, the list
 *  of all wallets; then copying its address, and how many times it signed with Otus. */
export function WalletBar({ state, go }: { state: State; go: (to: Screen) => void }) {
    const account = current(state);
    const network = networkOf(state.settings); // said beside the name when it is not mainnet
    const n = account.signatures ?? 0;
    return (
        <header className="flex items-center gap-1 border-b border-dashed border-rule px-2.5 pt-2.5 pb-2">
            <button type="button" aria-label="This wallet" onClick={() => go('wallet')} className="avatar grid size-9 shrink-0 cursor-pointer place-items-center rounded-md border border-rule bg-panel hover:border-ink-3">
                <Tile address={account.address} size={22} />
            </button>
            <button type="button" onClick={() => go('wallets')} className="wallet flex h-9 min-w-0 flex-1 cursor-pointer items-center justify-center gap-[7px] rounded-md border border-transparent hover:border-rule">
                {network !== 'solana:mainnet' && <span className="network shrink-0 rounded-[3px] border border-current px-1 py-px text-[9.5px] font-bold text-warn uppercase">{networkName(network)}</span>}
                <span className="max-w-[120px] truncate font-bold">{account.label}</span>
                <span className="text-[10.5px] whitespace-nowrap text-ink-2">{short(account.address)}</span>
                <Icon name="down" size={12} stroke={2.5} />
            </button>
            <CopyAddress address={account.address} />
            <Tip text={`${n} ${n === 1 ? 'signature' : 'signatures'} with Otus`}>
                <span tabIndex={0} className="prints inline-flex shrink-0 cursor-default items-center gap-1 px-1 text-[11px] font-bold text-ink-2">
                    <Icon name="fingerprint" size={15} />
                    {n}
                </span>
            </Tip>
        </header>
    );
}

// Receive, Send, Swap, Stake: an icon over its name in the pixel font; one that cannot be used yet says why, or "Soon".
function Act({ name, label, onClick, tip, soon = false }: { name: 'receive' | 'send' | 'swap' | 'stake'; label: string; onClick?: () => void; tip?: string; soon?: boolean }) {
    const off = !onClick;
    const act = (
        <button
            type="button"
            onClick={onClick}
            aria-disabled={off || undefined}
            className={cn('act relative flex h-[58px] flex-1 flex-col items-center justify-center gap-1.5 rounded-[3px] border border-rule bg-panel text-ink', off ? 'cursor-default text-ink-3' : 'cursor-pointer hover:border-ink-3')}
        >
            <Icon name={name} size={18} />
            <span className="pixel text-[10px] tracking-[0.04em]">{label}</span>
            {soon && <span className="pixel absolute top-[3px] right-[3px] rounded-sm border border-rule px-[2px] text-[7px] leading-[10px] text-ink-3">Soon</span>}
        </button>
    );
    return tip ? <Tip text={tip}>{act}</Tip> : act;
}

// One token: its name and seal; what you hold of it and its price; its value, and how its price moved in a day.
function Asset({ asset: a, dim = false }: { asset: Holding; dim?: boolean }) {
    const symbol = a.symbol || short(a.mint);
    return (
        <li className="asset flex items-center gap-3 border-t border-dashed border-rule-2 px-0.5 py-[11px]">
            <TokenLogo asset={a} />
            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="inline-flex items-center gap-1.5">
                    <span className="truncate font-bold">{a.native ? 'Solana' : symbol}</span>
                    {a.verified && <Seal symbol={a.native ? 'SOL' : symbol} />}
                </span>
                <span className="truncate text-[10.5px] text-ink-3">{`${amount(a)} ${symbol}${a.price === null ? '' : ` · ${price(a.price)}`}`}</span>
            </span>
            <span className="values flex shrink-0 flex-col items-end gap-0.5 text-right">
                <span className={cn('font-bold', dim && 'text-ink-3')}>{a.usd === null ? '—' : dollars(a.usd)}</span>
                {a.change !== null && <Trend change={a.change} />}
            </span>
        </li>
    );
}

// How the last transfer approved here goes: it may land after the popup closed, so the lobby says so when opened again.
type Last = { at: number; pending?: boolean; ok?: boolean; error?: string; result?: { signature?: unknown; outcome?: unknown } };

// What the banner says of the last transfer: its tone, its mark and its words.
function bannerOf(last: Last): ['ok' | 'danger' | 'plain', 'check' | 'bang' | 'refresh', string] {
    if (last.pending) return ['plain', 'refresh', 'Your transfer is on its way'];
    if (!last.ok) return ['danger', 'bang', `Not sent: ${last.error ?? 'it failed'}`];
    if (last.result?.outcome === 'failed') return ['danger', 'bang', 'It landed and failed onchain: only the fee was spent'];
    if (last.result?.outcome !== 'confirmed') return ['plain', 'refresh', 'Sent, not confirmed yet'];
    return ['ok', 'check', 'Sent'];
}

function Banner({ settings }: { settings: Settings }) {
    const [last, setLast] = useState<Last | null>(null);
    useEffect(() => {
        const read = () => chrome.storage.session.get('lastTransfer').then(({ lastTransfer }) => setLast((lastTransfer as Last | undefined) ?? null));
        const changed = (changes: Record<string, unknown>, area: string) => void (area === 'session' && 'lastTransfer' in changes && read());
        read();
        chrome.storage.onChanged.addListener(changed);
        return () => chrome.storage.onChanged.removeListener(changed);
    }, []);
    if (!last || Date.now() - last.at > 30 * 60_000) return null;
    const signature = typeof last.result?.signature === 'string' && /^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(last.result.signature) ? last.result.signature : null;
    const [tone, mark, words] = bannerOf(last);
    const style = { ok: 'border-ok-bd bg-ok-bg text-ok', danger: 'border-danger-bd bg-danger-bg text-danger', plain: 'border-rule' }[tone];
    return (
        <div role="status" className={cn('banner mx-3 mt-2 flex items-center gap-2 rounded-[3px] border py-1 pr-1 pl-2.5 text-[11px]', style)}>
            <Icon name={mark} size={13} stroke={2.5} />
            <span className="min-w-0 flex-1 truncate">
                {words}
                {last.ok && signature && (
                    <>
                        {' '}
                        <a href={explorerOf(settings).tx(signature)} target="_blank" rel="noreferrer" className="inline-flex items-center gap-[3px] font-bold text-inherit">
                            {short(signature)}
                            <Icon name="external" size={11} stroke={2.5} />
                        </a>
                    </>
                )}
            </span>
            <IconButton name="cross" label="Dismiss" className="size-[26px]" onClick={() => void chrome.storage.session.remove('lastTransfer')} />
        </div>
    );
}
