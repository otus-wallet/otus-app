// Otus's setup, in a tab of its own: a new wallet, or one you have. Settings live in the popup, never here. Once a
// vault exists, the page shows only while Otus is unlocked (main.tsx).
import { isAddress } from '@solana/kit';
import { useEffect, useState } from 'react';

import { platform } from '../../platform.ts';
import type { KeyStatus } from '../../shell/keys.ts';
import { load, type Account, type State } from '../../shell/state.ts';
import { PasswordInput } from '../components/password.tsx';
import { Button } from '../components/ui/button.tsx';
import { Input } from '../components/ui/input.tsx';
import { Textarea } from '../components/ui/textarea.tsx';
import { Icon, Tile } from '../components/icons.tsx';
import { ask } from '../ask.ts';
import { short } from '../dom.ts';
import { cn } from '../lib/cn.ts';
import { LedgerAccounts } from './Ledger.tsx';
import { ErrorLine, Heading, Lead, Muted, Row, Soft } from './parts.tsx';

export type Page = 'start' | 'create' | 'password' | 'phrase' | 'key' | 'watch' | 'ledger' | 'done';
const CLIPBOARD_SECONDS = 60;

// The copied phrase does not stay in the clipboard, where clipboard history and other apps can read it. The browser
// lets only a page in focus write there: a clear it refused is done when the page has the focus again.
let copied = 0; // when this page put a phrase in the clipboard, still there; 0 when none is
let due = false; // to be cleared
const RETRY = 5 * 60_000; // ms after the copy that a refused clear is tried again: later, the clipboard may hold something else
export function forget() {
    if (!copied) return;
    due = true;
    navigator.clipboard.writeText('').then(() => ((copied = 0), (due = false)), () => {});
}
/** The page has the focus again: a clear refused meanwhile is done now, while the copy is recent. */
export const again = () => void (due && Date.now() - copied < RETRY ? forget() : (due = false));

const nextName = (state: State) => `Account ${state.accounts.length + 1}`;

export function Setup() {
    const [now, setNow] = useState<{ state: State; keys: KeyStatus } | null>(null);
    const [page, setPage] = useState<Page>(location.hash === '#ledger' ? 'ledger' : 'start'); // #ledger: sent here to connect one
    const [made, setMade] = useState<Account | null>(null);
    const [shown, setShown] = useState(''); // the new phrase on show, saved as it was shown
    const [length, setLength] = useState<12 | 24>(12);
    useEffect(() => {
        void Promise.all([load(), ask({ keys: 'status' })]).then(([state, reply]) => setNow({ state, keys: reply.ok ? (reply.result as KeyStatus) : { vault: false, unlocked: false } }));
    }, [page]);
    if (!now) return null;
    const { state, keys } = now;
    const go = (to: Page) => setPage(to);
    const finished = (account: Account) => (setMade(account), setShown(''), go('done'));
    return (
        <main className="mx-auto flex max-w-[480px] flex-col gap-4 px-5 pt-10 pb-14">
            <header className="flex items-center gap-2.5">
                <span className="pixel grid size-8 place-items-center rounded-[3px] border border-ok text-sm text-ok">O</span>
                <span className="pixel text-base">Otus</span>
            </header>
            {page === 'start' && <Start adding={keys.vault || state.accounts.length > 0} go={go} />}
            {page === 'create' && <Create length={length} setLength={setLength} shown={shown} setShown={setShown} go={go} />}
            {page === 'password' && (shown ? <Password phrase={shown} state={state} keys={keys} go={go} finished={finished} /> : <Create length={length} setLength={setLength} shown={shown} setShown={setShown} go={go} />)}
            {page === 'phrase' && <ImportPhrase state={state} keys={keys} go={go} finished={finished} />}
            {page === 'key' && <ImportKey state={state} keys={keys} go={go} finished={finished} />}
            {page === 'watch' && <Watch state={state} go={go} finished={finished} />}
            {page === 'ledger' && <LedgerAccounts state={state} go={go} finished={finished} />}
            {page === 'done' && <Done made={made} go={go} />}
        </main>
    );
}

