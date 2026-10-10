// Stake, from the lobby. Native: the wallet's stake accounts, wherever they were made, with where each stands and what
// can be done with it (unstake, then withdraw once off), and a new stake with a validator of the network's, picked from
// a list ranked by what each paid of late, or found by name or address. Liquid stake comes with swaps.
import type { Address } from '@solana/kit';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import { sol } from '@otus-wallet/sdk/format';
import { rpcAt } from '@otus-wallet/sdk/rpc';
import { seedOf, stakeAt, staking } from '@otus-wallet/core/send/stake.ts';
import { units as unitsOf } from '@otus-wallet/core/send/transfer.ts';
import { networkOf, OTUS_RPC, walletRpc } from '@otus-wallet/core/settings.ts';
import { signs, type State } from '@otus-wallet/core/state.ts';
import { lockedOf, nextSeed, standingOf, type StakeAccount, type Standing } from '@otus-wallet/core/stake/stakes.ts';
import type { Validator } from '@otus-wallet/core/stake/validators.ts';
import { Logo } from '../components/icons.tsx';
import { nameOr } from '@otus-wallet/core/view/names.ts';
import { Addressed } from '../components/you.tsx';
import { Button } from '../components/ui/button.tsx';
import { Input } from '../components/ui/input.tsx';
import { cn } from '../lib/cn.ts';
import { search, stakeProblem, standingWords, validatorWords } from '@otus-wallet/core/view/stake.ts';
import type { Screen } from './App.tsx';
import { Bar, Choice, ErrorLine, Heading, Sheet, Tip } from './common.tsx';
import { decimal } from '@otus-wallet/core/money.ts';
import { current, said, useEpoch, useHoldings, useStakes, useStakeTerms, useValidators } from './store.ts';
import { Doing, type Job } from './TakeBack.tsx';

const RESERVE = 2_000_000n; // lamports a new stake leaves the wallet for fees and its own rent, as Send's Max does
const used = new Set<string>(); // seeds of stakes made while the popup is open: one may not have landed yet

