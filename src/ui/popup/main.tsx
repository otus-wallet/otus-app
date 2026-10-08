// The popup's page: React, with its query cache and shadcn/ui's tooltips around it, and the beat that keeps Otus open
// while it is. It draws once the session's last balances are in the cache, so they show at once.
import { QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { TooltipProvider } from '../components/ui/tooltip.tsx';
import { stayOpen } from '../open.ts';
import { App } from './App.tsx';
import { forgetActivity, queries, restore } from './query.ts';

stayOpen();
// Opened from a review window once its transaction landed: on Activity, read afresh, as what was kept is behind.
async function opened() {
    const { openOn } = await chrome.storage.session.get('openOn');
    if (openOn !== 'activity') return;
    await chrome.storage.session.remove('openOn');
    history.replaceState(null, '', '#activity');
}
void Promise.all([opened().catch(() => {}), restore()]).finally(() => {
    if (location.hash === '#activity') {
        queries.removeQueries({ queryKey: ['activity'] });
        forgetActivity();
    }
    createRoot(document.getElementById('app')!).render(
        <StrictMode>
            <QueryClientProvider client={queries}>
                <TooltipProvider delayDuration={150}>
                    <App />
                </TooltipProvider>
            </QueryClientProvider>
        </StrictMode>,
    );
});
