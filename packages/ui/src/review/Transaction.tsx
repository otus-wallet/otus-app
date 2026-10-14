// A transaction's three steps: where your balances go, what each program does, and the verdict.
import { useContext, useEffect, useState } from 'react';

import { Button } from '../components/ui/button.tsx';
import { Checkbox } from '../components/ui/checkbox.tsx';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '../components/ui/collapsible.tsx';
import { Tooltip, TooltipContent, TooltipTrigger } from '../components/ui/tooltip.tsx';
import { Icon, Logo } from '../components/icons.tsx';
import { AddressNames, NameTag, ShortAddress } from '../components/address.tsx';
import { cn } from '../lib/cn.ts';
import type { AssetChange, InstructionView, Line, ProgramView, Reviewed, Tone, TransactionView } from '@otus-wallet/core/view.ts';
import { Block, Heading, Notice, WATCH_ONLY } from './Frame.tsx';
import { filled, MARK, text } from './tone.ts';
import { Tagged, YouTag, YourWallet } from '../components/you.tsx';
import { partiesOf } from '@otus-wallet/core/view/squads.ts';

const Count = ({ n, one, many }: { n: number; one: string; many: string }) => <>{`${n} ${n === 1 ? one : many}`}</>;

// The seal of a verified token, saying so on hover.
function Seal({ symbol }: { symbol: string }) {
    return (
        <Tooltip>
            <TooltipTrigger asChild>
                <span tabIndex={0} role="img" aria-label={`Verified ${symbol}`} className="inline-grid size-3.5 shrink-0 cursor-help place-items-center rounded-sm border border-ok bg-ok-bg text-ok">
                    <Icon name="check" size={8} stroke={3.5} />
                </span>
            </TooltipTrigger>
            <TooltipContent sideOffset={6}>This is a verified, widely used token.</TooltipContent>
        </Tooltip>
    );
}

// A verified token's own logo, asked for without cookies; the chain's mark if it does not load. Level with the line's
// first row of text, however many rows its note takes.
function TokenMark({ row }: { row: AssetChange }) {
    const [failed, setFailed] = useState(false);
    if (row.icon && !failed) return <img src={row.icon} alt="" width={18} height={18} crossOrigin="anonymous" referrerPolicy="no-referrer" onError={() => setFailed(true)} className="size-[18px] shrink-0 self-start rounded-[3px] bg-panel object-cover" />;
    return <Logo name={row.icon ? 'chain' : row.logo} size={18} className={cn('self-start rounded-[3px] bg-panel', (row.icon || row.logo === 'chain') && 'text-ink-3')} />;
}

/** Where a transfer made in Otus goes: the address typed, whole, its ends marked; your name for it, if you keep it. */
export function To({ address }: { address: string }) {
    const label = useContext(AddressNames).get(address);
    return (
        <Block>
            <Heading>To</Heading>
            <p className="text-sm leading-relaxed font-bold break-all">
                <span className="text-ok">{address.slice(0, 4)}</span>
                {address.slice(4, -4)}
                <span className="text-ok">{address.slice(-4)}</span>
                {label && <NameTag label={label} />}
            </p>
        </Block>
    );
}

// A balance line as the window lists it: the asset's mark and symbol, by how much; under them, where it goes or comes
// from, or how much is guaranteed, on a line of its own so that it reads whole. `still`: the line opens a list.
function Line({ change, note, amount, tone, still = false, className }: { change: AssetChange; note: string; amount: string; tone: Tone; still?: boolean; className?: string }) {
    return (
        <span className={cn('flex min-w-0 flex-1 items-start gap-2.5', className)}>
            <TokenMark row={change} />
            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="flex items-baseline justify-between gap-2.5">
                    <span className="inline-flex max-w-[96px] min-w-9 shrink-0 items-center gap-1.5 truncate font-bold">
                        <Tagged text={change.asset} still={still} />
                        {change.verified && <Seal symbol={change.asset} />}
                    </span>
                    <span className={cn('amount shrink-0 text-base font-bold', text(tone))}>{amount}</span>
                </span>
                {note && (
                    <span className="note text-xs text-ink-3 [overflow-wrap:anywhere]">
                        <Tagged text={note} still={still} />
                    </span>
                )}
            </span>
        </span>
    );
}

