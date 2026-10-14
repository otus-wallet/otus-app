import { getBase64Encoder, isAddress, type Address, type SignatureBytes } from '@solana/kit';

import { MAX_BATCH, Refused } from '@otus-wallet/core/protocol.ts';
import type { Approval, Life, Outcome } from '@otus-wallet/core/view.ts';
import { shielded } from './keys.ts';

const PAGE = 'approve.html';
const [WIDTH, HEIGHT] = [400, 680];
/** An answer: no, yes, yes with the signature a Ledger made (or, for several transactions, each one's in their order),
 *  or, to connect, yes with the account chosen. */
export type Answer = boolean | SignatureBytes | SignatureBytes[] | { account: Address };

// `ready`: the approval is in its final form, the only one a yes counts for; `told`: the window, to hear it; `follow`: its
// blockhash's life, for the window; `after`: approved, how it goes, for the window that stays; `port`: the window's own;
// `opened`: the window Otus opened for it, once it has (undefined when it did not open); `tab`: the page's tab in it.
type Pending = {
    approval: Approval;
    ready: boolean;
    told?: (approval: Approval) => void;
    follow?: (tell: (life: Life) => void) => void;
    after?: (tell: (outcome: Outcome) => void) => void;
    decide: (answer: Answer) => void;
    port?: chrome.runtime.Port;
    opened: Promise<number | undefined>;
    window?: number;
    tab?: number;
};
const pending = new Map<string, Pending>();
const windows = new Map<number, string>(); // approval windows, to the request they ask about
/** Approval windows kept open after a yes: one may go on to Activity, where Otus is as its popup is. */
export const kept = new Set<number>();

/** Asks the user: see the Shell's `approve`. */
export type Approve = (approval: Approval, follow?: (tell: (life: Life) => void) => void, later?: Promise<Approval>, after?: (tell: (outcome: Outcome) => void) => void) => Promise<Answer>;

/** Opens a window asking the user; true only when they approve, or for a Ledger account the signature its window got
 *  from the device on approval (serve checks it), or, to connect, the account they chose there (serve checks it is
 *  theirs). Closing the window says no. One at a time per site. `follow`: the window hears its blockhash's life.
 *  `later`: the approval in its final form; the window shows it in place of the first, and only then does a yes
 *  count. Failing, it says no. `after`: approved, the window stays and hears how the transaction goes, until the user
 *  closes it; without it, or on no, it closes. */
export const approve: Approve = async (approval, follow, later, after) => early(approval).approve(approval, follow, later, after);

/** A window opened early: see `early`. */
export type Early = { approve: Approve; no: Promise<void>; close: (why?: string) => void };

/**
 * A window opened at once, before what it asks about is ready: it shows `first` (who asks, for which account), which
 * takes no yes. `approve`, once, then gives it what to answer, as `approve` above does, and waits for the answer. `no`:
 * the user said no before that, closing it or not (it never settles otherwise), or it did not open (it throws why).
 * `close` ends it unanswered, for a request that fails before it is shown: saying why, the window stays until the user
 * closes it, and the site's next request waits for that.
 */
export function early(first: Approval): Early {
    if ([...pending.values()].some((p) => p.approval.site.origin === first.site.origin)) throw new Refused('Otus is already asking you about a request from this site');
    const id = crypto.randomUUID();
    let failure: unknown = null;
    let [answered, approving] = [false, false];
    let settle: (answer: Answer) => void = () => {};
    const decided = new Promise<Answer>((d) => (settle = d));
    let said: (failure: unknown) => void = () => {};
    const no = new Promise<void>((done, fail) => (said = (failure) => (failure ? fail(failure) : done())));
    no.catch(() => {}); // heard by whoever asks
    const decide = (answer: Answer) => {
        if (!answered && !approving) said(failure);
        answered = true;
        settle(answer);
    };
    const opened = openWindow(id).then(
        ({ window, tab }) => ((asked.tab = tab), (asked.window = window)),
        (error: unknown) => {
            failure = error;
            decide(false);
            return undefined;
        },
    );
    const asked: Pending = { approval: first, ready: false, decide, opened };
    pending.set(id, asked);
    // Answered, or ended: the window closes, or stays to hear how an approved transaction goes.
    void decided.then(async (answer) => {
        pending.delete(id);
        const window = await opened;
        if (window === undefined) return;
        windows.delete(window);
        const { after, port } = asked;
        if (answer !== false && after && port) {
            kept.add(window);
            after((outcome) => void tellPort(port, { outcome }));
        } else chrome.windows.remove(window).catch(() => {});
    });
    return {
        approve: async (approval, follow, later, after) => {
            if (approving) throw new Error('a window answers one request');
            approving = true;
            Object.assign(asked, { approval, ready: !later, follow, after });
            asked.told?.(approval);
            if (follow && asked.port) follow(listening(asked.port)); // the window came first: it hears from now
            later?.then(
                (final) => {
                    Object.assign(asked, { approval: final, ready: true });
                    asked.told?.(final);
                },
                () => decide(false),
            );
            const answer = await decided;
            if (failure) throw failure;
            return answer;
        },
        no,
        close: (why) => {
            if (answered) return;
            if (!why) return decide(false);
            Object.assign(asked, { approval: { kind: 'pending', site: first.site, account: first.account, refused: why }, ready: false, after: undefined });
            asked.told?.(asked.approval);
        },
    };
}