export function StakeScreen({ state, go }: { state: State; go: (to: Screen) => void }) {
    const account = current(state);
    const rpc = walletRpc(state.settings);
    const [tab, setTab] = useState<'native' | 'liquid'>('native');
    const [adding, setAdding] = useState(false);
    const [doing, setDoing] = useState<{ job: Job; title: string } | null>(null);
    const stakes = useStakes(rpc, account.address);
    const epoch = useEpoch(rpc);
    const terms = useStakeTerms(rpc);
    const validators = useValidators(rpc, networkOf(state.settings), epoch.data?.epoch);
    const byVote = useMemo(() => new Map((validators.data ?? []).map((v) => [v.vote, v])), [validators.data]);
    const nameOf = (vote: Address | null) => (vote === null ? 'Not delegated' : nameOr(byVote.get(vote)?.name, vote));
    const logos = logosShown(state);

    if (doing) {
        // What it changed is read again once it lands.
        const done = () => {
            setDoing(null);
            setAdding(false);
        };
        return <Doing account={account} job={doing.job} title={doing.title} settings={state.settings} done={done} />;
    }
    const mine = signs(account); // a watched account signs nothing
    if (adding && terms.data) return <NewStake state={state} terms={terms.data} validators={validators.data} error={validators.error} back={() => setAdding(false)} start={(job, title) => setDoing({ job, title })} />;

    const owner = account.address;
    const job = (kind: 'unstake' | 'withdraw', s: StakeAccount): { job: Job; title: string } => ({
        job: {
            kind: 'stake',
            // A withdraw takes all the account holds as it is read now: rewards may have come in since the list was read.
            make: async (lifetime) => {
                if (kind === 'unstake') return staking(owner, { kind, stake: s.address }, lifetime);
                const { value } = await rpcAt(rpc).getBalance(s.address, { commitment: 'confirmed' }).send();
                return staking(owner, { kind, stake: s.address, lamports: value }, lifetime);
            },
            doing: kind === 'unstake' ? 'Unstaking' : 'Withdrawing',
            landed: kind === 'unstake' ? 'Unstaked' : 'Withdrawn',
            where: 'Stake',
        },
        title: `${sol(s.lamports)} SOL · ${nameOf(s.vote)}`,
    });
    const now = BigInt(Math.floor(Date.now() / 1000));
    const read = stakes.data ?? [];
    const total = read.reduce((n, s) => n + s.lamports, 0n);
    const foot = tab === 'native' && mine && (
        <div className="border-t border-dashed border-rule px-4 pt-2.5 pb-3.5">
            <Button variant="default" className="w-full" disabled={!terms.data} onClick={() => setAdding(true)}>
                Stake SOL
            </Button>
        </div>
    );
    return (
        <Sheet bar={<Bar title="Stake" back={() => go('lobby')} />} foot={foot}>
            <div className="flex gap-1.5">
                <Choice text="Native" on={tab === 'native'} onClick={() => setTab('native')} />
                <Choice text="Liquid" on={tab === 'liquid'} onClick={() => setTab('liquid')} />
            </div>
            {tab === 'liquid' && <p className="pt-4 text-center text-xs text-ink-3">Liquid stake comes with swaps: soon.</p>}
            {tab === 'native' && (
                <>
                    {!stakes.data && !stakes.error && <p className="pt-6 text-center text-xs text-ink-3">Reading your stake</p>}
                    {!stakes.data && stakes.error && <Failed error={stakes.error} again={() => void stakes.refetch()} />}
                    {stakes.data && (
                        <Part title="Your stake" extra={epoch.data && <span className="text-xs text-ink-3">{`Epoch ${epoch.data.epoch}`}</span>}>
                            {read.length === 0 ? (
                                <p className="text-xs text-ink-3">No stake yet</p>
                            ) : (
                                <>
                                    <p className="text-xs font-bold">{`${sol(total)} SOL`}</p>
                                    <ul>
                                        {read.map((s) => {
                                            if ('unreadable' in s) {
                                                return (
                                                    <Row key={s.address} title={s.address} sub={`${sol(s.lamports)} SOL · Otus can't read this stake account`} logo={<ValidatorLogo node={null} shown={false} />}>
                                                        {null}
                                                    </Row>
                                                );
                                            }
                                            const standing = epoch.data ? standingOf(s, epoch.data.epoch) : null;
                                            const locked = epoch.data ? lockedOf(s, epoch.data.epoch, now) : false;
                                            const words = standing ? standingWords(standing, epoch.data!.left, locked) : '';
                                            const action = mine && standing ? actionOf(standing, s.staker === owner, locked) : null;
                                            return (
                                                <Row key={s.address} title={nameOf(s.vote)} sub={`${sol(s.lamports)} SOL${words ? ` · ${words}` : ''}`} logo={<ValidatorLogo node={(s.vote && byVote.get(s.vote)?.node) ?? null} shown={logos} />}>
                                                    {action && (
                                                        <Button size="sm" className="shrink-0" onClick={() => setDoing(job(action, s))}>
                                                            {action === 'unstake' ? 'Unstake' : 'Withdraw'}
                                                        </Button>
                                                    )}
                                                </Row>
                                            );
                                        })}
                                    </ul>
                                </>
                            )}
                        </Part>
                    )}
                    {epoch.error && !epoch.data && <Failed error={epoch.error} again={() => void epoch.refetch()} />}
                    {terms.error && !terms.data && <Failed error={terms.error} again={() => void terms.refetch()} />}
                </>
            )}
        </Sheet>
    );
}

// What the wallet can do with a stake where it stands: unstake it while it earns or warms up, when the wallet is its
// staker (a lockup holds back no unstaking); withdraw it once off, unless a lockup holds it; nothing while it cools down.
function actionOf(standing: Standing, staker: boolean, locked: boolean): 'unstake' | 'withdraw' | null {
    if (standing === 'active' || standing === 'activating') return staker ? 'unstake' : null;
    if (standing === 'inactive' || standing === 'idle') return locked ? null : 'withdraw';
    return null;
}