// An asset of yours that moves. One line says it whole; several are summed up, and opened they are listed as lines.
/** Each asset of yours that moves, a row each, or that none does. */
export const Assets = ({ balances }: { balances: AssetChange[] }) =>
    balances.length ? (
        <ul>
            {balances.map((change, i) => (
                <Asset key={i} change={change} />
            ))}
        </ul>
    ) : (
        <p className="text-xs text-ink-3">No balance of yours changes</p>
    );

function Asset({ change }: { change: AssetChange }) {
    const [open, setOpen] = useState(false);
    if (change.lines.length === 1) {
        const [only] = change.lines;
        return (
            <li className="line flex items-baseline gap-2 border-t border-dashed border-rule-2 py-2">
                <span className="w-[13px] shrink-0" />
                <Line change={change} note={only.note} amount={only.amount} tone={only.tone} />
            </li>
        );
    }
    return (
        <Collapsible asChild open={open} onOpenChange={setOpen}>
            <li className="asset border-t border-dashed border-rule-2">
                <CollapsibleTrigger className="line flex w-full cursor-pointer items-baseline gap-2 py-2 text-left outline-none hover:bg-hover focus-visible:bg-hover">
                    <Icon name={open ? 'down' : 'right'} size={13} stroke={2.5} className="shrink-0 self-center text-ink-3" />
                    <Line change={change} note="" amount={change.amount} tone={change.tone} still />
                </CollapsibleTrigger>
                <CollapsibleContent>
                    <ul className="pb-1">
                        {change.lines.map((l, i) => (
                            <li key={i} className="flex items-baseline gap-2 border-t border-dashed border-rule-2 py-2 pl-[21px]">
                                <Line change={change} note={l.note} amount={l.amount} tone={l.tone} />
                            </li>
                        ))}
                    </ul>
                </CollapsibleContent>
            </li>
        </Collapsible>
    );
}

// A proposal's line: its words, any address among them cut short; then the addresses it ends with (who gets what the
// vault sends, a member, who may spend), each on a line of its own, whole, its ends marked as Receive marks them (what
// people compare), your wallet tagged "you".
function Yours({ text: line }: { text: string }) {
    const wallet = useContext(YourWallet);
    const names = useContext(AddressNames);
    const { words, parties } = partiesOf(line);
    return (
        <>
            {words && <Tagged text={words} />}
            {parties.map((address, i) => (
                <span key={i} className="mt-0.5 block font-bold text-ink">
                    <span className="text-ok">{address.slice(0, 4)}</span>
                    {address.slice(4, -4)}
                    <span className="text-ok">{address.slice(-4)}</span>
                    {address === wallet ? <YouTag /> : names.get(address) && <NameTag label={names.get(address)!} />}
                </span>
            ))}
        </>
    );
}