// The window, at the corner of the one focused last; its id.
async function openWindow(id: string): Promise<{ window: number; tab: number | undefined }> {
    const last = await chrome.windows.getLastFocused().catch(() => undefined);
    const corner = last?.left !== undefined && last.width !== undefined ? { left: last.left + last.width - WIDTH - 16, top: (last.top ?? 0) + 72 } : {};
    // Chrome refuses a window mostly off screen, as a corner past the edge of a second monitor; then it places it itself.
    const open = (place: object) => chrome.windows.create({ url: chrome.runtime.getURL(`${PAGE}#${id}`), type: 'popup', width: WIDTH, height: HEIGHT, focused: true, ...place });
    const opened = await open(corner).catch(() => open({}));
    if (opened?.id === undefined) throw new Error('the approval window did not open');
    windows.set(opened.id, id);
    return { window: opened.id, tab: opened.tabs?.[0]?.id };
}

// What tells the window its blockhash's life.
const listening = (port: chrome.runtime.Port) => (life: Life) => tellPort(port, { life });

// The approval window connects back by the id in its address, and only from Otus's own page, in the window Otus opened
// for it, once: another extension can read the address of any tab and open the page itself. A yes counts only while
// Otus is unlocked: the window shows its lock then, but a click may come in the moment before it does.
chrome.runtime.onConnect.addListener((port) => {
    if (!port.name.startsWith('approve:')) return;
    const id = port.name.slice('approve:'.length);
    const asked = pending.get(id);
    const fromPage = port.sender?.id === chrome.runtime.id && port.sender.url?.split('#')[0] === chrome.runtime.getURL(PAGE);
    if (!asked || !fromPage) return port.disconnect();
    const take = (window: number | undefined) => {
        const tab = port.sender?.tab;
        if (pending.get(id) !== asked || window === undefined || tab?.windowId !== window || (asked.tab !== undefined && tab.id !== asked.tab) || asked.port) return port.disconnect();
        listen(asked, port);
    };
    if (asked.window !== undefined) take(asked.window);
    else void asked.opened.then(take);
});

// The window's port, taken: what it asks about, told now and as it changes, and its answers.
function listen(asked: Pending, port: chrome.runtime.Port) {
    asked.port = port;
    port.postMessage(asked.approval);
    asked.told = (approval) => tellPort(port, approval);
    asked.follow?.(listening(port));
    port.onMessage.addListener((m: { approve?: unknown; signature?: unknown; signatures?: unknown; account?: unknown; beat?: unknown }) => {
        if (m.beat === true) return; // an approved window, still following its transaction: it only keeps Otus awake
        const answer = answerOf(m, asked.approval.kind);
        if (!answer) return asked.decide(false);
        if (!asked.ready) return; // a yes before the final form counts for nothing
        void shielded().then((shut) => asked.decide(!shut && answer), () => asked.decide(false));
    });
    port.onDisconnect.addListener(() => asked.decide(false));
}

// A message for a window that may have gone meanwhile.
function tellPort(port: chrome.runtime.Port, message: object) {
    try {
        port.postMessage(message);
    } catch {} // the window went meanwhile
}

// A window closed before its page connected says no as well.
chrome.windows.onRemoved.addListener((window) => {
    kept.delete(window);
    const id = windows.get(window);
    if (id !== undefined) pending.get(id)?.decide(false);
});

/** A window's answer: no, yes, yes with the signature a Ledger made (64 bytes, base64), for several transactions alone
 *  yes with each one's (at most MAX_BATCH), or, to connect alone, yes with the account chosen (an address). Anything
 *  else is no. */
export function answerOf(m: { approve?: unknown; signature?: unknown; signatures?: unknown; account?: unknown }, kind: Approval['kind']): Answer {
    if (m.approve !== true) return false;
    if (m.account !== undefined) return kind === 'connect' && m.signature === undefined && m.signatures === undefined && typeof m.account === 'string' && isAddress(m.account) ? { account: m.account } : false;
    if (m.signatures !== undefined) {
        if (kind !== 'batch' || m.signature !== undefined || !Array.isArray(m.signatures) || m.signatures.length === 0 || m.signatures.length > MAX_BATCH) return false;
        const all = m.signatures.map(signatureOf);
        return all.every((s) => s !== null) ? (all as SignatureBytes[]) : false;
    }
    if (m.signature === undefined) return true;
    return kind === 'batch' ? false : (signatureOf(m.signature) ?? false);
}

// A signature as a window sends it: 64 bytes, base64; null for anything else.
function signatureOf(v: unknown): SignatureBytes | null {
    if (typeof v !== 'string' || v.length !== 88) return null;
    try {
        const signature = new Uint8Array(getBase64Encoder().encode(v));
        return signature.length === 64 ? (signature as SignatureBytes) : null;
    } catch {
        return null;
    }
}
