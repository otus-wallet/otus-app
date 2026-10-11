// The service worker: every site call goes through serve, with the origin the browser reports. Otus's own pages,
// and only they, reach the keystore.
import './chrome.ts'; // the platform, set before any module below uses it
import { getBase64Encoder, type Signature } from '@solana/kit';

import { BUILD } from '@otus-wallet/core/build.ts';
import type { KeysCall, KeysReply } from '@otus-wallet/core/keystore.ts';
import { rpcChain, type Chain } from '@otus-wallet/sdk/chain';
import { rpcAt } from '@otus-wallet/sdk/rpc';
import { send } from '@otus-wallet/core/send/send.ts';
import { throughSender } from '@otus-wallet/core/swap/sender.ts';
import { askedFrom, type Asked } from '@otus-wallet/core/swap/terms.ts';
import { lockMinutes, OTUS_RPC, rpcFor, walletRpc } from '@otus-wallet/core/settings.ts';
import { keepTokens, tokens } from '@otus-wallet/core/tokens.ts';
import type { Approval, Life } from '@otus-wallet/core/view.ts';
import { answerOf, approve, early, kept, type Answer } from './approvals.ts';
import { keysCall, lock, LOCK_ALARM, locked, prune, shielded, sign } from './keys.ts';
import { mainnetTables } from './tables.ts';
import { own, serve, stakeOwn, swapOwn, takeBack } from './serve.ts';
import { edited, load, update, type Edit, type State } from '@otus-wallet/core/state.ts';

void keepTokens(); // what Jupiter said of tokens, kept while the worker sleeps
const WARM_EVERY = 60_000; // ms
const shell = {
    load,
    update,
    approve,
    early,
    sign,
    chain: (rpc: string) => rpcChain(rpcAt(rpc)),
    send: async (signed: Uint8Array, chain: Chain) => send(signed, chain, undefined, (await load()).settings.preflight !== false),
    // Through Otus's server when mainnet is read through it: see tokens.ts.
    tokens: async (mints: string[]) => tokens(mints, rpcFor('solana:mainnet', (await load()).settings) === OTUS_RPC),
    now: Date.now,
    fast: throughSender,
    tables: mainnetTables,
    // At most once a minute, the worker asleep or not, and not while Otus is locked: what the request reads is a
    // blockhash, which tells nothing of the site.
    warm: () =>
        void (async () => {
            const { warmed } = await chrome.storage.session.get('warmed');
            if ((typeof warmed === 'number' && Date.now() - warmed < WARM_EVERY) || (await locked())) return;
            await chrome.storage.session.set({ warmed: Date.now() });
            await rpcChain(rpcAt(walletRpc((await load()).settings))).latest();
        })().catch(() => {}),
    settled: () => void chrome.storage.session.set({ settled: Date.now() }),
};
const PAGES = new URL(chrome.runtime.getURL('')).origin;
const ours = (sender?: chrome.runtime.MessageSender) => sender?.id === chrome.runtime.id && sender.origin === PAGES;
// Otus's popup: the toolbar's, which no tab holds, or Otus's own home page in a review window it kept open after a yes.
const popup = (sender?: chrome.runtime.MessageSender) => !sender?.tab || (kept.has(sender.tab.windowId) && sender.url?.split('#')[0] === chrome.runtime.getURL('home.html'));
const tabs = new Map<number, { origin: string; documentId?: string }>(); // documents that called, to tell them when their accounts change
let reviewing: chrome.runtime.Port | null = null; // the popup's port whose transfer is being reviewed

// A transfer still pending when this worker starts was cut short when the last one stopped. Not signed yet, it was
// not sent; signed, it may have landed: the network says, or the lobby says it is not confirmed yet, with its signature.
chrome.storage.session.get('lastTransfer').then(async ({ lastTransfer }) => {
    const last = lastTransfer as { pending?: boolean; signature?: Signature } | undefined;
    if (!last?.pending) return;
    if (!last.signature) return void chrome.storage.session.set({ lastTransfer: { ok: false, error: 'Otus stopped before it was signed', at: Date.now() } });
    const status = await shell.chain(walletRpc((await load()).settings)).status(last.signature).catch(() => null);
    const outcome = status?.confirmed ? (status.error ? 'failed' : 'confirmed') : 'unknown';
    await chrome.storage.session.set({ lastTransfer: { ok: true, result: { signature: last.signature, outcome }, at: Date.now() }, settled: Date.now() });
});