export function Balances({ t }: { t: Reviewed }) {
    return (
        <>
            {t.recipient && <To address={t.recipient} />}
            {t.proposals.map((p, i) => (
                <Block key={i}>
                    <Heading>{p.title}</Heading>
                    {p.you && <p className="text-xs font-bold">{p.you}</p>}
                    <ul className="flex flex-col gap-1">
                        {p.lines.map((l, j) => (
                            <li key={j} className={cn('proposal-line text-xs [overflow-wrap:anywhere]', text(l.tone))}>
                                <Yours text={l.text} />
                            </li>
                        ))}
                    </ul>
                    {p.after && <p className="text-xs text-ink-2">{p.after}</p>}
                </Block>
            ))}
            <Block>
                <Heading extra={<span className="text-xs text-ink-3">{`simulated · ${t.network ?? 'mainnet'}`}</span>}>Balance changes</Heading>
                <Assets balances={t.balances} />
                {t.changes.map((c, i) => (
                    <div key={i} className={cn('change mt-1.5 flex items-start gap-2.5 rounded-[3px] border border-current px-3 py-2.5', filled(c.tone))}>
                        <Icon name={MARK[c.tone]} size={16} stroke={2.5} />
                        <span className="flex flex-col gap-[3px] text-xs">
                            <span className="text-sm font-bold">
                                <Tagged text={c.title} />
                            </span>
                            {c.note && (
                                <span>
                                    <Tagged text={c.note} />
                                </span>
                            )}
                        </span>
                    </div>
                ))}
            </Block>
            {t.guards.text && (
                <Block>
                    <Heading>Guards</Heading>
                    <p className="inline-flex items-center gap-2 text-xs text-ink-2">
                        <Icon name={t.guards.held ? 'check' : 'bang'} size={13} stroke={2.5} />
                        <span>
                            <Tagged text={t.guards.text} />
                        </span>
                    </p>
                </Block>
            )}
            <Block>
                <Heading extra={<span className="font-bold">{t.accounts}</span>}>Accounts involved</Heading>
            </Block>
            {t.hash && (
                <Block>
                    <Heading
                        extra={
                            <Button size="icon" aria-label="Copy message hash" className="h-7 w-11 border-rule" onClick={() => void navigator.clipboard.writeText(t.hash.replaceAll(' ', ''))}>
                                <Icon name="copy" size={14} />
                            </Button>
                        }
                    >
                        Message hash
                    </Heading>
                    <p className="hash text-sm leading-[1.7] [word-spacing:0.3em]">{t.hash}</p>
                    <p className="text-xs text-ink-3">Ledger and Otus show this same hash on their screen.</p>
                </Block>
            )}
        </>
    );
}

export function Programs({ t }: { t: Reviewed }) {
    const { programs: p, instructions: i, inner } = t.counts;
    return (
        <>
            <Block>
                <Heading>Programs and instructions</Heading>
                <p className="text-xs text-ink-3">
                    <Count n={p} one="program" many="programs" /> · <Count n={i} one="instruction" many="instructions" />
                    {inner ? ` · +${inner} called inside` : ''}
                </p>
            </Block>
            <ul className="flex flex-col gap-1.5">
                {t.programs.map((program) => (
                    <Program key={program.address} program={program} open={t.programs.length === 1} />
                ))}
            </ul>
            {t.added.length === 0 && t.guards.why && (
                <Block>
                    <Heading>Added by Otus</Heading>
                    <p className="text-xs text-ink-2">Nothing: {t.guards.why}</p>
                </Block>
            )}
            {t.added.length > 0 && (
                <Block>
                    <Heading>Added by Otus</Heading>
                    <ul>
                        {t.added.map((x) => (
                            <li key={x} className="flex items-start gap-2 text-xs text-ink-2">
                                <Icon name="plus" size={12} stroke={2.5} className="mt-0.5" />
                                <span>
                                    <Tagged text={x} />
                                </span>
                            </li>
                        ))}
                    </ul>
                </Block>
            )}
        </>
    );
}

function Program({ program, open: first }: { program: ProgramView; open: boolean }) {
    const [open, setOpen] = useState(first);
    const [instruction, setInstruction] = useState<number | null>(null);
    return (
        <Collapsible asChild open={open} onOpenChange={setOpen}>
            <li className={cn('program overflow-hidden rounded-[3px] border bg-panel', program.tone === 'warn' ? 'border-warn-bd' : program.tone === 'danger' ? 'border-danger-bd' : 'border-rule-2')}>
                <CollapsibleTrigger className="toggle flex min-h-12 w-full cursor-pointer items-center gap-2 px-2.5 py-2 text-left hover:bg-hover">
                    <Icon name={open ? 'down' : 'right'} size={14} stroke={2.5} />
                    <span className="flex min-w-0 flex-1 flex-col gap-[3px]">
                        <span className="flex min-w-0 items-baseline gap-1.5">
                            <span className="font-bold">{program.name}</span>
                            <span className="truncate text-xs text-ink-3" title={program.address}>
                                <ShortAddress address={program.address} still />
                            </span>
                        </span>
                        <span className={cn('text-xs', program.subTone === 'plain' ? 'text-ink-2' : text(program.subTone))}>
                            <Tagged text={program.sub} still />
                        </span>
                        {program.standing === 'described' && <span className="text-xs text-ink-3">Named by its own IDL</span>}
                    </span>
                    <Standing program={program} />
                </CollapsibleTrigger>
                <CollapsibleContent>
                    <ul className="instructions px-2.5">
                        {program.instructions.map((ix) => (
                            <Step key={ix.number} ix={ix} open={instruction === ix.number} flip={() => setInstruction(instruction === ix.number ? null : ix.number)} />
                        ))}
                    </ul>
                    {program.meta && <p className={cn('meta px-2.5 pt-2 text-xs font-bold', program.metaTone === 'plain' ? 'text-ink-2' : program.metaTone === 'info' ? 'text-info' : text(program.metaTone))}>{program.meta}</p>}
                    {program.inner && (
                        <p className="mt-2 border-t border-dashed border-rule-2 px-2.5 pt-2 pb-2.5 text-xs text-ink-2">
                            <span className="label pixel text-xs text-ink-3">Calls inside </span>
                            <Tagged text={program.inner} />
                        </p>
                    )}
                    <span className="block h-2" aria-hidden="true" />
                </CollapsibleContent>
            </li>
        </Collapsible>
    );
}

