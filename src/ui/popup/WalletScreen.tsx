// One wallet: its name, its address, its signatures, its key or phrase behind the password, and removing it.
import { useEffect, useRef, useState } from 'react';

import type { Account, State } from '../../shell/state.ts';
import { PasswordInput } from '../components/password.tsx';
import { Button } from '../components/ui/button.tsx';
import { Input } from '../components/ui/input.tsx';
import { Icon, Tile } from '../components/icons.tsx';
import { ask } from '../ask.ts';
import type { Screen } from './App.tsx';
import { Bar, CopyButton, ErrorLine, Heading, Sheet } from './common.tsx';
import { current, edit } from './store.ts';

export function WalletScreen({ state, go }: { state: State; go: (to: Screen) => void }) {
    const account = current(state);
    const [name, setName] = useState(account.label);
    const [removing, setRemoving] = useState(false); // an account with a key asks twice before it goes
    const [refused, setRefused] = useState('');
    const n = account.signatures ?? 0;
    const rename = async () => {
        const label = name.trim();
        if (!label) return;
        const reply = (await edit({ edit: 'rename', address: account.address, label })) as { ok: boolean } | undefined;
        setRefused(reply?.ok ? '' : `You have one named ${label} already`);
    };
    const remove = () => {
        if (account.key && !removing) return setRemoving(true);
        void edit({ edit: 'remove', address: account.address });
        go('lobby');
    };
    return (
        <Sheet bar={<Bar title={account.label} back={() => go('lobby')} />}>
            <div className="flex flex-col items-center gap-2 pt-3.5 pb-1 text-center">
                <Tile address={account.address} size={44} />
                <p className="max-w-[260px] text-[11px] break-all text-ink-2">{account.address}</p>
                <CopyButton text={() => account.address} label="Copy address" />
            </div>
            <div className="flex flex-col gap-1.5">
                <Heading>Name</Heading>
                <div className="flex items-center gap-2">
                    <Input value={name} maxLength={32} aria-label="Name" onChange={(e) => (setName(e.target.value), setRefused(''))} onKeyDown={(e) => e.key === 'Enter' && void rename()} />
                    <Button size="sm" variant="default" onClick={() => void rename()}>
                        Save
                    </Button>
                </div>
                <ErrorLine>{refused}</ErrorLine>
            </div>
            <div className="flex flex-col gap-1.5">
                <Heading>Signatures</Heading>
                <p className="inline-flex items-center gap-1.5 text-[10.5px] text-ink-2">
                    <Icon name="fingerprint" size={14} />
                    {`${n} ${n === 1 ? 'signature' : 'signatures'} with Otus`}
                </p>
            </div>
            {account.key ? <Secrets account={account} /> : <Holder account={account} />}
            <div className="flex flex-col gap-1.5">
                <Heading>Remove</Heading>
                <p className="text-[10.5px] text-ink-3">{GONE[holder(account)]}</p>
                <Button size="sm" variant={removing ? 'risky' : 'outline'} className="self-start" onClick={remove}>
                    <Icon name="trash" size={13} />
                    {removing ? 'Sure? Remove it' : 'Remove this wallet'}
                </Button>
            </div>
        </Sheet>
    );
}

const GONE = {
    key: 'This wallet will be removed from Otus. Before you remove it, make sure you have its recovery phrase or private key saved.',
    ledger: 'This wallet will be removed from Otus. Its key stays on your Ledger.',
    watched: 'This wallet will be removed from Otus.',
};

// Where an account's key is: in Otus's vault, on a Ledger, or nowhere Otus knows of.
const holder = (a: Account) => (a.key ? 'key' : a.ledger ? 'ledger' : 'watched');

// Where the key of an account Otus holds none for is.
function Holder({ account }: { account: Account }) {
    const where = { ledger: `Its key is on your Ledger, at ${account.ledger?.path}.` } as Record<string, string>;
    const at = holder(account);
    return (
        <p className="inline-flex items-center gap-2 rounded-[3px] border border-dashed border-rule px-3 py-2.5 text-[11px] text-ink-2">
            <Icon name={at === 'watched' ? 'eye' : 'key'} size={13} />
            {where[at] ?? 'Watch only: Otus holds no key for this address.'}
        </p>
    );
}

