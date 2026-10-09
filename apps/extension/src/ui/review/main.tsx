// The approval window's page: it connects back to the background by the id in its address, shows what comes behind
// Otus's lock, and answers. Escape says no, locked or not; a window closed says no too, in the background. A transaction
// approved stays, saying how it goes.
import '../../shell/chrome.ts'; // the platform, set before any module below uses it
import { StrictMode, useSyncExternalStore } from 'react';
import { createRoot } from 'react-dom/client';

import { Shield } from '../components/shield.tsx';
import { TooltipProvider } from '../components/ui/tooltip.tsx';
import type { Approval, Life, Outcome } from '../view.ts';
import { Approve } from './Approve.tsx';
import { Settled } from './Settled.tsx';

const port = chrome.runtime.connect({ name: `approve:${location.hash.slice(1)}` });
let answered = false;
// No closes the window; yes too, unless it is a transaction's: the background then tells how it goes.
const answer = (yes: boolean, signature?: string, account?: string) => {
    answered = true;
    if (yes && heard.approval?.kind === 'transaction') hear({ approved: true });
    port.postMessage({ approve: yes, ...(signature && { signature }), ...(account && { account }) });
};
addEventListener('keydown', (e) => e.key === 'Escape' && !heard.approved && answer(false));

// What the background said, kept from the start: it may speak before the page has drawn.
type Heard = { approval: Approval | null; gone: boolean; life?: Life; approved?: boolean; outcome?: Outcome };
let heard: Heard = { approval: null, gone: false };
const listeners = new Set<() => void>();
const hear = (change: Partial<Heard>) => ((heard = { ...heard, ...change }), listeners.forEach((l) => l()));
// The request, then its blockhash's life as the network tells it; approved, how it goes.
port.onMessage.addListener((m: Approval | { life: Life } | { outcome: Outcome }) => hear('life' in m ? { life: m.life } : 'outcome' in m ? { outcome: m.outcome } : { approval: m }));
// Gone while it was still on its way, Otus stopped following it: that is said, with where to look.
const going = (o: Outcome | undefined) => !o || o.phase === 'sending' || o.phase === 'waiting';
port.onDisconnect.addListener(() => {
    if (!answered) return hear({ gone: true });
    if (heard.approved && going(heard.outcome)) hear({ outcome: { phase: 'unseen', expired: false, link: heard.outcome && 'link' in heard.outcome ? heard.outcome.link : '' } });
});
// While it is on its way, a beat keeps the background awake to follow it.
setInterval(() => {
    if (!heard.approved || !going(heard.outcome)) return;
    try {
        port.postMessage({ beat: true });
    } catch {} // the background went
}, 20_000);

function Window() {
    const now = useSyncExternalStore((l) => (listeners.add(l), () => listeners.delete(l)), () => heard);
    if (now.gone) return <p className="p-4 text-[10.5px] text-ink-2">This request is no longer waiting.</p>;
    if (!now.approval) return null;
    if (now.approved) return <Settled site={now.approval.site} account={now.approval.account} outcome={now.outcome ?? null} />;
    return (
        <Shield asking={{ host: now.approval.site.host, reject: () => answer(false) }}>
            <Approve approval={now.approval} answers={{ answer }} life={now.life} />
        </Shield>
    );
}

createRoot(document.getElementById('app')!).render(
    <StrictMode>
        <TooltipProvider delayDuration={150}>
            <Window />
        </TooltipProvider>
    </StrictMode>,
);