const STANDING: Record<ProgramView['standing'], string> = {
    known: 'Known widely used program',
    described: 'Not a program Otus knows · its own IDL describes it',
    unknown: "Not a program Otus knows, and it publishes no IDL: Otus can't read what it does",
};

// Where Otus stands with a program, as a mark: a check for one it knows, a question for one its own IDL describes, a
// warning for one it can't read, red where the review finds it does harm; what each means, on hover.
function Standing({ program }: { program: ProgramView }) {
    const words = STANDING[program.standing];
    const tone = markOf(program);
    return (
        <Tooltip>
            <TooltipTrigger asChild>
                <span role="img" aria-label={words} className={cn('standing grid size-5 shrink-0 place-items-center rounded-[3px] border border-current', tone ? filled(tone) : 'text-ink-3')}>
                    {tone ? <Icon name={MARK[tone]} size={11} stroke={3} /> : <span className="text-xs leading-none font-bold">?</span>}
                </span>
            </TooltipTrigger>
            <TooltipContent sideOffset={6} className="max-w-[220px]">
                {words}
            </TooltipContent>
        </Tooltip>
    );
}

// The tone of a program's mark; null for a neutral one.
function markOf(program: ProgramView): 'ok' | 'warn' | 'danger' | null {
    if (program.standing === 'known') return 'ok';
    if (program.tone === 'danger') return 'danger';
    if (program.tone === 'warn' || program.standing === 'unknown') return 'warn';
    return null;
}

const Badge = ({ tone, children }: { tone: TransactionView['programs'][number]['tone']; children: string }) => (
    <span className={cn('badge shrink-0 rounded-[3px] border border-current px-1.5 py-px text-2xs font-bold whitespace-nowrap uppercase', tone === 'plain' ? 'text-ink-2' : text(tone))}>{children}</span>
);

function Step({ ix, open, flip }: { ix: InstructionView; open: boolean; flip: () => void }) {
    return (
        <li className="instruction border-t border-dashed border-rule-2">
            <button type="button" aria-expanded={open} onClick={flip} className="toggle flex min-h-11 w-full cursor-pointer items-center gap-2 py-1.5 text-left">
                <span className="w-[22px] shrink-0 text-xs text-ink-3">{`#${ix.number}`}</span>
                <span className="flex min-w-0 flex-1 flex-col gap-[3px]">
                    <span className="font-bold">{ix.name}</span>
                    {ix.args && (
                        <span className="text-xs text-ink-2 [overflow-wrap:anywhere]">
                            <Tagged text={ix.args} still />
                        </span>
                    )}
                </span>
                <Badge tone={ix.source === 'unknown' ? 'warn' : 'plain'}>{ix.source}</Badge>
            </button>
            {open && (
                <div className="details flex flex-col gap-[3px] pb-2.5 pl-[30px] text-xs">
                    {ix.accounts.length > 0 && <span className="label pixel mt-1.5 text-xs text-ink-3">Accounts</span>}
                    {ix.accounts.map((a, i) => (
                        <span key={i} className="flex justify-between gap-2">
                            <span className={text(a.tone)}>
                                <Tagged text={a.name} />
                            </span>
                            <span className={cn('text-right text-xs text-ink-2', text(a.tone))}>{a.role}</span>
                        </span>
                    ))}
                    {ix.effects.length > 0 && <span className="label pixel mt-1.5 text-xs text-ink-3">Effect</span>}
                    {ix.effects.map((e, i) => (
                        <span key={i} className={cn('effect text-xs font-bold', e.tone === 'plain' ? 'text-ink' : text(e.tone))}>
                            <Tagged text={e.text} />
                        </span>
                    ))}
                </div>
            )}
        </li>
    );
}