// The private key or the recovery phrase, shown only after the password, and gone when the popup closes. Each Show
// starts over: a reply that comes back after Cancel, or for another Show, is dropped. A copied one leaves the clipboard
// as it leaves the screen, on Hide or on going back, and after 60 seconds while the popup is open: the browser lets
// only a page in focus write there. A popup closed first, as when you paste it elsewhere, can't.
function Secrets({ account }: { account: Account }) {
    const [what, setWhat] = useState<'key' | 'phrase' | null>(null);
    const [shown, setShown] = useState('');
    const [password, setPassword] = useState('');
    const [error, setError] = useState('');
    const [busy, setBusy] = useState(false);
    const asking = useRef(0); // the reveal that counts; any other's reply is dropped
    const copied = useRef(false);
    const forget = () => {
        if (copied.current) void navigator.clipboard.writeText('').then(() => (copied.current = false), () => {});
    };
    useEffect(() => forget, []);
    const show = (w: typeof what) => (forget(), asking.current++, setWhat(w), setShown(''), setPassword(''), setError(''), setBusy(false));
    const close = () => show(null);
    if (!what) {
        return (
            <div className="flex flex-col gap-1.5">
                <Heading>Secrets</Heading>
                <div className="flex flex-col gap-2">
                    <Button onClick={() => show('key')}>
                        <Icon name="key" size={14} />
                        Show private key
                    </Button>
                    {account.key?.index !== undefined && (
                        <Button onClick={() => show('phrase')}>
                            <Icon name="eye" size={14} />
                            Show recovery phrase
                        </Button>
                    )}
                </div>
            </div>
        );
    }
    const name = what === 'key' ? 'private key' : 'recovery phrase';
    if (!shown) {
        const reveal = async () => {
            if (busy) return;
            const mine = ++asking.current;
            setBusy(true);
            const reply = await ask({ keys: 'reveal', account: account.address, what, password });
            if (mine !== asking.current) return;
            setBusy(false);
            if (!reply.ok) return setError(reply.error);
            setShown(reply.result as string);
            setPassword('');
        };
        return (
            <div className="flex flex-col gap-1.5">
                <Heading>{`Show ${name}`}</Heading>
                <p className="text-[10.5px] text-warn">{`Anyone who sees your ${name} takes everything in this wallet. Make sure no one is watching.`}</p>
                <PasswordInput placeholder="Password" autoComplete="current-password" aria-label="Password" autoFocus value={password} onChange={(e) => setPassword(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void reveal()} />
                <ErrorLine>{error}</ErrorLine>
                <div className="flex justify-end gap-2">
                    <Button size="sm" onClick={close}>
                        Cancel
                    </Button>
                    <Button size="sm" variant="default" disabled={busy} onClick={() => void reveal()}>
                        {`Show ${name}`}
                    </Button>
                </div>
            </div>
        );
    }
    return (
        <div className="flex flex-col gap-1.5">
            <Heading>{`Your ${name}`}</Heading>
            {what === 'phrase' ? (
                <ol className="phrase grid grid-cols-3 gap-x-1.5 gap-y-2 rounded-[3px] border border-rule bg-panel p-3">
                    {shown.split(' ').map((word, i) => (
                        <li key={i} className="flex gap-1.5 text-xs font-bold whitespace-nowrap">
                            <span className="w-4 text-right font-normal text-ink-3">{i + 1}</span>
                            {word}
                        </li>
                    ))}
                </ol>
            ) : (
                <p className="rounded-[3px] border border-rule bg-panel px-3 py-2.5 text-[11px] break-all select-all">{shown}</p>
            )}
            <p className="text-[10.5px] text-ink-3">Copied, it leaves your clipboard when you hide it.</p>
            <div className="flex justify-end gap-2">
                <CopyButton text={() => shown} onCopy={() => ((copied.current = true), setTimeout(forget, 60_000))} />
                <Button size="sm" onClick={close}>
                    Hide
                </Button>
            </div>
        </div>
    );
}
