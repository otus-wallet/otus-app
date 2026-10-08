// The approval window's page: it connects back to the background by the id in its address, shows what comes behind
// Otus's lock, and answers. Escape says no, locked or not; a window closed says no too, in the background.
import { StrictMode, useSyncExternalStore } from 'react';
import { createRoot } from 'react-dom/client';

import { Shield } from '../components/shield.tsx';
import { TooltipProvider } from '../components/ui/tooltip.tsx';
import type { Approval, Life } from '../view.ts';
import { Approve } from './Approve.tsx';

const port = chrome.runtime.connect({ name: `approve:${location.hash.slice(1)}` });
let answered = false;
const answer = (yes: boolean, signature?: string, account?: string) => {
    answered = true;
    port.postMessage({ approve: yes, ...(signature && { signature }), ...(account && { account }) }); // the background closes this window
};
addEventListener('keydown', (e) => e.key === 'Escape' && answer(false));

// What the background said, kept from the start: it may speak before the page has drawn.
type Heard = { approval: Approval | null; gone: boolean; life?: Life };
let heard: Heard = { approval: null, gone: false };
const listeners = new Set<() => void>();
const hear = (change: Partial<Heard>) => ((heard = { ...heard, ...change }), listeners.forEach((l) => l()));
// The request, then its blockhash's life as the network tells it.
port.onMessage.addListener((m: Approval | { life: Life }) => hear('life' in m ? { life: m.life } : { approval: m }));
port.onDisconnect.addListener(() => answered || hear({ gone: true }));

function Window() {
    const now = useSyncExternalStore((l) => (listeners.add(l), () => listeners.delete(l)), () => heard);
    if (now.gone) return <p className="p-4 text-[10.5px] text-ink-2">This request is no longer waiting.</p>;
    if (!now.approval) return null;
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
