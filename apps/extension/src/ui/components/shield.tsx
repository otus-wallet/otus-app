// Otus's lock, over every page of it: the popup, the approval windows, the setup tab. While a vault exists and is
// locked, a page shows the lock and nothing else. What it holds is drawn only once Otus is unlocked, from the start,
// and goes as soon as Otus locks again, from wherever it is locked: a button, the timer, another page.
import { useEffect, useRef, useState, type ReactNode } from 'react';

import { platform } from '../../platform.ts';
import type { KeyStatus, KeysReply } from '../../shell/keys.ts';
import { ask } from '../ask.ts';
import { PasswordInput } from './password.tsx';
import { Button } from './ui/button.tsx';

/** A request waiting behind the lock: from which site, and saying no to it, which needs no password. */
export type Asking = { host: string; reject: () => void };

const SHUT: KeyStatus = { vault: true, unlocked: false }; // a keystore that does not answer keeps the lock on
const RETRY = 1_000; // ms before a read that failed is tried once more: the background may be starting

/** Otus's initial, as the lock and the popup's other gates show it. */
export const Initial = () => <span className="pixel grid size-[52px] place-items-center rounded-[3px] border border-ok text-2xl text-ok">O</span>;

/** What `children` draw, only while Otus is unlocked, or has no vault to lock. */
export function Shield({ asking, children }: { asking?: Asking; children: ReactNode }) {
    const [keys, recheck] = useKeys();
    if (!keys) return null; // a moment, while the keystore answers
    if (keys.vault && !keys.unlocked) return <Locked asking={asking} unlocked={recheck} />;
    return children;
}

// The keystore's status, read again whenever the vault or its key in the session changes, when the page comes back to
// the front, and when asked (an unlock that wrote the key as it was raises no change); null until first read. A read
// answered after a later one is dropped. Anything but a status keeps the lock on: a read that fails (tried once more),
// an answer of another shape, a page its extension was reloaded under.
function useKeys(): [KeyStatus | null, () => void] {
    const [keys, setKeys] = useState<KeyStatus | null>(null);
    const recheck = useRef(() => {});
    useEffect(() => {
        let latest = 0;
        let live = true;
        const read = (again = true) => {
            const mine = ++latest;
            const set = (k: KeyStatus) => void (live && mine === latest && setKeys(k));
            if (!platform.alive()) return set(SHUT);
            Promise.resolve()
                .then(() => ask({ keys: 'status' }))
                .then((reply) => set(statusOf(reply)))
                .catch(() => {
                    set(SHUT);
                    if (again) setTimeout(() => live && read(false), RETRY);
                });
        };
        const changed = (changes: Record<string, unknown>, area: string) => void (((area === 'session' && 'unlocked' in changes) || (area === 'local' && 'vault' in changes)) && read());
        const back = () => void (document.visibilityState === 'visible' && read());
        recheck.current = () => read();
        read();
        platform.storage.onChanged.addListener(changed);
        addEventListener('focus', back);
        document.addEventListener('visibilitychange', back);
        return () => {
            live = false;
            platform.storage.onChanged.removeListener(changed);
            removeEventListener('focus', back);
            document.removeEventListener('visibilitychange', back);
        };
    }, []);
    return [keys, () => recheck.current()];
}

// A status as the keystore gives it; anything else is read as locked.
function statusOf(reply: KeysReply | undefined): KeyStatus {
    const status = reply?.ok ? (reply.result as Partial<KeyStatus> | null) : null;
    if (typeof status?.vault !== 'boolean' || typeof status.unlocked !== 'boolean') return SHUT;
    return { vault: status.vault, unlocked: status.unlocked };
}

// The password, and Unlock at the bottom; beside it, Reject for a request waiting. The page changes by itself once the
// keystore opens, as the shield follows it; `unlocked` makes sure of it.
function Locked({ asking, unlocked }: { asking?: Asking; unlocked: () => void }) {
    const [password, setPassword] = useState('');
    const [error, setError] = useState('');
    const [busy, setBusy] = useState(false);
    const unlock = async () => {
        if (busy) return;
        setBusy(true);
        const reply = await Promise.resolve()
            .then(() => ask({ keys: 'unlock', password }))
            .catch(() => undefined);
        setBusy(false);
        if (reply?.ok) return unlocked();
        setError(reply?.error ?? 'Otus could not do that');
    };
    return (
        <main className="mx-auto flex h-full min-h-dvh w-full max-w-[400px] flex-col p-6 text-center">
            <div className="flex flex-1 flex-col items-center justify-center gap-3">
                <Initial />
                <h1 className="pixel text-base">Locked</h1>
                {asking && <p className="text-[10.5px] text-ink-2">{`Request from ${asking.host}`}</p>}
                <div className="flex w-full flex-col gap-1.5">
                    <PasswordInput placeholder="Password" autoComplete="current-password" aria-label="Password" autoFocus value={password} onChange={(e) => setPassword(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void unlock()} />
                    {error && (
                        <p role="alert" className="text-[10.5px] text-danger">
                            {error}
                        </p>
                    )}
                </div>
            </div>
            <div className="flex gap-2">
                {asking && (
                    <Button className="flex-1" onClick={asking.reject}>
                        Reject
                    </Button>
                )}
                <Button variant="default" className="flex-1" disabled={busy} onClick={() => void unlock()}>
                    Unlock
                </Button>
            </div>
        </main>
    );
}
