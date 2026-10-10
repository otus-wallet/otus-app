// A token's details, opened from its line in the lobby: its mint's address to copy, what the mint lets others do with
// it, and its page on the explorer chosen. SOL has no mint: it says it is the native token, its wrapped mint (what token
// programs and explorers know it by) and its supply. Read ahead in the lobby, they open complete.
import type { Address } from '@solana/kit';
import type { ReactNode } from 'react';

import { WSOL } from '@otus-wallet/sdk/programs/addresses';
import { PROGRAM_NAMES } from '@otus-wallet/sdk/programs/known';
import type { Holding } from '@otus-wallet/core/holdings.ts';
import { explorerOf, networkOf, walletRpc } from '@otus-wallet/core/settings.ts';
import { cachedToken } from '@otus-wallet/core/tokens.ts';
import type { State } from '@otus-wallet/core/state.ts';
import { solFacts, tokenFacts, type TokenFact } from '@otus-wallet/core/view/token.ts';
import { Icon } from '../components/icons.tsx';
import { ShortAddress } from '../components/address.tsx';
import { Addressed, YouTag } from '../components/you.tsx';
import { cn } from '../lib/cn.ts';
import { CopyAddress, Fact, Tip } from './common.tsx';
import { current, said, useTokenTerms } from './store.ts';

export function TokenDetails({ asset, state }: { asset: Holding; state: State }) {
    return asset.native ? <SolDetails state={state} /> : <MintDetails asset={asset} state={state} />;
}

function MintDetails({ asset, state }: { asset: Holding; state: State }) {
    const mint = asset.mint as Address;
    const read = useTokenTerms(walletRpc(state.settings), mint);
    const market = networkOf(state.settings) === 'solana:mainnet' ? (cachedToken(mint)?.market ?? null) : null; // from the answer that priced it
    const wallet = current(state).address;
    const names = new Map<string, string>([...state.contacts, ...state.accounts].map((k) => [k.address, k.label]));
    const who = (a: Address) => (a === wallet ? a : (names.get(a) ?? PROGRAM_NAMES.get(a) ?? a)); // yours tagged by the fact
    return (
        <Details label="Mint" address={mint} state={state}>
            {read.data?.terms && <Facts facts={tokenFacts(read.data.terms, read.data.metadata, { who, wallet, symbol: asset.symbol || mint, epoch: read.data.epoch, now: Date.now() / 1000 }, market)} />}
            {read.data && !read.data.terms && <span className="text-warn">Otus could not read this mint</span>}
            {/* Shown under what was read before, too: that may be behind. */}
            {read.error && <span className="text-warn">{`The RPC did not answer: ${said(read.error)}`}</span>}
        </Details>
    );
}

// Its supply as Jupiter counts it, from the answer that priced it: no request of its own. Mainnet's only.
function SolDetails({ state }: { state: State }) {
    const supply = networkOf(state.settings) === 'solana:mainnet' ? (cachedToken(WSOL)?.supply ?? null) : null;
    return (
        <Details label="Wrapped mint" address={WSOL} state={state}>
            <Facts facts={solFacts(supply)} />
        </Details>
    );
}

// The address a token is known by, to copy; what is said of it; its page on the explorer.
function Details({ label, address, state, children }: { label: string; address: Address; state: State; children: ReactNode }) {
    const explorer = explorerOf(state.settings);
    return (
        <div className="details flex flex-col gap-2.5 pb-3 pl-11 text-xs">
            <span className="flex flex-col gap-0.5">
                <span className="flex items-center justify-between gap-1">
                    <span className="pixel text-xs text-ink-3">{label}</span>
                    <CopyAddress address={address} label={`Copy ${label.toLowerCase()} address`} className="-my-1.5 size-6 shrink-0" />
                </span>
                <span className="text-2xs font-bold [overflow-wrap:anywhere]">{address}</span>
            </span>
            {children}
            <a href={explorer.token(address)} target="_blank" rel="noreferrer" className="inline-flex h-7 items-center gap-1.5 self-start rounded-[3px] border border-rule px-[9px] text-xs font-bold text-ink hover:border-ink-3">
                {`View on ${explorer.name}`}
                <Icon name="external" size={11} stroke={2.5} />
            </a>
        </div>
    );
}

// Each line; one naming an address shows it whole on hover and copies it on a click, by its name too (yours tagged), and
// a number in short says it whole on hover. Words are shown as they are, but for addresses, cut short: a token's symbol
// is its maker's, so nothing in them is read as a tag.
function Facts({ facts }: { facts: TokenFact[] }) {
    return (
        <dl className="flex flex-col gap-1">
            {facts.map((f, i) => (
                <Fact key={i} name={f.name} wrap>
                    <span className={cn('inline-flex items-center gap-0.5', f.warn && 'text-warn')}>
                        {f.full ? (
                            <Tip text={f.full}>
                                <span className="cursor-default">{f.value}</span>
                            </Tip>
                        ) : (
                            <Value fact={f} />
                        )}
                        {f.you && <YouTag />}
                    </span>
                </Fact>
            ))}
        </dl>
    );
}

// A line's value: an address it names, cut short or by its name, to hover and copy; other words with any address in them
// cut short.
function Value({ fact: f }: { fact: TokenFact }) {
    if (f.address && !f.value.includes(f.address)) return <ShortAddress address={f.address} name={f.value} />;
    return (
        <span>
            <Addressed text={f.value} />
        </span>
    );
}