// A new stake: a validator found and opened, then how much, staked from there.
function NewStake({ state, terms, validators, error, back, start }: { state: State; terms: { min: bigint; rent: bigint }; validators: Validator[] | undefined; error: Error | null; back: () => void; start: (job: Job, title: string) => void }) {
    const account = current(state);
    const rpc = walletRpc(state.settings);
    const held = useHoldings(rpc, account.address, networkOf(state.settings) === 'solana:mainnet');
    const [text, setText] = useState('');
    const [query, setQuery] = useState('');
    const [open, setOpen] = useState<Validator | null>(null);
    const units = unitsOf(text, 9);
    const balance = held && !(held instanceof Error) ? held.sol : null;
    const most = balance === null ? null : balance > terms.rent + RESERVE ? balance - terms.rent - RESERVE : 0n;
    const problem = stakeProblem({ text, units, min: terms.min, most });
    const found = useMemo(() => search(validators ?? [], query), [validators, query]);
    const listed = open && !found.some((v) => v.vote === open.vote) ? [open, ...found] : found;
    const ready = units !== null && !problem && most !== null && open !== null && open.voting;
    const go = () => {
        if (!ready) return;
        const owner = account.address;
        const vote = open.vote;
        const lamports = units + terms.rent;
        const job: Job = {
            kind: 'stake',
            make: async (lifetime) => {
                const seed = await nextSeed(rpcAt(rpc), (s) => stakeAt(owner, s), seedOf, used);
                used.add(seed);
                return staking(owner, { kind: 'stake', seed, lamports, vote }, lifetime);
            },
            doing: 'Staking',
            landed: 'Staked',
            where: 'Stake',
        };
        start(job, `${decimal(units, 9)} SOL with ${nameOr(open.name, vote)}`);
    };
    return (
        <Sheet bar={<Bar title="Stake SOL" back={back} />}>
            <div className="flex flex-col gap-1.5">
                <Heading>Validator</Heading>
                <Input placeholder="Name or address" autoComplete="off" spellCheck={false} aria-label="Find a validator" autoFocus value={query} onChange={(e) => setQuery(e.target.value)} />
                {!validators && !error && <p className="text-xs text-ink-3">Reading the validators</p>}
                {!validators && error && <p className="text-xs text-warn">{`The RPC did not answer: ${said(error)}`}</p>}
                {validators && listed.length === 0 && <p className="text-xs text-ink-3">No validator by that name or address</p>}
                {validators && !query.trim() && <p className="mt-1.5 text-xs text-ink-3">Ranked by the highest rewards in the last 3 epochs.</p>}
                <ul className="flex flex-col gap-1.5">
                    {listed.map((v) => (
                        <li key={v.vote}>
                            <ValidatorRow v={v} open={open?.vote === v.vote} flip={() => setOpen(open?.vote === v.vote ? null : v)} logos={logosShown(state)}>
                                <div className="flex flex-col gap-1.5 border-t border-dashed border-rule px-2.5 pt-2.5 pb-3">
                                    <Heading
                                        extra={
                                            most !== null &&
                                            most > 0n && (
                                                <Button size="xs" onClick={() => setText(decimal(most, 9))}>
                                                    Max
                                                </Button>
                                            )
                                        }
                                    >
                                        Amount
                                    </Heading>
                                    <Input inputMode="decimal" placeholder="0" autoComplete="off" spellCheck={false} aria-label="Amount" autoFocus value={text} onChange={(e) => setText(e.target.value)} />
                                    <p className="text-xs text-ink-3">{`At least ${sol(terms.min)} SOL. Its account keeps ${sol(terms.rent)} SOL of rent, back when you withdraw.`}</p>
                                    <ErrorLine>{problem}</ErrorLine>
                                    <Button variant="default" className="mt-1 w-full" disabled={!ready} onClick={go}>
                                        Stake
                                    </Button>
                                </div>
                            </ValidatorRow>
                        </li>
                    ))}
                </ul>
            </div>
        </Sheet>
    );
}

