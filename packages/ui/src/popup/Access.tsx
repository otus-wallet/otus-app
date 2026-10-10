// Who besides the wallet has access to what it holds: delegates on its token accounts, what its tokens' issuers can do,
// and the transactions it signed that can still run, each with the site behind it when Otus kept that. Opened from
// Activity.
import type { Address } from '@solana/kit';
import { useMemo, useState, type ReactNode } from 'react';

import { short } from '@otus-wallet/sdk/format';
import { PROGRAM_NAMES } from '@otus-wallet/sdk/programs/known';
import { networkOf, walletRpc } from '@otus-wallet/core/settings.ts';
import type { Fix } from '@otus-wallet/core/send/fix.ts';
import { signs, type State } from '@otus-wallet/core/state.ts';
import { cachedToken } from '@otus-wallet/core/tokens.ts';
import { Button } from '../components/ui/button.tsx';
import { Icon } from '../components/icons.tsx';
import { cn } from '../lib/cn.ts';
import { filled } from '../review/tone.ts';
import { YOU } from '@otus-wallet/core/view/names.ts';
import { accessRows, accessWords, freezable, others, type AccessNaming, type AccessRow } from '@otus-wallet/core/view/access.ts';
import { KNOWN_SYMBOLS } from './Activity.tsx';
import type { Screen } from './App.tsx';
import { Bar, Sheet } from './common.tsx';
import { current, said, useAccess, useHeldNow } from './store.ts';
import { TakeBack } from './TakeBack.tsx';

export function Access({ state, go }: { state: State; go: (to: Screen) => void }) {
    const account = current(state);
    const rpc = walletRpc(state.settings);
    const read = useAccess(rpc, account.address, state);
    const held = useHeldNow(rpc, account.address);
    const naming = useMemo((): AccessNaming => {
        const assets = new Map((held?.assets ?? []).filter((a) => !a.native).map((a) => [a.mint, a]));
        const names = new Map<string, string>([...state.contacts, ...state.accounts].map((k) => [k.address, k.label]));
        // Names from Jupiter and the tokens everyone knows are mainnet's: elsewhere the same addresses are other tokens.
        const mainnet = networkOf(state.settings) === 'solana:mainnet';
        return {
            wallet: account.address,
            program: (a) => PROGRAM_NAMES.get(a) ?? short(a),
            symbol: (mint) => {
                const asset = assets.get(mint);
                if (!mainnet) return short(mint);
                return KNOWN_SYMBOLS[mint] ?? (asset?.verified && asset.symbol ? asset.symbol : cachedToken(mint)?.verified ? cachedToken(mint)!.symbol : short(mint));
            },
            decimals: (mint) => assets.get(mint)?.decimals ?? (mainnet ? cachedToken(mint)?.decimals : null) ?? null,
            who: (a: Address) => (a === account.address ? `${short(a)}${YOU}` : (names.get(a) ?? PROGRAM_NAMES.get(a) ?? short(a))),
            given: state.given,
            waiting: state.waiting.filter((w) => w.wallet === account.address),
        };
    }, [account.address, held, state.accounts, state.contacts, state.given, state.waiting, state.settings]);
    const [taking, setTaking] = useState<{ what: Fix; title: string } | null>(null);
    const grants = read.data?.grants ?? [];
    const rows = accessRows(grants, naming);
    const frozen = freezable(grants, naming);
    const n = others(grants);
    if (taking) {
        // Its row goes once it lands, as access is read again then.
        const done = () => setTaking(null);
        return <TakeBack account={account} what={taking.what} title={taking.title} settings={state.settings} done={done} />;
    }
    const take = signs(account) ? (row: AccessRow) => setTaking({ what: fixOf(row), title: row.title }) : null; // a watched account signs nothing
    const checked = read.data && (
        <p className="px-4 pb-3.5 text-xs text-ink-3">
            Checked: your token accounts, the authorities of your tokens, and the transactions you signed on a nonce.
            {read.data.unchecked > 0 && ` The authorities of ${read.data.unchecked} tokens were left out.`}
        </p>
    );
    return (
        <Sheet bar={<Bar title="Access" back={() => go('activity')} />} foot={checked}>
            {!read.data && !read.error && <p className="pt-6 text-center text-xs text-ink-3">Checking who has access</p>}
            {!read.data && read.error && (
                <div className="flex flex-col items-center gap-2.5 pt-8 text-center">
                    <p className="text-xs text-warn">{`The RPC did not answer: ${said(read.error)}`}</p>
                    <Button size="sm" onClick={() => void read.refetch()}>
                        Try again
                    </Button>
                </div>
            )}
            {read.data && (
                <div className={cn('flex items-center gap-3 rounded-[3px] border border-current p-3.5', filled(n === 0 && !read.data.unchecked ? 'ok' : 'warn'))}>
                    <Icon name={n === 0 ? 'only' : 'others'} size={24} stroke={2.2} />
                    <p className="text-sm font-bold">{accessWords(n, read.data.unchecked)}</p>
                </div>
            )}
            {rows.length > 0 && (
                <Part title="Can move or close">
                    <ul>
                        {rows.map((row, i) => (
                            <li key={i} className="flex items-center gap-3 border-t border-dashed border-rule-2 py-2.5 first:border-t-0 first:pt-0">
                                <span className="flex min-w-0 flex-1 flex-col gap-[3px]">
                                    <span className={cn('text-sm font-bold [overflow-wrap:anywhere]', row.grant.kind === 'closer' ? 'text-ink' : 'text-warn')}>{row.title}</span>
                                    <span className="text-xs text-ink-3 [overflow-wrap:anywhere]">{row.sub}</span>
                                </span>
                                {row.fix && take && (
                                    <Button size="sm" className="shrink-0" onClick={() => take(row)}>
                                        {row.fix === 'revoke' ? 'Revoke' : 'Cancel'}
                                    </Button>
                                )}
                            </li>
                        ))}
                    </ul>
                </Part>
            )}
            {frozen.length > 0 && (
                <Part title="Can be frozen">
                    <p className="text-xs font-bold">{frozen.join(', ')}</p>
                    <p className="text-xs text-ink-3">{frozen.length === 1 ? `The authority of ${frozen[0]} can freeze your account holding it.` : 'The authorities of these tokens can freeze your accounts holding them.'}</p>
                </Part>
            )}
        </Sheet>
    );
}

// What a row's fix takes back: its delegate, or its nonce.
function fixOf({ grant }: AccessRow): Fix {
    if (grant.kind === 'delegate') return { kind: 'revoke', account: grant.account, program: grant.program };
    if (grant.kind === 'nonce') return { kind: 'cancel', nonce: grant.account };
    throw new Error('nothing to take back');
}

// A part of the screen under its title, as large as the review window's section titles.
const Part = ({ title, children }: { title: string; children: ReactNode }) => (
    <div className="flex flex-col gap-1.5">
        <h2 className="pixel text-xs text-ink-2">{title}</h2>
        {children}
    </div>
);
