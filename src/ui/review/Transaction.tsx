// A transaction's three steps: where your balances go, what each program does, and the verdict.
import { useEffect, useState, type ReactNode } from 'react';

import { Button } from '../components/ui/button.tsx';
import { Checkbox } from '../components/ui/checkbox.tsx';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '../components/ui/collapsible.tsx';
import { Tooltip, TooltipContent, TooltipTrigger } from '../components/ui/tooltip.tsx';
import { Icon, Logo } from '../components/icons.tsx';
import { short } from '../dom.ts';
import { cn } from '../lib/cn.ts';
import type { AssetChange, InstructionView, ProgramView, Tone, TransactionView } from '../view.ts';
import { Block, Heading, Notice, WATCH_ONLY } from './Frame.tsx';
import { filled, MARK, text } from './tone.ts';
import { Tagged, YouTag } from '../components/you.tsx';
import { YOU } from '../view/names.ts';

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

// A verified token's own logo, asked for without cookies; the chain's mark if it does not load.
function TokenMark({ row }: { row: AssetChange }) {
    const [failed, setFailed] = useState(false);
    if (row.icon && !failed) return <img src={row.icon} alt="" width={18} height={18} crossOrigin="anonymous" referrerPolicy="no-referrer" onError={() => setFailed(true)} className="size-[18px] shrink-0 self-center rounded-[3px] bg-panel object-cover" />;
    return <Logo name={row.icon ? 'chain' : row.logo} size={18} className={cn('self-center rounded-[3px] bg-panel', (row.icon || row.logo === 'chain') && 'text-ink-3')} />;
}

/** Where a transfer made in Otus goes: the address typed, whole, its ends marked. */
export function To({ address }: { address: string }) {
    return (
        <Block>
            <Heading>To</Heading>
            <p className="text-xs leading-relaxed font-bold break-all">
                <span className="text-ok">{address.slice(0, 4)}</span>
                {address.slice(4, -4)}
                <span className="text-ok">{address.slice(-4)}</span>
            </p>
        </Block>
    );
}

// A balance line as the window lists it: the asset's mark and symbol, where it goes or comes from, by how much.
function Line({ change, note, amount, tone, className }: { change: AssetChange; note: string; amount: string; tone: Tone; className?: string }) {
    return (
        <span className={cn('flex min-w-0 flex-1 items-baseline gap-2.5', className)}>
            <TokenMark row={change} />
            <span className="inline-flex max-w-[96px] min-w-9 shrink-0 items-center gap-1.5 truncate font-bold">
                {change.asset}
                {change.verified && <Seal symbol={change.asset} />}
            </span>
            <span className="min-w-0 flex-1 text-[10.5px] text-ink-3">{note}</span>
            <span className={cn('amount shrink-0 text-[13px] font-bold', text(tone))}>{amount}</span>
        </span>
    );
}

// An asset of yours that moves. One line says it whole; several are summed up, and opened they are listed as lines.
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
                    <Line change={change} note="" amount={change.amount} tone={change.tone} />
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

// A proposal's line: its words, then each address on a line of its own, whole, its ends marked as Receive marks them
// (what people compare), yours tagged "you".
function Yours({ text: line }: { text: string }) {
    const parts = line.split(new RegExp(`([1-9A-HJ-NP-Za-km-z]{32,44})(${YOU.replace(/[()]/g, '\\$&')})?`));
    const out: ReactNode[] = [];
    for (let i = 0; i < parts.length; i += 3) {
        const words = parts[i].replace(/^[,\s]+$/, ''); // what only parts two addresses goes
        if (words) out.push(<span key={i}>{words}</span>);
        const address = parts[i + 1];
        if (!address) continue;
        out.push(
            <span key={`a${i}`} className="mt-0.5 block font-bold text-ink">
                <span className="text-ok">{address.slice(0, 4)}</span>
                {address.slice(4, -4)}
                <span className="text-ok">{address.slice(-4)}</span>
                {parts[i + 2] && <YouTag />}
            </span>,
        );
    }
    return <>{out}</>;
}

