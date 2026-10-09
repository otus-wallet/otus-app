// Every setting lives here, and only here: auto-lock, the network, the explorer, preflight, the trusted apps and the
// addresses you know, as sections that open one at a time.
import { isAddress } from '@solana/kit';
import { useState, type ReactNode } from 'react';

import { rpcAt } from '@otus-wallet/sdk/rpc';
import { clusterOfGenesis, EXPLORERS, explorerOf, LOCK_CHOICES, MAX_LOCK_AFTER, networkName, networkOf, type Explorer, type Settings } from '../../settings.ts';
import type { KeyStatus } from '../../shell/keys.ts';
import { lookalike, named, nameTaken, type State } from '../../shell/state.ts';
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '../components/ui/accordion.tsx';
import { Button } from '../components/ui/button.tsx';
import { Input } from '../components/ui/input.tsx';
import { Icon, Tile } from '../components/icons.tsx';
import { ask } from '../ask.ts';
import { short } from '../dom.ts';
import type { Screen } from './App.tsx';
import { Bar, Choice, ErrorLine, Sheet, TabBar } from './common.tsx';
import { edit, said, setSettings } from './store.ts';

const REPO = 'https://github.com/otus-wallet/otus-extension';

export function Settings({ state, keys, go }: { state: State; keys: KeyStatus; go: (to: Screen) => void }) {
    const minutes = state.settings.lockAfter;
    const apps = Object.keys(state.sites).length;
    const network = networkName(networkOf(state.settings));
    return (
        <Sheet bar={<Bar title="Settings" />} foot={<TabBar at="settings" go={go} />}>
            <Accordion type="single" collapsible className="sections flex flex-col gap-2">
                {keys.vault && (
                    <Section id="lock" icon="lock" title="Auto-lock" value={minutes === 0 ? 'At once' : minutes === 60 ? '1 h' : `${minutes} min`}>
                        <AutoLock minutes={minutes} />
                    </Section>
                )}
                <Section id="network" icon="server" title="Network" value={state.settings.network === 'custom' ? `Custom · ${network}` : network}>
                    <NetworkChoice settings={state.settings} />
                </Section>
                <Section id="explorer" icon="external" title="Explorer" value={explorerOf(state.settings).name}>
                    <ExplorerChoice chosen={state.settings.explorer} />
                </Section>
                <Section id="preflight" icon="send" title="Preflight" value={state.settings.preflight === false ? 'Skipped' : 'On'}>
                    <Preflight on={state.settings.preflight !== false} />
                </Section>
                <Section id="apps" icon="shield" title="Trusted apps" value={apps === 0 ? 'None' : String(apps)}>
                    <TrustedApps sites={state.sites} />
                </Section>
                <Section id="known" icon="book" title="Known addresses" value={state.contacts.length === 0 ? 'None' : String(state.contacts.length)}>
                    <KnownAddresses state={state} />
                </Section>
            </Accordion>
            {keys.unlocked && (
                <Button className="w-full" onClick={() => void ask({ keys: 'lock' })}>
                    <Icon name="lock" size={14} />
                    Lock Otus now
                </Button>
            )}
            <footer className="mt-auto flex items-center justify-end gap-2.5">
                <span className="version text-[10.5px] font-bold text-ok">v{chrome.runtime.getManifest().version}</span>
                <a href={REPO} target="_blank" rel="noreferrer" aria-label="Otus Wallet on GitHub" className="text-ink-3 hover:text-ink">
                    <Icon name="github" size={15} />
                </a>
            </footer>
        </Sheet>
    );
}

function Section({ id, icon, title, value, children }: { id: string; icon: 'lock' | 'server' | 'external' | 'send' | 'shield' | 'book'; title: string; value: ReactNode; children: ReactNode }) {
    return (
        <AccordionItem value={id} className="section rounded-[3px] border border-rule-2 bg-panel last:border-b data-[state=open]:border-rule">
            <AccordionTrigger className="section-toggle min-h-[46px] cursor-pointer items-center gap-2.5 rounded-none px-3 py-0 hover:bg-hover">
                <Icon name={icon} size={15} className="text-ink-2" />
                <span className="flex-1 text-xs font-bold">{title}</span>
                <span className="max-w-[150px] truncate text-[10.5px] font-normal text-ink-3">{value}</span>
            </AccordionTrigger>
            <AccordionContent className="flex flex-col gap-2 border-t border-dashed border-rule-2 px-3 pt-3 pb-3.5">{children}</AccordionContent>
        </AccordionItem>
    );
}

