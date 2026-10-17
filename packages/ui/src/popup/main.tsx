// The popup's page: React, with its query cache and shadcn/ui's tooltips around it, and the beat that keeps Otus open
// while it is. It draws once the session's last balances and token names are in the cache, so they show at once.
import { QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { platform } from '@otus-wallet/core/platform.ts';
import { keepTokens } from '@otus-wallet/core/tokens.ts';
import { TooltipProvider } from '../components/ui/tooltip.tsx';
import { stayOpen } from '../open.ts';
import { App } from './App.tsx';
import { forgetActivity, queries, restore } from './query.ts';

// The toolbar popup counts as open while it is; in a window (a review window gone on to Activity), only while that has
// the focus, as a window, unlike the popup, stays when the user turns away.
void platform.inTab().then((tab) => stayOpen({ whileFocused: tab }), () => stayOpen());
// Token answers kept for their names only: prices are asked again each time the popup opens.
void Promise.all([restore(), keepTokens(Date.now, false)]).finally(() => {
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