// Content scripts never need storage: the vault, accounts and settings stay out of their reach. Without that (Chrome
// before 140) the keystore refuses to hold keys.
const sealed = chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' }).then(
    () => true,
    (e) => (console.error('Otus: storage access', e), false),
);

// A new install starts in a tab of its own, where the wallet is set up.
chrome.runtime.onInstalled.addListener(({ reason }) => void (reason === 'install' && chrome.tabs.create({ url: chrome.runtime.getURL('welcome.html') })));

chrome.runtime.onMessage.addListener((message: { call?: unknown; keys?: unknown; edit?: unknown; build?: unknown }, sender, respond) => {
    const origin = sender.origin;
    if (sender.id !== chrome.runtime.id || !origin || typeof message !== 'object' || message === null) return;
    if (ours(sender)) {
        // Which build this background is: a page newer than it asks to reload Otus.
        if ('build' in message) return void respond({ build: BUILD });
        // Changes to accounts and sites, asked by Otus's pages: made here, by the one writer, and never while locked.
        if ('edit' in message) {
            void (async () => {
                if (await shielded()) return respond({ ok: false, error: 'Otus is locked' });
                let changed = false;
                await update((state) => {
                    const part = edited(message as Edit, state, Date.now());
                    changed = part !== null;
                    return part;
                });
                if (changed && (message as Edit).edit === 'remove') await prune(); // its phrase or key too, once no account uses it
                respond(changed ? { ok: true } : { ok: false, error: 'Otus could not save it' });
            })().catch(() => respond({ ok: false, error: 'Otus could not save it' }));
            return true;
        }
        if (!('keys' in message)) return;
        const refused: KeysReply = { ok: false, error: 'Update Chrome: this version lets websites reach extension storage' };
        const call = message as KeysCall;
        sealed
            .then((ok) => (ok ? keysCall(call) : refused))
            .then((reply) => {
                respond(reply);
                if (!UNLOCKING.has(call.keys)) return;
                if (reply.ok && working > 0 && sender.url?.split('#')[0] === APPROVE_PAGE) grace = true;
                settle(false);
            });
        return true;
    }
    if (sender.tab?.id === undefined || sender.frameId !== 0 || !('call' in message)) return;
    tabs.set(sender.tab.id, { origin, documentId: sender.documentId });
    busy(serve(message.call, origin, shell)).then(respond);
    return true; // the answer comes later
});

// Locking. Otus is open while its popup is, or its setup tab is in view; approval windows do not count, since a site
// opens them, and a site must never keep Otus unlocked. Once closed, it locks after the time the user chose. "At
// once" means at once, a request in its window included: it waits only after Otus was unlocked in a review window,
// until that request is done. While open, the alarm keeps being set ahead, so it still goes off if this worker stops
// without seeing the page close.
let open = 0;
let working = 0;
let grace = false; // Otus was unlocked in a review window: it stays so until the requests in flight are done
let holding = false; // that grace is an approved own transfer's, until it is signed
const APPROVE_PAGE = chrome.runtime.getURL('approve.html');
const lockAfter = async () => lockMinutes((await load()).settings.lockAfter);
const arm = (minutes: number) => chrome.alarms.create(LOCK_ALARM, { delayInMinutes: Math.max(minutes, 1) });

const UNLOCKING = new Set(['unlock', 'add', 'derive']); // keystore calls that leave Otus unlocked

// Locked, by whatever: what a review window's unlock held open is over.
chrome.storage.onChanged.addListener((changes, area) => void (area === 'session' && changes.unlocked && changes.unlocked.newValue === undefined && (grace = false)));

