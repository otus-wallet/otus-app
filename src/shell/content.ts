// Runs beside the site's page, in the extension's own world. It carries calls from the page script to the background
// and answers back; it adds nothing and decides nothing. The background learns the site's origin from the browser.
import { CHANNEL, type PageMessage, type Reply } from '../protocol.ts';

const toPage = (message: PageMessage) => window.postMessage(message, window.location.origin);

window.addEventListener('message', (event: MessageEvent<PageMessage>) => {
    const m = event.data;
    if (event.source !== window || m?.channel !== CHANNEL || m.kind !== 'request' || !Number.isSafeInteger(m.id)) return;
    chrome.runtime.sendMessage({ call: m.call }).then(
        (reply: Reply) => toPage({ channel: CHANNEL, kind: 'response', id: m.id, reply }),
        () => toPage({ channel: CHANNEL, kind: 'response', id: m.id, reply: { ok: false, error: 'Otus is not available; reload the page' } }),
    );
});

// The background tells the page when the site's accounts change, as when the user disconnects it in Otus. Only for
// this very site: the tab may have moved on to another since it called.
chrome.runtime.onMessage.addListener((message: { accounts?: unknown; origin?: unknown; v1?: unknown }) => {
    if (!Array.isArray(message.accounts) || message.origin !== location.origin) return;
    toPage({ channel: CHANNEL, kind: 'accounts', accounts: message.accounts.filter((a) => typeof a === 'string'), v1: message.v1 !== false });
});
