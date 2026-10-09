import { getBase64Encoder, isAddress, type Address, type SignatureBytes } from '@solana/kit';

import { Refused } from '@otus-wallet/core/protocol.ts';
import type { Approval, Life, Outcome } from '@otus-wallet/core/view.ts';
import { shielded } from './keys.ts';

const PAGE = 'approve.html';
const [WIDTH, HEIGHT] = [400, 680];
/** An answer: no, yes, yes with the signature a Ledger made, or, to connect, yes with the account chosen. */
export type Answer = boolean | SignatureBytes | { account: Address };

// `ready`: the approval is in its final form, the only one a yes counts for; `told`: the window, to hear it; `port`: the
// window's own, to tell it how an approved transaction goes.
type Pending = { approval: Approval; ready: boolean; told?: (approval: Approval) => void; follow?: (tell: (life: Life) => void) => void; decide: (answer: Answer) => void; port?: chrome.runtime.Port };
const pending = new Map<string, Pending>();
const windows = new Map<number, string>(); // approval windows, to the request they ask about
/** Approval windows kept open after a yes: one may go on to Activity, where Otus is as its popup is. */
export const kept = new Set<number>();

/** Opens a window asking the user; true only when they approve, or for a Ledger account the signature its window got
 *  from the device on approval (serve checks it), or, to connect, the account they chose there (serve checks it is
 *  theirs). Closing the window says no. One at a time per site. `follow`: the window hears its blockhash's life.
 *  `later`: the approval in its final form; the window shows it in place of the first, and only then does a yes
 *  count. Failing, it says no. `after`: approved, the window stays and hears how the transaction goes, until the user
 *  closes it; without it, or on no, it closes. */
export async function approve(approval: Approval, follow?: (tell: (life: Life) => void) => void, later?: Promise<Approval>, after?: (tell: (outcome: Outcome) => void) => void): Promise<Answer> {
    if ([...pending.values()].some((p) => p.approval.site.origin === approval.site.origin)) throw new Refused('Otus is already asking you about a request from this site');
    const id = crypto.randomUUID();
    let asked: Pending | undefined;
    let answer: Answer = false;
    const decided = new Promise<Answer>((decide) => {
        asked = { approval, ready: !later, follow, decide };
        const it = asked;
        pending.set(id, it);
        later?.then(
            (final) => {
                Object.assign(it, { approval: final, ready: true });
                it.told?.(final);
            },
            () => decide(false),
        );
    });
    let opened: chrome.windows.Window | undefined;
    try {
        const last = await chrome.windows.getLastFocused().catch(() => undefined);
        const corner = last?.left !== undefined && last.width !== undefined ? { left: last.left + last.width - WIDTH - 16, top: (last.top ?? 0) + 72 } : {};
        // Chrome refuses a window mostly off screen, as a corner past the edge of a second monitor; then it places it itself.
        const open = (place: object) => chrome.windows.create({ url: chrome.runtime.getURL(`${PAGE}#${id}`), type: 'popup', width: WIDTH, height: HEIGHT, focused: true, ...place });
        opened = await open(corner).catch(() => open({}));
        if (opened?.id === undefined) throw new Error('the approval window did not open');
        windows.set(opened.id, id);
        answer = await decided;
        return answer;
    } finally {
        pending.delete(id);
        const port = asked?.port;
        if (opened?.id !== undefined) {
            windows.delete(opened.id);
            if (answer !== false && after && port) {
                kept.add(opened.id);
                after((outcome) => void tellPort(port, { outcome }));
            } else chrome.windows.remove(opened.id).catch(() => {});
        }
    }
}

// The approval window connects back by the id in its address, and only from Otus's own page. A yes counts only while
// Otus is unlocked: the window shows its lock then, but a click may come in the moment before it does.
chrome.runtime.onConnect.addListener((port) => {
    if (!port.name.startsWith('approve:')) return;
    const asked = pending.get(port.name.slice('approve:'.length));
    const fromPage = port.sender?.id === chrome.runtime.id && port.sender.url?.split('#')[0] === chrome.runtime.getURL(PAGE);
    if (!asked || !fromPage) return port.disconnect();
    asked.port = port;
    port.postMessage(asked.approval);
    asked.told = (final) => {
        try {
            port.postMessage(final);
        } catch {} // the window went meanwhile
    };
    asked.follow?.((life) => {
        try {
            port.postMessage({ life });
        } catch {} // the window went meanwhile
    });
    port.onMessage.addListener((m: { approve?: unknown; signature?: unknown; account?: unknown; beat?: unknown }) => {
        if (m.beat === true) return; // an approved window, still following its transaction: it only keeps Otus awake
        const answer = answerOf(m, asked.approval.kind);
        if (!answer) return asked.decide(false);
        if (!asked.ready) return; // a yes before the final form counts for nothing
        void shielded().then((shut) => asked.decide(!shut && answer), () => asked.decide(false));
    });
    port.onDisconnect.addListener(() => asked.decide(false));
});

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

/** A window's answer: no, yes, yes with the signature a Ledger made (64 bytes, base64), or, to connect alone, yes with
 *  the account chosen (an address). Anything else is no. */
export function answerOf(m: { approve?: unknown; signature?: unknown; account?: unknown }, kind: Approval['kind']): Answer {
    if (m.approve !== true) return false;
    if (m.account !== undefined) return kind === 'connect' && m.signature === undefined && typeof m.account === 'string' && isAddress(m.account) ? { account: m.account } : false;
    if (m.signature === undefined) return true;
    if (typeof m.signature !== 'string' || m.signature.length !== 88) return false;
    try {
        const signature = new Uint8Array(getBase64Encoder().encode(m.signature));
        return signature.length === 64 ? (signature as SignatureBytes) : false;
    } catch {
        return false;
    }
}
