// The setup tab's page, behind Otus's lock. While it has the focus it counts as Otus open, as the popup does, so a
// wallet being added is not locked away midway; once it loses the focus, the lock counts down, as once the popup
// closes. The copied phrase leaves the clipboard when the tab goes too.
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { Shield } from '../components/shield.tsx';
import { TooltipProvider } from '../components/ui/tooltip.tsx';
import { stayOpen } from '../open.ts';
import { again, forget, Setup } from './Setup.tsx';

addEventListener('pagehide', forget);
addEventListener('focus', again);
stayOpen({ whileFocused: true });
createRoot(document.getElementById('app')!).render(
    <StrictMode>
        <Shield>
            <TooltipProvider delayDuration={150}>
                <Setup />
            </TooltipProvider>
        </Shield>
    </StrictMode>,
);
