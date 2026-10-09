// What Otus's pages ask of the platform they run on: the extension's background, storage and tabs in Chrome, the app's
// native side on a phone. The pages reach the platform only through here, so this file lists all they can ask of it.
// Each app installs its own, once, before any page module runs.
import type { KeysCall } from './shell/keys.ts';
import type { Edit } from './shell/state.ts';

/** A message to the background, answered once: a call to the keystore, an edit of the accounts, or which build runs. */
export type Call = KeysCall | Edit | { build: true };

/** A channel to the background for a longer exchange: `open` while a page is open, `own` for a transaction Otus builds,
 *  `approve:<id>` for a site's request. Posting on one that closed throws. */
export type Port = {
    postMessage(message: unknown): void;
    onMessage: { addListener<Message>(listener: (message: Message) => void): void }; // each listener says what it expects
    onDisconnect: { addListener(listener: () => void): void };
    disconnect(): void;
};

/** What a page keeps: `local` stays; `session` is in memory only, gone when the browser closes. */
export type Kept = {
    get(keys: string | Record<string, unknown>): Promise<Record<string, unknown>>; // keys with their defaults, or one key
    set(items: Record<string, unknown>): Promise<void>;
    remove(key: string): Promise<void>;
};
export type Changes = Record<string, { oldValue?: unknown; newValue?: unknown }>;
type Listener = (changes: Changes, area: string) => void;

export type Platform = {
    send(call: Call): Promise<unknown>;
    connect(name: 'open' | 'own' | `approve:${string}`): Port;
    storage: { local: Kept; session: Kept; onChanged: { addListener(listener: Listener): void; removeListener(listener: Listener): void } };
    /** A page of Otus's by its file, and hash if any: `home.html#activity`. */
    url(page: string): string;
    version(): string;
    /** Brings the setup page to the front, the one open if any, or opens it at `hash`. */
    showSetup(hash: string): Promise<void>;
    openTab(page: string): Promise<void>;
    /** Whether this page is in a tab or window of its own, not in the toolbar's popup. */
    inTab(): Promise<boolean>;
    closeTab(): void;
    /** Starts Otus again, its background included. */
    reload(): void;
    /** Whether Otus still runs this page: false once Otus was reloaded or removed under it. */
    alive(): boolean;
};

export let platform: Platform;

/** Sets the platform, once. */
export function install(p: Platform) {
    if (platform) throw new Error('The platform is set already');
    platform = p;
}