function Start({ adding, go }: { adding: boolean; go: (to: Page) => void }) {
    return (
        <>
            <Lead>{adding ? 'Add a wallet' : 'Welcome'}</Lead>
            <Soft>Start with a new wallet, or bring one you have.</Soft>
            <div className="flex flex-col gap-2">
                <Button variant="default" className="h-12" onClick={() => go('create')}>
                    Create a new wallet
                </Button>
                <Button className="h-12" onClick={() => go('phrase')}>
                    Import a recovery phrase
                </Button>
                <Button className="h-12" onClick={() => go('key')}>
                    Import a private key
                </Button>
                <Button className="h-12" onClick={() => go('ledger')}>
                    Connect a Ledger
                    <Icon name="ledger" size={15} />
                </Button>
                <Button className="h-12" onClick={() => go('watch')}>
                    Watch an address
                </Button>
            </div>
        </>
    );
}

// A new phrase, 12 or 24 words. The background keeps the same one until it is added, so what is written down is what
// gets saved even if this tab is closed in between; and this page saves the very words it showed, whatever another tab
// asked for meanwhile: a reply for a length no longer chosen, or after leaving the page, is dropped. Once written down:
// the password, then done.
function Create({ length, setLength, shown, setShown, go }: { length: 12 | 24; setLength: (n: 12 | 24) => void; shown: string; setShown: (s: string) => void; go: (to: Page) => void }) {
    const [error, setError] = useState('');
    const [done, setDone] = useState(false);
    useEffect(() => {
        let live = true;
        setShown('');
        setDone(false);
        void ask({ keys: 'phrase', words: length }).then((reply) => {
            if (!live) return;
            if (!reply.ok) return setError(reply.error);
            const phrase = reply.result as string;
            if (phrase.split(' ').length === length) setShown(phrase);
        });
        return () => {
            live = false;
        };
    }, [length]);
    if (error) return <ErrorLine>{error}</ErrorLine>;
    const words = shown ? shown.split(' ') : [];
    const copy = async () => {
        await navigator.clipboard.writeText(shown);
        copied = Date.now();
        setTimeout(forget, CLIPBOARD_SECONDS * 1000);
        setDone(true);
    };
    const size = (n: 12 | 24) => (
        <button key={n} type="button" aria-pressed={length === n} onClick={() => setLength(n)} className={cn('h-7 cursor-pointer rounded-[3px] border px-[9px] text-[11px] font-bold', length === n ? 'border-ok-bd bg-ok-bg text-ok' : 'border-rule text-ink-2 hover:border-ink-3')}>
            {`${n} words`}
        </button>
    );
    return (
        <>
            <Lead>Your recovery phrase</Lead>
            <Soft>Write these words down in order and keep them offline. Anyone with them takes everything in this wallet, and no one can give them back to you.</Soft>
            <div className="flex items-center justify-between gap-2">
                <div className="flex gap-1.5">{[size(12), size(24)]}</div>
                <Button size="sm" disabled={!shown} onClick={() => void copy()}>
                    {done ? 'Copied' : 'Copy'}
                </Button>
            </div>
            <ol className={cn('phrase grid gap-x-1.5 gap-y-2 rounded-[3px] border border-rule bg-panel p-3', words.length === 24 ? 'grid-cols-4' : 'grid-cols-3')}>
                {words.map((w, i) => (
                    <li key={i} className="flex gap-1.5 text-xs font-bold whitespace-nowrap">
                        <span className="w-4 text-right font-normal text-ink-3">{i + 1}</span>
                        {w}
                    </li>
                ))}
            </ol>
            <Muted>Copied words leave your clipboard when you go on.</Muted>
            <Row>
                <Button size="sm" onClick={() => go('start')}>
                    Back
                </Button>
                <Button size="sm" variant="default" disabled={!shown} onClick={() => (forget(), go('password'))}>
                    I wrote them down
                </Button>
            </Row>
        </>
    );
}

