// Otus's lock, over every page of it: the popup, the approval windows, the setup tab. While a vault exists and is
// locked, a page shows the lock and nothing else. What it holds is drawn only once Otus is unlocked, from the start,
// and goes as soon as Otus locks again, from wherever it is locked: a button, the timer, another page. Wallets listed
// with no vault (Ledgers and addresses watched, from before every wallet came with a password) ask for one first.
import { useEffect, useRef, useState, type ReactNode } from 'react';

import { platform } from '@otus-wallet/core/platform.ts';
import type { KeyStatus, KeysReply } from '@otus-wallet/core/keystore.ts';
import { MAX_PASSWORD, MIN_PASSWORD, passwordProblem } from '@otus-wallet/core/password.ts';
import { ask } from '../ask.ts';
import { PasswordInput } from './password.tsx';
import { Strength } from './strength.tsx';
import { Button } from './ui/button.tsx';

/** A request waiting behind the lock: from which site, and saying no to it, which needs no password. */
export type Asking = { host: string; reject: () => void };

const SHUT: KeyStatus = { vault: true, unlocked: false }; // a keystore that does not answer keeps the lock on
const RETRY = 1_000; // ms before a read that failed is tried once more: the background may be starting

/** Otus's initial, as the lock and the popup's other gates show it. */
export const Initial = () => <span className="pixel grid size-[52px] place-items-center rounded-[3px] border border-ok text-3xl text-ok">O</span>;

/** What `children` draw, only while Otus is unlocked, or has no vault and no wallet yet. */
export function Shield({ asking, children }: { asking?: Asking; children: ReactNode }) {
    const [keys, recheck] = useKeys();
    const bare = useBare(keys);
    if (!keys || bare === null) return null; // a moment, while the keystore and the wallets answer
    if (keys.vault && !keys.unlocked) return <Locked asking={asking} unlocked={recheck} />;
    if (bare) return <FirstPassword asking={asking} done={recheck} />;
    return children;
}

// Whether wallets are listed while no vault exists; null until read. Both are read together, again as either changes:
// a wallet added right after its password, before the keystore's status says so, finds the vault there.
function useBare(keys: KeyStatus | null): boolean | null {
    const [bare, setBare] = useState<boolean | null>(null);
    const open = keys !== null && !keys.vault;
    useEffect(() => {
        if (!open) return;
        let live = true;
        const read = () =>
            void Promise.resolve()
                .then(() => platform.storage.local.get({ accounts: [], vault: null }))
                .then(({ accounts, vault }) => live && setBare(Array.isArray(accounts) && accounts.length > 0 && !vault))
                .catch(() => live && setBare(true)); // unread: the password asked all the same
        const changed = (changes: Record<string, unknown>, area: string) => void (area === 'local' && ('accounts' in changes || 'vault' in changes) && read());
        read();
        platform.storage.onChanged.addListener(changed);
        return () => {
            live = false;
            platform.storage.onChanged.removeListener(changed);
        };
    }, [open]);
    return open ? bare : false;
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
                <h1 className="pixel text-lg">Locked</h1>
                {asking && <p className="text-xs text-ink-2">{`Request from ${asking.host}`}</p>}
                <div className="flex w-full flex-col gap-1.5">
                    <PasswordInput placeholder="Password" autoComplete="current-password" aria-label="Password" autoFocus value={password} onChange={(e) => setPassword(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void unlock()} />
                    {error && (
                        <p role="alert" className="text-xs text-danger">
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

// A password for wallets listed with none: set, Otus is unlocked with it, and the page goes on. Beside it, Reject for
// a request waiting.
function FirstPassword({ asking, done }: { asking?: Asking; done: () => void }) {
    const [first, setFirst] = useState('');
    const [again, setAgain] = useState('');
    const [error, setError] = useState('');
    const [busy, setBusy] = useState(false);
    const set = async () => {
        if (busy) return;
        const problem = passwordProblem(first, again);
        if (problem) return setError(problem);
        setBusy(true);
        const reply = await Promise.resolve()
            .then(() => ask({ keys: 'seal', newPassword: first }))
            .catch(() => undefined);
        setBusy(false);
        if (reply?.ok) return done();
        setError(reply?.error ?? 'Otus could not do that');
    };
    return (
        <main className="mx-auto flex h-full min-h-dvh w-full max-w-[400px] flex-col p-6 text-center">
            <div className="flex flex-1 flex-col items-center justify-center gap-3">
                <Initial />
                <h1 className="pixel text-lg">Set a password</h1>
                {asking && <p className="text-xs text-ink-2">{`Request from ${asking.host}`}</p>}
                <p className="text-xs text-ink-2">{`It unlocks Otus on this computer: ${MIN_PASSWORD} to ${MAX_PASSWORD} characters.`}</p>
                <div className="flex w-full flex-col gap-1.5">
                    <PasswordInput placeholder="New password" autoComplete="new-password" aria-label="New password" autoFocus value={first} onChange={(e) => setFirst(e.target.value)} />
                    <Strength password={first} />
                    <PasswordInput placeholder="The same again" autoComplete="new-password" aria-label="The same again" value={again} onChange={(e) => setAgain(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void set()} />
                    {error && (
                        <p role="alert" className="text-xs text-danger">
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
                <Button variant="default" className="flex-1" disabled={busy} onClick={() => void set()}>
                    Set password
                </Button>
            </div>
        </main>
    );
}