// How long Otus stays unlocked once closed: its popup and setup tab. A site's requests and windows do not count.
function AutoLock({ minutes }: { minutes: number }) {
    const preset = LOCK_CHOICES.includes(minutes);
    const [custom, setCustom] = useState(false);
    const [typed, setTyped] = useState(preset ? '' : String(minutes));
    const [error, setError] = useState('');
    const set = (lockAfter: number) => (setCustom(false), void setSettings(() => ({ lockAfter })));
    const keep = () => {
        const n = Number(typed);
        if (!Number.isInteger(n) || n < 1 || n > MAX_LOCK_AFTER) return setError(`A whole number of minutes, from 1 to ${MAX_LOCK_AFTER}`);
        setError('');
        set(n);
    };
    const choice = (text: string, on: boolean, onClick: () => void) => <Choice key={text} text={text} on={on} onClick={onClick} />;
    return (
        <>
            <p className="text-[10.5px] text-ink-2">Once you close Otus, it locks:</p>
            <div role="group" aria-label="Lock after" className="flex flex-wrap gap-1.5">
                {LOCK_CHOICES.map((m) => choice(m === 0 ? 'At once' : m === 60 ? 'After 1 h' : `After ${m} min`, m === minutes && !custom, () => set(m)))}
                {choice(preset ? 'Custom' : `After ${minutes} min`, !preset || custom, () => setCustom(true))}
            </div>
            {custom && (
                <div className="flex flex-col gap-1.5">
                    <div className="flex items-center gap-2">
                        <Input type="number" min={1} max={MAX_LOCK_AFTER} step={1} placeholder="Minutes" aria-label="Minutes" value={typed} onChange={(e) => setTyped(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && keep()} />
                        <Button size="sm" variant="default" onClick={keep}>
                            Save
                        </Button>
                    </div>
                    <ErrorLine>{error}</ErrorLine>
                </div>
            )}
        </>
    );
}

// Where a transaction opens, from the sent banner, Send and Activity.
function ExplorerChoice({ chosen }: { chosen: Explorer }) {
    return (
        <div role="group" aria-label="Explorer" className="flex flex-wrap gap-1.5">
            {(Object.keys(EXPLORERS) as Explorer[]).map((e) => (
                <Choice key={e} text={EXPLORERS[e].name} on={e === chosen} onClick={() => void setSettings(() => ({ explorer: e }))} />
            ))}
        </div>
    );
}

// Whether the RPC simulates a transaction as it is sent: on, one that would fail is not sent (no fee); skipped, it is
// sent anyway, and pays its fee if it fails.
function Preflight({ on }: { on: boolean }) {
    return (
        <>
            <p className="text-[10.5px] text-ink-2">{on ? "A transaction that would fail isn't sent, so it costs nothing." : 'Sent even if it would fail: its fee is paid.'}</p>
            <div role="group" aria-label="Preflight" className="flex flex-wrap gap-1.5">
                <Choice text="On" on={on} onClick={() => void setSettings(() => ({ preflight: true }))} />
                <Choice text="Skip" on={!on} onClick={() => void setSettings(() => ({ preflight: false }))} />
            </div>
        </>
    );
}

// A choice among a few, lit when chosen.
// The network the wallet shows: mainnet through Otus's RPC, Solana's public devnet, or an endpoint of your own (with
// your provider key if it has one, shown with its secrets hidden), whose network it says itself when you save it.
function NetworkChoice({ settings }: { settings: Settings }) {
    const [picking, setPicking] = useState(settings.network === 'custom'); // Custom chosen: its endpoint shows
    const [typed, setTyped] = useState('');
    const [error, setError] = useState('');
    const [asking, setAsking] = useState(false);
    const saved = settings.rpc !== null && settings.custom !== null;
    // While an endpoint is asked its network, nothing else is chosen: its answer would undo the choice.
    const use = (network: 'mainnet' | 'devnet') => !asking && (setPicking(false), setError(''), void setSettings(() => ({ network })));
    // Its network is asked again whenever it is chosen: an endpoint can serve another one since it was saved.
    const ask = async (url: string) => {
        setAsking(true);
        try {
            const custom = clusterOfGenesis(await rpcAt(url).getGenesisHash().send());
            setError('');
            await setSettings(() => ({ network: 'custom', rpc: url, custom }));
            return true;
        } catch (e) {
            setError(`It did not answer as a Solana RPC: ${said(e)}`);
            return false;
        } finally {
            setAsking(false);
        }
    };
    const pick = () => {
        if (asking) return;
        setPicking(true);
        if (saved) void ask(settings.rpc!); // the endpoint saved before
    };
    const keep = async () => {
        const url = typed.trim();
        if (!usable(url)) return setError('Use an https address, or http on localhost');
        if (await ask(url)) setTyped('');
    };
    return (
        <>
            <div className="flex gap-1.5">
                <Choice text="Mainnet" on={!picking && settings.network === 'mainnet'} onClick={() => use('mainnet')} />
                <Choice text="Devnet" on={!picking && settings.network === 'devnet'} onClick={() => use('devnet')} />
                <Choice text="Custom" on={picking} onClick={pick} />
            </div>
            {!picking && <p className="text-[10.5px] text-ink-2">{settings.network === 'devnet' ? "Solana's public devnet RPC" : "Otus's RPC"}</p>}
            {picking && (
                <>
                    {saved && <p className="text-[10.5px] break-all text-ink-2">{`${networkName(settings.custom!)}: ${masked(settings.rpc!)}`}</p>}
                    <Input placeholder={saved ? 'Another endpoint' : 'Your endpoint'} spellCheck={false} autoComplete="off" aria-label="Your RPC" value={typed} onChange={(e) => setTyped(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void keep()} />
                    <ErrorLine>{error}</ErrorLine>
                    <Button size="sm" variant="default" disabled={asking} onClick={() => void keep()}>
                        Save
                    </Button>
                </>
            )}
        </>
    );
}

// The sites connected to your wallets; each can be let go.
function TrustedApps({ sites }: { sites: State['sites'] }) {
    const entries = Object.entries(sites);
    return (
        <>
            <p className="text-[10.5px] text-ink-2">Sites connected to your wallets. They see an address and can ask you to sign; they never sign.</p>
            {entries.length === 0 ? (
                <p className="text-[10.5px] text-ink-3">No site is connected</p>
            ) : (
                <ul>
                    {entries.map(([origin, site]) => (
                        <li key={origin} className="flex items-center gap-2.5 border-t border-dashed border-rule-2 py-2">
                            <span className="min-w-0 flex-1 truncate text-[10.5px] text-ink-3">
                                <span className="font-bold text-ink">{new URL(origin).host}</span> {short(site.account)}
                            </span>
                            <Button size="sm" onClick={() => void edit({ edit: 'disconnect', origin })}>
                                Disconnect
                            </Button>
                        </li>
                    ))}
                </ul>
            )}
        </>
    );
}

// The addresses you know, by your names for them: Send offers them beside its address field. Each can be dropped.
function KnownAddresses({ state }: { state: State }) {
    const [address, setAddress] = useState('');
    const [label, setLabel] = useState('');
    const [error, setError] = useState('');
    const keep = async () => {
        const a = address.trim();
        const yours = state.accounts.find((x) => x.address === a);
        const like = isAddress(a) ? lookalike(state, a) : null;
        const name = named(label);
        if (!isAddress(a)) return setError('Not a Solana address');
        if (yours) return setError(`That is your wallet ${yours.label}`);
        if (like) return setError(`It looks like ${like.label ? `${like.label}'s address` : 'an address you sent to'}: one of them may be forged`);
        if (!name) return setError('Give it a name');
        if (nameTaken(state, name, a)) return setError(`You have one named ${name} already`);
        const reply = (await edit({ edit: 'keep', address: a, label })) as { ok: boolean; error?: string } | undefined;
        if (reply && !reply.ok) return setError(reply.error ?? 'Otus could not save it');
        setAddress('');
        setLabel('');
        setError('');
    };
    return (
        <>
            {state.contacts.length > 0 && (
                <ul>
                    {state.contacts.map((c) => (
                        <li key={c.address} className="flex items-center gap-2.5 border-b border-dashed border-rule-2 py-2">
                            <Tile address={c.address} size={14} />
                            <span className="flex min-w-0 flex-1 flex-col gap-0.5 text-[10.5px]">
                                <span className="truncate font-bold text-ink">{c.label}</span>
                                <span className="text-[10px] break-all text-ink-3">{c.address}</span>
                            </span>
                            <Button size="sm" onClick={() => void edit({ edit: 'drop', address: c.address })}>
                                Remove
                            </Button>
                        </li>
                    ))}
                </ul>
            )}
            <Input placeholder="Solana address" spellCheck={false} autoComplete="off" aria-label="Address" value={address} onChange={(e) => (setAddress(e.target.value), setError(''))} />
            <Input placeholder="Its name" spellCheck={false} autoComplete="off" aria-label="Name" maxLength={32} value={label} onChange={(e) => (setLabel(e.target.value), setError(''))} onKeyDown={(e) => e.key === 'Enter' && void keep()} />
            <ErrorLine>{error}</ErrorLine>
            <Button size="sm" variant="default" onClick={() => void keep()}>
                Add
            </Button>
        </>
    );
}

// An endpoint without its secrets: query values and long path parts, where providers put keys.
function masked(url: string): string {
    try {
        const u = new URL(url);
        for (const key of [...u.searchParams.keys()]) u.searchParams.set(key, '•••');
        u.pathname = u.pathname.split('/').map((part) => (part.length > 16 ? '•••' : part)).join('/');
        return decodeURIComponent(u.toString());
    } catch {
        return `${URL.canParse(url) ? new URL(url).origin : 'Your endpoint'} •••`;
    }
}

function usable(url: string) {
    try {
        const u = new URL(url);
        return u.protocol === 'https:' || (u.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(u.hostname));
    } catch {
        return false;
    }
}