// Sets the lock after a page that counts as open opens, beats or closes (`restart`: count again from now), or after a
// keystore call unlocked Otus: armed ahead while open; once closed, the chosen time, or at once unless a review
// window was just unlocked. An unlock while closed starts a count if none runs, and never lengthens one.
async function settle(restart = true) {
    if (await locked()) return;
    const minutes = await lockAfter();
    if (open > 0) return arm(minutes);
    if (minutes === 0 && !grace) return lock();
    if (restart || !(await chrome.alarms.get(LOCK_ALARM))) arm(minutes);
}

// A transfer made in the popup, reviewed there as a site's is in its window: the popup sends it on a port of its own,
// gets the review back, and answers on it; then it hears how it went. A popup closed before answering says no. Once
// approved, how it goes is kept for the lobby too, as the popup may close while it lands: on its way, then signed (with
// its signature, so a worker that stops can still tell), then the outcome. What the popup makes to take access back
// (`fix`), for native stake (`stake`) or a swap (`swap`), goes the same way, and only the screen that made it hears how
// it went.
chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== 'own' || !ours(port.sender) || !popup(port.sender)) return; // the toolbar popup's alone, or a review window gone on to Activity
    let started = false;
    let gone = false;
    let asked: { approval: Approval; ready: boolean; decide: (answer: Answer) => void } | null = null;
    const tell = (m: object) => void (gone || port.postMessage(m));
    const done = () => void (reviewing === port && (reviewing = null)); // answered, or gone: another transfer may be reviewed
    port.onDisconnect.addListener(() => {
        gone = true;
        done();
        asked?.decide(false);
    });
    port.onMessage.addListener((m: { own?: unknown; account?: unknown; to?: unknown; fix?: unknown; stake?: unknown; swap?: unknown; approve?: unknown; signature?: unknown }) => {
        // A yes counts only while Otus is unlocked, as in an approval window: a Ledger's needs no keystore to sign.
        if (asked && 'approve' in m) {
            const { decide, approval, ready } = asked;
            const answer = answerOf(m, approval.kind);
            if (answer && !ready) return; // a yes before the final form counts for nothing
            asked = null; // one answer
            if (!answer) return decide(false);
            return void shielded().then((shut) => decide(!shut && answer), () => decide(false));
        }
        const { own: bytes, account, to } = m;
        const fixing = m.fix === true;
        const staking = m.stake === true;
        const swapAsked = askedFrom(m.swap); // a swap comes with what was asked for, which it is held to
        const swapping = swapAsked !== null;
        if (m.swap !== undefined && !swapping) return;
        // A transfer names whom it pays; taking access back, stake or a swap names no one: one of them, never two.
        const kinds = [fixing, staking, swapping].filter(Boolean).length;
        if (started || typeof bytes !== 'string' || typeof account !== 'string' || kinds > 1 || (typeof to === 'string') === (kinds === 1)) return;
        started = true;
        if (reviewing && reviewing !== port) return tell({ done: { ok: false, error: 'Another transfer of yours is being reviewed' } });
        reviewing = port;
        let told = null as Promise<void> | null; // once approved: what the lobby is told, in order
        const record = (last: object) => (kinds === 1 ? Promise.resolve() : (told = (told ?? Promise.resolve()).then(() => chrome.storage.session.set({ lastTransfer: { ...last, at: Date.now() } }))));
        const approve = (approval: Approval, follow?: (tell: (life: Life) => void) => void, later?: Promise<Approval>) =>
            new Promise<Answer>((decide) => {
                follow?.((life) => tell({ life }));
                later?.then(
                    (final) => {
                        if (asked?.approval !== approval) return; // answered meanwhile
                        asked = { ...asked, approval: final, ready: true };
                        tell({ review: final });
                    },
                    () => asked?.decide(false),
                );
                asked = {
                    approval,
                    ready: !later,
                    decide: (yes) => {
                        asked = null;
                        done();
                        // Approved, it is signed even if the popup closes at once and "at once" would lock: until then.
                        if (yes) {
                            void record({ pending: true });
                            if (!grace) holding = grace = true;
                        }
                        decide(yes);
                    },
                };
                if (gone) asked.decide(false);
                else tell({ review: approval });
            });
        const transfer = (async () => {
            const signed = (signature: Signature) => {
                // Signed: sending needs no key, so the lock goes back to what the user chose.
                if (holding) {
                    holding = grace = false;
                    void settle(false);
                }
                return record({ pending: true, signature });
            };
            const wire = new Uint8Array(getBase64Encoder().encode(bytes));
            const reply = await ownJob(wire, account, to, { ...shell, approve }, signed, { fixing, staking, asked: swapAsked });
            if (told) await record(reply);
            return reply;
        })().finally(() => {
            done();
            // Approved and never signed (refused before it, or failed): what held Otus open for it lets go.
            if (holding) {
                holding = grace = false;
                void settle(false);
            }
        });
        busy(transfer).then(
            (reply) => tell({ done: reply }),
            () => tell({ done: { ok: false, error: 'Otus could not send it' } }),
        );
    });
});

chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== 'open' || !ours(port.sender)) return;
    // The toolbar popup, which no tab holds, and the setup tab: any other page of Otus's in a tab or window, as another
    // extension can open one, keeps nothing open.
    if (!popup(port.sender) && port.sender?.url?.split('#')[0] !== chrome.runtime.getURL('welcome.html')) return;
    open++;
    port.onMessage.addListener(settle); // the page is still there
    port.onDisconnect.addListener(() => (open--, settle()));
    settle();
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
    if (alarm.name !== LOCK_ALARM) return;
    if (open === 0) lock();
    else arm(await lockAfter());
});

// A worker that starts with Otus unlocked and no alarm set lost count of it: count from now.
chrome.alarms.get(LOCK_ALARM).then(async (alarm) => {
    if (alarm || (await locked())) return;
    const minutes = await lockAfter();
    if (minutes === 0) lock();
    else arm(minutes);
});

// While a call is in flight (the user deciding, a transaction landing), calling the extension API keeps the worker alive.
let ping: ReturnType<typeof setInterval> | undefined;
async function busy<T>(work: Promise<T>): Promise<T> {
    if (working++ === 0) ping = setInterval(() => chrome.runtime.getPlatformInfo(), 25_000);
    try {
        return await work;
    } finally {
        if (--working === 0) {
            clearInterval(ping);
            if (grace) {
                grace = false;
                if (open === 0) lockAfter().then((minutes) => void (minutes === 0 && lock())); // "at once" waited for it
            }
        }
    }
}

// A site disconnected in Otus, or connected to another account, hears it at once: only the document that called.
chrome.storage.onChanged.addListener((changes, area) => {
    const sites = changes.sites?.newValue as State['sites'] | undefined;
    if (area !== 'local' || !changes.sites) return;
    void load().then(({ accounts }) => {
        for (const [tab, { origin, documentId }] of tabs) {
            const account = sites?.[origin]?.account;
            const held = accounts.find((a) => a.address === account);
            const v1 = !held?.ledger; // a Ledger misreads v1
            chrome.tabs.sendMessage(tab, { accounts: account ? [account] : [], origin, v1 }, documentId ? { documentId } : {}).catch(() => tabs.delete(tab));
        }
    });
});
chrome.tabs.onRemoved.addListener((tab) => tabs.delete(tab));

// Which of Otus's own jobs the popup sent, to its handler.
function ownJob(wire: Uint8Array, account: string, to: unknown, s: Parameters<typeof own>[3], signed: (signature: Signature) => Promise<unknown>, kind: { fixing: boolean; staking: boolean; asked: Asked | null }) {
    if (kind.fixing) return takeBack(wire, account, s, signed);
    if (kind.staking) return stakeOwn(wire, account, s, signed);
    if (kind.asked) return swapOwn(wire, account, kind.asked, s, signed);
    return own(wire, account, to as string, s, signed);
}
