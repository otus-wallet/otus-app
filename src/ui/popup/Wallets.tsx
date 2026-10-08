// All wallets: to switch to one, to put them in your order by dragging (or with the keyboard), and to add more.
import { closestCenter, DndContext, KeyboardSensor, PointerSensor, useSensor, useSensors, type DragEndEvent, type Modifier } from '@dnd-kit/core';
import { arrayMove, SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';

import type { KeyStatus } from '../../shell/keys.ts';
import { walletRpc } from '../../settings.ts';
import type { Account, State } from '../../shell/state.ts';
import { Button } from '../components/ui/button.tsx';
import { Icon, Tile } from '../components/icons.tsx';
import { ask } from '../ask.ts';
import { short } from '../dom.ts';
import { cn } from '../lib/cn.ts';
import type { Screen } from './App.tsx';
import { Bar, CopyAddress, ErrorLine, Sheet } from './common.tsx';
import { dollars } from './money.ts';
import { edit, useHeld } from './store.ts';

const upAndDown: Modifier = ({ transform }) => ({ ...transform, x: 0 }); // a wallet moves along the list only

export function Wallets({ state, keys, go, setUp }: { state: State; keys: KeyStatus; go: (to: Screen) => void; setUp: (hash?: string) => void }) {
    // The order shown: the stored one, or the one just dropped while the background saves it.
    const [order, setOrder] = useState(() => state.accounts.map((a) => a.address));
    useEffect(() => setOrder(state.accounts.map((a) => a.address)), [state.accounts]);
    const [error, setError] = useState('');
    const [deriving, setDeriving] = useState(false);
    const dragging = useRef(false); // a drop ends in a click on the wallet dropped: that click picks nothing
    // A press becomes a drag only once it moves a little, so a click still picks the wallet.
    const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }), useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }));
    const accounts = order.flatMap((address) => state.accounts.filter((a) => a.address === address));
    const rpc = walletRpc(state.settings);

    const dropped = ({ active, over }: DragEndEvent) => {
        setTimeout(() => (dragging.current = false));
        if (!over || active.id === over.id) return;
        const at = (id: unknown) => order.findIndex((a) => a === id);
        const next = arrayMove(order, at(active.id), at(over.id));
        setOrder(next);
        void edit({ edit: 'order', addresses: next });
    };
    const pick = (a: Account) => {
        if (dragging.current) return;
        void edit({ edit: 'use', address: a.address });
        go('lobby');
    };
    const another = async () => {
        if (deriving) return;
        setDeriving(true);
        const reply = await ask({ keys: 'derive', label: `Account ${state.accounts.length + 1}` });
        setDeriving(false);
        if (reply.ok) go('lobby');
        else setError(reply.error);
    };
    const held = useHeld(rpc, accounts.map((a) => a.address));
    const total = (i: number) => (held[i] ? dollars(held[i].usd) : '');
    return (
        <Sheet bar={<Bar title="Wallets" back={() => go('lobby')} />}>
            <DndContext sensors={sensors} collisionDetection={closestCenter} modifiers={[upAndDown]} onDragStart={() => (dragging.current = true)} onDragEnd={dropped} onDragCancel={() => setTimeout(() => (dragging.current = false))}>
                <SortableContext items={order} strategy={verticalListSortingStrategy}>
                    <ul className="picker flex flex-col gap-1.5">
                        {accounts.map((a, i) => (
                            <Row key={a.address} account={a} active={a.address === state.active} total={total(i)} onPick={() => pick(a)} />
                        ))}
                    </ul>
                </SortableContext>
            </DndContext>
            <div className="flex flex-col gap-2">
                {keys.unlocked && state.accounts.some((a) => a.key?.index !== undefined) && <Button disabled={deriving} onClick={() => void another()}>
                        New account from your phrase
                    </Button>}
                <Button onClick={() => setUp('#add')}>Add or import a wallet</Button>
            </div>
            <ErrorLine>{error}</ErrorLine>
        </Sheet>
    );
}

// One wallet in the list: dragged anywhere on it, picked with a click; its grip says it moves, and takes the keyboard
// (space to lift it, arrows to move it, space to drop it), so Enter on the wallet still picks it. Its address copies
// from the row, without picking it.
function Row({ account: a, active, total, onPick }: { account: Account; active: boolean; total: string; onPick: () => void }) {
    const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({ id: a.address });
    const { onKeyDown, ...pointer } = (listeners ?? {}) as { onKeyDown?: (event: KeyboardEvent) => void };
    return (
        <li ref={setNodeRef} data-address={a.address} style={{ transform: CSS.Transform.toString(transform), transition }} className={cn('relative flex items-stretch gap-1.5', isDragging && 'z-10')} {...pointer}>
            <button
                type="button"
                ref={setActivatorNodeRef}
                {...attributes}
                onKeyDown={onKeyDown}
                aria-label={`Move ${a.label}: space, then the arrow keys`}
                className={cn('grip grid w-[26px] shrink-0 place-items-center rounded-md border border-transparent text-ink-3 hover:border-rule-2 hover:text-ink', isDragging ? 'cursor-grabbing text-ok' : 'cursor-grab')}
            >
                <Icon name="grip" size={14} />
            </button>
            <button
                type="button"
                onClick={onPick}
                className={cn(
                    'pick flex min-w-0 flex-1 cursor-pointer items-center gap-2.5 rounded-[3px] border bg-panel px-2.5 py-[9px] text-left',
                    active ? 'border-ok-bd' : 'border-rule-2 hover:border-rule',
                    isDragging && 'border-ok-bd bg-[#08110d] shadow-[0_6px_18px_rgba(0,0,0,0.6)]',
                )}
            >
                <Tile address={a.address} size={28} />
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="truncate font-bold">{a.label}</span>
                    <span className="truncate text-[10.5px] text-ink-3">{`${short(a.address)}${a.key ? '' : a.ledger ? ' · Ledger' : ' · watch only'}`}</span>
                </span>
                <span className="font-bold">{total}</span>
            </button>
            <CopyAddress address={a.address} label={`Copy ${a.label}'s address`} className="h-auto w-[30px] shrink-0 self-stretch rounded-[3px] text-ink-3" />
        </li>
    );
}