/** The transaction as it will be signed, copied in base64 with a click, a check for a moment: to check it elsewhere. */
export function CopyTransaction({ wire }: { wire: string }) {
    const [done, setDone] = useState(false);
    useEffect(() => {
        if (!done) return;
        const t = setTimeout(() => setDone(false), 1500);
        return () => clearTimeout(t);
    }, [done]);
    return (
        <Tooltip>
            <TooltipTrigger asChild>
                <Button variant="ghost" size="icon" aria-label="Copy transaction data" className={cn('size-7 text-ink-3 hover:text-ink', done && 'text-ok hover:text-ok')} onClick={() => void navigator.clipboard.writeText(wire).then(() => setDone(true))}>
                    <Icon name={done ? 'check' : 'copy'} size={14} stroke={done ? 2.5 : 2} />
                </Button>
            </TooltipTrigger>
            <TooltipContent sideOffset={6}>Copy transaction data</TooltipContent>
        </Tooltip>
    );
}

/** Signing past something critical: ticked first. */
export const Ack = ({ ack, onAck }: { ack: boolean; onAck: (ack: boolean) => void }) => (
    <label className="ack flex cursor-pointer items-center gap-2.5 rounded-[3px] border border-danger px-3 py-2.5 text-xs font-bold">
        <Checkbox checked={ack} onCheckedChange={(v) => onAck(v === true)} className="size-[18px] border-danger data-[state=checked]:border-danger data-[state=checked]:bg-danger" />
        I understand the risk and want to sign anyway
    </label>
);

/** Findings, a line each: a mark in its tone, its title and what it is about. */
export const Findings = ({ lines }: { lines: Line[] }) => (
    <ul>
        {lines.map((f, i) => (
            <li key={i} className="finding flex items-start gap-2.5 border-t border-dashed border-rule-2 py-[9px]">
                <span className={cn('grid size-5 shrink-0 place-items-center rounded-[3px] border border-current', filled(f.tone))}>
                    <Icon name={MARK[f.tone]} size={11} stroke={3} />
                </span>
                <span className="words flex min-w-0 flex-col gap-[3px]">
                    <span className="font-bold">
                        <Tagged text={f.title} />
                    </span>
                    {f.note && (
                        <span className="text-xs text-ink-2">
                            <Tagged text={f.note} />
                        </span>
                    )}
                </span>
            </li>
        ))}
    </ul>
);

/** `onAck`: where signing it is asked, the box to say it is understood, for one not safe; without, it is only shown. */
export function Verdict({ t, ack = false, onAck }: { t: Reviewed; ack?: boolean; onAck?: (ack: boolean) => void }) {
    return (
        <>
            <div className={cn('verdict flex items-center gap-3 rounded-[3px] border border-current p-3.5', filled(t.verdict))}>
                <Icon name={MARK[t.verdict]} size={28} stroke={2.5} />
                <div>
                    <p className="title pixel text-3xl leading-[1.1]">{t.title}</p>
                    <p className="font-bold">
                        <Tagged text={t.sub} />
                    </p>
                </div>
            </div>
            <Findings lines={t.findings} />
            {onAck && t.signer !== 'none' && t.verdict === 'danger' && <Ack ack={ack} onAck={onAck} />}
            {t.signer === 'none' && <Notice>{WATCH_ONLY}</Notice>}
        </>
    );
}
