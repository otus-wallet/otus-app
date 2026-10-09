// The popup's page: React, with its query cache and shadcn/ui's tooltips around it, and the beat that keeps Otus open
// while it is. It draws once the session's last balances are in the cache, so they show at once.
import '../../shell/chrome.ts'; // the platform, set before any module below uses it
import { QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { platform } from '../../platform.ts';
import { TooltipProvider } from '../components/ui/tooltip.tsx';
import { stayOpen } from '../open.ts';
import { App } from './App.tsx';
import { forgetActivity, queries, restore } from './query.ts';

// The toolbar popup counts as open while it is; in a window (a review window gone on to Activity), only while that has
// the focus, as a window, unlike the popup, stays when the user turns away.
void platform.inTab().then((tab) => stayOpen({ whileFocused: tab }), () => stayOpen());
void restore().finally(() => {
    // Opened on Activity from a review window, once its transaction landed: what was kept of it is behind.
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