export function Balances({ t }: { t: TransactionView }) {
    return (
        <>
            {t.recipient && <To address={t.recipient} />}
            {t.proposals.map((p, i) => (
                <Block key={i}>
                    <Heading>{p.title}</Heading>
                    {p.you && <p className="text-[11px] font-bold">{p.you}</p>}
                    <ul className="flex flex-col gap-1">
                        {p.lines.map((l, j) => (
                            <li key={j} className={cn('proposal-line text-[11px] [overflow-wrap:anywhere]', text(l.tone))}>
                                <Yours text={l.text} />
                            </li>
                        ))}
                    </ul>
                    {p.after && <p className="text-[11px] text-ink-2">{p.after}</p>}
                </Block>
            ))}
            <Block>
                <Heading extra={<span className="text-[10.5px] text-ink-3">{`simulated · ${t.network ?? 'mainnet'}`}</span>}>Balance changes</Heading>
                {t.balances.length ? (
                    <ul>
                        {t.balances.map((change, i) => (
                            <Asset key={i} change={change} />
                        ))}
                    </ul>
                ) : (
                    <p className="text-[10.5px] text-ink-3">No balance of yours changes</p>
                )}
                {t.changes.map((c, i) => (
                    <div key={i} className={cn('change mt-1.5 flex items-start gap-2.5 rounded-[3px] border border-current px-3 py-2.5', filled(c.tone))}>
                        <Icon name={MARK[c.tone]} size={16} stroke={2.5} />
                        <span className="flex flex-col gap-[3px] text-[10.5px]">
                            <span className="text-xs font-bold">{c.title}</span>
                            {c.note && <span>{c.note}</span>}
                        </span>
                    </div>
                ))}
            </Block>
            {t.guards.text && (
                <Block>
                    <Heading>Guards</Heading>
                    <p className="inline-flex items-center gap-2 text-[10.5px] text-ink-2">
                        <Icon name={t.guards.held ? 'check' : 'bang'} size={13} stroke={2.5} />
                        {t.guards.text}
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
                    <p className="hash text-xs leading-[1.7] [word-spacing:0.3em]">{t.hash}</p>
                    <p className="text-[10.5px] text-ink-3">Ledger and Otus show this same hash on their screen.</p>
                </Block>
            )}
        </>
    );
}