// Whether validators' logos are shown: on mainnet through Otus's RPC, whose server fetches each logo and writes it anew,
// so that no validator's server learns who looks. With an endpoint of your own, Otus's server is asked nothing.
const logosShown = (state: State) => state.settings.network === 'mainnet';

// A validator's logo by its identity, from Otus's server; the plain mark when it has none, or it is not shown.
function ValidatorLogo({ node, shown }: { node: string | null; shown: boolean }) {
    const [failed, setFailed] = useState(false);
    if (!shown || !node || failed) return <Logo name="chain" size={28} className="shrink-0 rounded-[3px] bg-panel text-ink-3" />;
    return <img src={`${OTUS_RPC}/logo/${node}`} alt="" width={28} height={28} crossOrigin="anonymous" referrerPolicy="no-referrer" loading="lazy" onError={() => setFailed(true)} className="size-7 shrink-0 rounded-[3px] bg-panel object-contain" />;
}

// A validator to pick: its logo, its declared name or address, the top-third mark, then its address, commission and
// stake, and what to know first. Opened, it shows what is staked with it, brought into view whole.
function ValidatorRow({ v, open, flip, logos, children }: { v: Validator; open: boolean; flip: () => void; logos: boolean; children: ReactNode }) {
    const { title, sub, notes } = validatorWords(v);
    const box = useRef<HTMLDivElement>(null);
    useEffect(() => {
        if (open) box.current?.scrollIntoView({ block: 'nearest' });
    }, [open]);
    return (
        <div ref={box} className={cn('rounded-[3px] border', open ? 'border-ok-bd' : 'border-rule hover:border-ink-3')}>
            <button type="button" aria-expanded={open} onClick={flip} className="flex w-full cursor-pointer items-start gap-2.5 px-2.5 py-2 text-left">
                <ValidatorLogo node={v.node} shown={logos} />
                <span className="flex min-w-0 flex-1 flex-col gap-[3px]">
                    <span className="flex items-center gap-1.5">
                        <span className={cn('min-w-0 flex-1 truncate text-sm font-bold', open && 'text-ok')}>{title}</span>
                        {v.top && (
                            <Tip text="One of the few validators that together hold a third of all stake">
                                <span className="pixel shrink-0 rounded-sm border border-rule px-[3px] py-px text-xs text-ink-3">Top third</span>
                            </Tip>
                        )}
                    </span>
                    <span className="text-xs text-ink-3">{sub}</span>
                    {notes.map((n) => (
                        <span key={n.text} className={cn('text-xs', n.tone === 'danger' ? 'text-danger' : 'text-warn')}>
                            {n.text}
                        </span>
                    ))}
                </span>
            </button>
            {open && children}
        </div>
    );
}

// One stake: whom it is with, how much and where it stands, and what can be done with it.
const Row = ({ title, sub, logo, children }: { title: string; sub: string; logo: ReactNode; children: ReactNode }) => (
    <li className="flex items-center gap-3 border-t border-dashed border-rule-2 py-2.5 first:border-t-0 first:pt-0">
        {logo}
        <span className="flex min-w-0 flex-1 flex-col gap-[3px]">
            <span className="text-sm font-bold [overflow-wrap:anywhere]">
                <Addressed text={title} />
            </span>
            <span className="text-xs text-ink-3 [overflow-wrap:anywhere]">
                <Addressed text={sub} />
            </span>
        </span>
        {children}
    </li>
);

// A part of the screen under its title, as Access has them.
const Part = ({ title, extra, children }: { title: string; extra?: ReactNode; children: ReactNode }) => (
    <div className="flex flex-col gap-1.5">
        <div className="flex items-baseline justify-between">
            <h2 className="pixel text-xs text-ink-2">{title}</h2>
            {extra}
        </div>
        {children}
    </div>
);

const Failed = ({ error, again }: { error: unknown; again: () => void }) => (
    <div className="flex flex-col items-center gap-2.5 pt-8 text-center">
        <p className="text-xs text-warn">{`The RPC did not answer: ${said(error)}`}</p>
        <Button size="sm" onClick={again}>
            Try again
        </Button>
    </div>
);
