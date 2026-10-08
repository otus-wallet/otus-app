// Who besides the wallet has access to what it holds: delegates on its token accounts, what its tokens' issuers can do,
// and the transactions it signed that can still run, each with the site behind it when Otus kept that. Opened from
// Activity.
import type { Address } from '@solana/kit';
import { useMemo, type ReactNode } from 'react';

import { short } from '@otus-wallet/sdk/format';
import { PROGRAM_NAMES } from '@otus-wallet/sdk/programs/known';
import { rpcFor } from '../../settings.ts';
import type { State } from '../../shell/state.ts';
import { cachedToken } from '../../tokens.ts';
import { Button } from '../components/ui/button.tsx';
import { Icon } from '../components/icons.tsx';
import { cn } from '../lib/cn.ts';
import { filled } from '../review/tone.ts';
import { YOU } from '../view/names.ts';
import { accessRows, accessWords, freezable, others, type AccessNaming } from '../view/access.ts';
import { KNOWN_SYMBOLS } from './Activity.tsx';
import type { Screen } from './App.tsx';
import { Bar, Heading, Sheet } from './common.tsx';
import { current, said, useAccess, useHeldNow } from './store.ts';

export function Access({ state, go }: { state: State; go: (to: Screen) => void }) {
    const account = current(state);
    const rpc = rpcFor('solana:mainnet', state.settings);
    const read = useAccess(rpc, account.address, state);
    const held = useHeldNow(rpc, account.address);
    const naming = useMemo((): AccessNaming => {
        const assets = new Map((held?.assets ?? []).filter((a) => !a.native).map((a) => [a.mint, a]));
        const names = new Map<string, string>([...state.contacts, ...state.accounts].map((k) => [k.address, k.label]));
        return {
            wallet: account.address,
            symbol: (mint) => {
                const asset = assets.get(mint);
                return KNOWN_SYMBOLS[mint] ?? (asset?.verified && asset.symbol ? asset.symbol : cachedToken(mint)?.verified ? cachedToken(mint)!.symbol : short(mint));
            },
            decimals: (mint) => assets.get(mint)?.decimals ?? cachedToken(mint)?.decimals ?? null,
            who: (a: Address) => (a === account.address ? `${short(a)}${YOU}` : (names.get(a) ?? PROGRAM_NAMES.get(a) ?? short(a))),
            given: state.given,
            waiting: state.waiting.filter((w) => w.wallet === account.address),
        };
    }, [account.address, held, state.accounts, state.contacts, state.given, state.waiting]);
    const grants = read.data?.grants ?? [];
    const rows = accessRows(grants, naming);
    const frozen = freezable(grants, naming);
    const n = others(grants);
    return (
        <Sheet bar={<Bar title="Access" back={() => go('activity')} />}>
            {!read.data && !read.error && <p className="pt-6 text-center text-[11px] text-ink-3">Checking who has access</p>}
            {!read.data && read.error && (
                <div className="flex flex-col items-center gap-2.5 pt-8 text-center">
                    <p className="text-[11px] text-warn">{`The RPC did not answer: ${said(read.error)}`}</p>
                    <Button size="sm" onClick={() => void read.refetch()}>
                        Try again
                    </Button>
                </div>
            )}
            {read.data && (
                <div className={cn('flex items-center gap-3 rounded-[3px] border border-current p-3.5', filled(n === 0 ? 'ok' : 'warn'))}>
                    <Icon name={n === 0 ? 'only' : 'others'} size={24} stroke={2.2} />
                    <p className="text-[12.5px] font-bold">{accessWords(n)}</p>
                </div>
            )}
            {rows.length > 0 && (
                <Part title="Can move or close">
                    <ul>
                        {rows.map((row, i) => (
                            <li key={i} className="flex flex-col gap-[3px] border-t border-dashed border-rule-2 py-2.5">
                                <span className={cn('text-[12px] font-bold [overflow-wrap:anywhere]', row.grant.kind === 'closer' ? 'text-ink' : 'text-warn')}>{row.title}</span>
                                <span className="text-[10.5px] text-ink-3 [overflow-wrap:anywhere]">{row.sub}</span>
                            </li>
                        ))}
                    </ul>
                </Part>
            )}
            {frozen.length > 0 && (
                <Part title="Issuers can freeze">
                    <p className="text-[11px] font-bold">{frozen.join(', ')}</p>
                    <p className="text-[10.5px] text-ink-3">Each issuer can freeze your account of its token, which moves nothing. Most stablecoins come with this.</p>
                </Part>
            )}
            {read.data && (
                <p className="text-[10.5px] text-ink-3">
                    Checked: your token accounts, what your tokens' issuers can do, and the transactions you signed on a nonce.
                    {read.data.unchecked > 0 && ` ${read.data.unchecked} tokens' issuers were left out.`}
                </p>
            )}
        </Sheet>
    );
}

const Part = ({ title, children }: { title: string; children: ReactNode }) => (
    <div className="flex flex-col gap-1.5">
        <Heading>{title}</Heading>
        {children}
    </div>
);