// A new password when there is no vault yet. With one, nothing: this page shows only while Otus is unlocked.
type Credentials = { newPassword?: string };

function usePassword(keys: KeyStatus) {
    const [first, setFirst] = useState('');
    const [again, setAgain] = useState('');
    if (keys.vault) return { fields: null, value: (): Credentials | Error => ({}) };
    const value = (): Credentials | Error => {
        if (first.length < 8) return new Error('Use a password of 8 characters or more');
        if (first !== again) return new Error('The two passwords differ');
        return { newPassword: first };
    };
    const fields = (
        <>
            <Heading>Password</Heading>
            <Muted>It unlocks Otus on this computer: 8 characters or more. Your phrase is the only way back if you forget it.</Muted>
            <div className="flex flex-col gap-1.5">
                <PasswordInput placeholder="New password" autoComplete="new-password" aria-label="New password" autoFocus value={first} onChange={(e) => setFirst(e.target.value)} />
                <PasswordInput placeholder="The same again" autoComplete="new-password" aria-label="The same again" value={again} onChange={(e) => setAgain(e.target.value)} />
            </div>
        </>
    );
    return { fields, value };
}

// Adds a phrase or a key (the first with a new password), then shows it done. The button waits while the background
// works.
function useAdding(state: State, keys: KeyStatus, finished: (a: Account) => void) {
    const password = usePassword(keys);
    const [error, setError] = useState('');
    const [busy, setBusy] = useState(false);
    const submit = async (from: { phrase: string } | { privateKey: string }, name: string) => {
        const credentials = password.value();
        if (credentials instanceof Error) return setError(credentials.message);
        setBusy(true);
        setError('');
        const reply = await ask({ keys: 'add', from, label: name.trim() || nextName(state), ...credentials });
        setBusy(false);
        if (!reply.ok) return setError(reply.error ?? 'Otus could not do that');
        finished(reply.result as Account);
    };
    return { fields: password.fields, error: <ErrorLine>{error}</ErrorLine>, busy, submit };
}

function Password({ phrase, state, keys, go, finished }: { phrase: string; state: State; keys: KeyStatus; go: (to: Page) => void; finished: (a: Account) => void }) {
    const form = useAdding(state, keys, finished);
    return (
        <>
            <Lead>Last step</Lead>
            {form.fields}
            {form.error}
            <Row>
                <Button size="sm" onClick={() => go('create')}>
                    See the words
                </Button>
                <Button size="sm" variant="default" disabled={form.busy} onClick={() => void form.submit({ phrase }, '')}>
                    Create
                </Button>
            </Row>
        </>
    );
}

function ImportPhrase({ state, keys, go, finished }: { state: State; keys: KeyStatus; go: (to: Page) => void; finished: (a: Account) => void }) {
    const [words, setWords] = useState('');
    const [name, setName] = useState('');
    const form = useAdding(state, keys, finished);
    return (
        <>
            <Lead>Import a recovery phrase</Lead>
            <div className="flex flex-col gap-1.5">
                <Textarea className="h-[76px] resize-none" placeholder="12 or 24 words" spellCheck={false} autoComplete="off" aria-label="Recovery phrase" autoFocus value={words} onChange={(e) => setWords(e.target.value)} />
                <Input placeholder={nextName(state)} maxLength={32} aria-label="Name" value={name} onChange={(e) => setName(e.target.value)} />
            </div>
            <Muted>Its first account, as Phantom, Solflare and Backpack derive it; the popup adds the next ones.</Muted>
            {form.fields}
            {form.error}
            <Row>
                <Button size="sm" onClick={() => go('start')}>
                    Back
                </Button>
                <Button size="sm" variant="default" disabled={form.busy} onClick={() => void form.submit({ phrase: words }, name)}>
                    Import
                </Button>
            </Row>
        </>
    );
}