export function Programs({ t }: { t: TransactionView }) {
    const { programs: p, instructions: i, inner } = t.counts;
    return (
        <>
            <Block>
                <Heading>Programs and instructions</Heading>
                <p className="text-[10.5px] text-ink-3">
                    <Count n={p} one="program" many="programs" /> · <Count n={i} one="instruction" many="instructions" />
                    {inner ? ` · +${inner} called inside` : ''}
                </p>
            </Block>
            <ul className="flex flex-col gap-1.5">
                {t.programs.map((program) => (
                    <Program key={program.address} program={program} open={t.programs.length === 1} />
                ))}
            </ul>
            {t.added.length > 0 && (
                <Block>
                    <Heading>Added by Otus</Heading>
                    <ul>
                        {t.added.map((x) => (
                            <li key={x} className="flex items-start gap-2 text-[10.5px] text-ink-2">
                                <Icon name="plus" size={12} stroke={2.5} className="mt-0.5" />
                                {x}
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
                            <span className="truncate text-[10.5px] text-ink-3" title={program.address}>
                                {short(program.address)}
                            </span>
                        </span>
                        <span className={cn('text-[10.5px]', program.subTone === 'plain' ? 'text-ink-2' : text(program.subTone))}>{program.sub}</span>
                        {program.standing === 'described' && <span className="text-[10.5px] text-ink-3">Named by its own IDL</span>}
                    </span>
                    <Standing program={program} />
                </CollapsibleTrigger>
                <CollapsibleContent>
                    <ul className="instructions px-2.5">
                        {program.instructions.map((ix) => (
                            <Step key={ix.number} ix={ix} open={instruction === ix.number} flip={() => setInstruction(instruction === ix.number ? null : ix.number)} />
                        ))}
                    </ul>
                    {program.meta && <p className={cn('meta px-2.5 pt-2 text-[10.5px] font-bold', program.metaTone === 'plain' ? 'text-ink-2' : program.metaTone === 'info' ? 'text-info' : text(program.metaTone))}>{program.meta}</p>}
                    {program.inner && (
                        <p className="mt-2 border-t border-dashed border-rule-2 px-2.5 pt-2 pb-2.5 text-[10.5px] text-ink-2">
                            <span className="label pixel text-[9px] text-ink-3">Calls inside </span>
                            {program.inner}
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
                    {tone ? <Icon name={MARK[tone]} size={11} stroke={3} /> : <span className="text-[11px] leading-none font-bold">?</span>}
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
    <span className={cn('badge shrink-0 rounded-[3px] border border-current px-1.5 py-px text-[9.5px] font-bold whitespace-nowrap uppercase', tone === 'plain' ? 'text-ink-2' : text(tone))}>{children}</span>
);

function Step({ ix, open, flip }: { ix: InstructionView; open: boolean; flip: () => void }) {
    return (
        <li className="instruction border-t border-dashed border-rule-2">
            <button type="button" aria-expanded={open} onClick={flip} className="toggle flex min-h-11 w-full cursor-pointer items-center gap-2 py-1.5 text-left">
                <span className="w-[22px] shrink-0 text-[10.5px] text-ink-3">{`#${ix.number}`}</span>
                <span className="flex min-w-0 flex-1 flex-col gap-[3px]">
                    <span className="font-bold">{ix.name}</span>
                    {ix.args && (
                        <span className="text-[10.5px] text-ink-2 [overflow-wrap:anywhere]">
                            <Tagged text={ix.args} />
                        </span>
                    )}
                </span>
                <Badge tone={ix.source === 'unknown' ? 'danger' : 'plain'}>{ix.source}</Badge>
            </button>
            {open && (
                <div className="details flex flex-col gap-[3px] pb-2.5 pl-[30px] text-[11px]">
                    {ix.accounts.length > 0 && <span className="label pixel mt-1.5 text-[9px] text-ink-3">Accounts</span>}
                    {ix.accounts.map((a, i) => (
                        <span key={i} className="flex justify-between gap-2">
                            <span className={text(a.tone)}>
                                <Tagged text={a.name} />
                            </span>
                            <span className={cn('text-right text-[10px] text-ink-2', text(a.tone))}>{a.role}</span>
                        </span>
                    ))}
                    {ix.effects.length > 0 && <span className="label pixel mt-1.5 text-[9px] text-ink-3">Effect</span>}
                    {ix.effects.map((e, i) => (
                        <span key={i} className={cn('effect text-[11px] font-bold', e.tone === 'plain' ? 'text-ink' : text(e.tone))}>
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

export function Verdict({ t, ack, onAck }: { t: TransactionView; ack: boolean; onAck: (ack: boolean) => void }) {
    return (
        <>
            <div className={cn('verdict flex items-center gap-3 rounded-[3px] border border-current p-3.5', filled(t.verdict))}>
                <Icon name={MARK[t.verdict]} size={28} stroke={2.5} />
                <div>
                    <p className="title pixel text-[22px] leading-[1.1]">{t.title}</p>
                    <p className="font-bold">{t.sub}</p>
                </div>
            </div>
            <ul>
                {t.findings.map((f, i) => (
                    <li key={i} className="finding flex items-start gap-2.5 border-t border-dashed border-rule-2 py-[9px]">
                        <span className={cn('grid size-5 shrink-0 place-items-center rounded-[3px] border border-current', filled(f.tone))}>
                            <Icon name={MARK[f.tone]} size={11} stroke={3} />
                        </span>
                        <span className="words flex min-w-0 flex-col gap-[3px]">
                            <span className="font-bold">{f.title}</span>
                            {f.note && <span className="text-[10.5px] text-ink-2">{f.note}</span>}
                        </span>
                    </li>
                ))}
            </ul>
            {t.signer !== 'none' && t.verdict === 'danger' && (
                <label className="ack flex cursor-pointer items-center gap-2.5 rounded-[3px] border border-danger px-3 py-2.5 text-[11.5px] font-bold">
                    <Checkbox checked={ack} onCheckedChange={(v) => onAck(v === true)} className="size-[18px] border-danger data-[state=checked]:border-danger data-[state=checked]:bg-danger" />
                    I understand the risk and want to sign anyway
                </label>
            )}
            {t.signer === 'none' && <Notice>{WATCH_ONLY}</Notice>}
        </>
    );
}
