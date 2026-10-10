// A token's details, opened from its line in the lobby: its mint's address to copy, what the mint lets others do with
// it, and its page on the explorer chosen.
import type { Address } from '@solana/kit';

import { short } from '@otus-wallet/sdk/format';
import { PROGRAM_NAMES } from '@otus-wallet/sdk/programs/known';
import type { Holding } from '@otus-wallet/core/holdings.ts';
import { explorerOf, walletRpc } from '@otus-wallet/core/settings.ts';
import type { State } from '@otus-wallet/core/state.ts';
import { YOU } from '@otus-wallet/core/view/names.ts';
import { tokenFacts } from '@otus-wallet/core/view/token.ts';
import { Icon } from '../components/icons.tsx';
import { Tagged } from '../components/you.tsx';
import { CopyAddress, Fact } from './common.tsx';
import { current, said, useTokenTerms } from './store.ts';

export function TokenDetails({ asset, state }: { asset: Holding; state: State }) {
    const mint = asset.mint as Address;
    const read = useTokenTerms(walletRpc(state.settings), mint);
    const explorer = explorerOf(state.settings);
    const wallet = current(state).address;
    const names = new Map<string, string>([...state.contacts, ...state.accounts].map((k) => [k.address, k.label]));
    const who = (a: Address) => (a === wallet ? `${short(a)}${YOU}` : (names.get(a) ?? PROGRAM_NAMES.get(a) ?? short(a)));
    return (
        <div className="details flex flex-col gap-2.5 pb-3 pl-11 text-[11px]">
            <span className="flex flex-col gap-0.5">
                <span className="pixel text-[9px] text-ink-3">Mint</span>
                <span className="flex items-center gap-1">
                    <span className="min-w-0 text-[10.5px] font-bold [overflow-wrap:anywhere]">{mint}</span>
                    <CopyAddress address={mint} label="Copy mint address" className="size-6 shrink-0" />
                </span>
            </span>
            {read.data?.terms && (
                <dl className="flex flex-col gap-1">
                    {tokenFacts(read.data.terms, read.data.metadata, asset.symbol || short(mint), who).map((f, i) => (
                        <Fact key={i} name={f.name} wrap>
                            <span className={f.warn ? 'text-warn' : undefined}>
                                <Tagged text={f.value} />
                            </span>
                        </Fact>
                    ))}
                </dl>
            )}
            {read.data && !read.data.terms && <span className="text-warn">Otus could not read this mint</span>}
            {!read.data && read.error && <span className="text-warn">{`The RPC did not answer: ${said(read.error)}`}</span>}
            <a href={explorer.token(mint)} target="_blank" rel="noreferrer" className="inline-flex h-7 items-center gap-1.5 self-start rounded-[3px] border border-rule px-[9px] text-[11px] font-bold text-ink hover:border-ink-3">
                {`View on ${explorer.name}`}
                <Icon name="external" size={11} stroke={2.5} />
            </a>
        </div>
    );
}