function ImportKey({ state, keys, go, finished }: { state: State; keys: KeyStatus; go: (to: Page) => void; finished: (a: Account) => void }) {
    const [secret, setSecret] = useState('');
    const [name, setName] = useState('');
    const form = useAdding(state, keys, finished);
    return (
        <>
            <Lead>Import a private key</Lead>
            <div className="flex flex-col gap-1.5">
                <PasswordInput what="private key" placeholder="Private key" autoComplete="off" aria-label="Private key" autoFocus value={secret} onChange={(e) => setSecret(e.target.value)} />
                <Input placeholder={nextName(state)} maxLength={32} aria-label="Name" value={name} onChange={(e) => setName(e.target.value)} />
            </div>
            <Muted>The whole key, as Phantom or Solflare export it in base58, or the list of numbers in a solana-keygen file.</Muted>
            {form.fields}
            {form.error}
            <Row>
                <Button size="sm" onClick={() => go('start')}>
                    Back
                </Button>
                <Button size="sm" variant="default" disabled={form.busy} onClick={() => void form.submit({ privateKey: secret }, name)}>
                    Import
                </Button>
            </Row>
        </>
    );
}

function Watch({ state, go, finished }: { state: State; go: (to: Page) => void; finished: (a: Account) => void }) {
    const [address, setAddress] = useState('');
    const [name, setName] = useState('');
    const [error, setError] = useState('');
    const add = async () => {
        const a = address.trim();
        if (!isAddress(a)) return setError('That is not a Solana address');
        const now = await load();
        if (now.accounts.some((x) => x.address === a)) return setError('That account is in Otus already');
        const reply = (await platform.send({ edit: 'watch', address: a, label: name.trim() })) as { ok: boolean } | undefined; // the background writes accounts, and names one left unnamed
        if (!reply?.ok) return setError(name.trim() ? 'Otus did not add it: it looks like an address you have, or that name is taken' : 'Otus did not add it: it looks like an address you have');
        finished((await load()).accounts.find((x) => x.address === a) ?? { address: a, label: name.trim() });
    };
    return (
        <>
            <Lead>Watch an address</Lead>
            <div className="flex flex-col gap-1.5">
                <Input placeholder="Solana address" spellCheck={false} autoComplete="off" aria-label="Address" autoFocus value={address} onChange={(e) => setAddress(e.target.value)} />
                <Input placeholder={nextName(state)} maxLength={32} aria-label="Name" value={name} onChange={(e) => setName(e.target.value)} />
                <ErrorLine>{error}</ErrorLine>
            </div>
            <Muted>An address alone: Otus shows you every request for it, but cannot sign.</Muted>
            <Row>
                <Button size="sm" onClick={() => go('start')}>
                    Back
                </Button>
                <Button size="sm" variant="default" onClick={() => void add()}>
                    Add
                </Button>
            </Row>
        </>
    );
}

function Done({ made, go }: { made: Account | null; go: (to: Page) => void }) {
    const close = () => chrome.tabs.getCurrent((t) => void (t?.id !== undefined && chrome.tabs.remove(t.id)));
    return (
        <>
            <Lead>Ready</Lead>
            {made && (
                <div className="flex items-center gap-3 rounded-[3px] border border-rule bg-panel p-3">
                    <Tile address={made.address} size={36} />
                    <span className="flex min-w-0 flex-col gap-0.5">
                        <span className="font-bold">{made.label}</span>
                        <span className="text-[10.5px] text-ink-2">{short(made.address)}</span>
                    </span>
                </div>
            )}
            <Soft>Open Otus from the puzzle piece in Chrome's toolbar, and pin it to keep it at hand.</Soft>
            <Row>
                <Button size="sm" onClick={() => go('start')}>
                    Add another
                </Button>
                <Button size="sm" variant="default" onClick={close}>
                    Close this tab
                </Button>
            </Row>
        </>
    );
}
