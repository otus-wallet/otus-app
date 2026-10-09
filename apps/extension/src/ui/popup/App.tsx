// The toolbar popup, in screens: the lobby of the wallet in use, its activity, its own screen, the list of wallets,
// settings, receive and send. A wallet is set up in a tab of its own (welcome.html), never here.
import { Fragment, useEffect, useState } from 'react';

import { BUILD } from '../../build.ts';
import { Shield } from '../components/shield.tsx';
import { Access } from './Access.tsx';
import { ActivityScreen } from './Activity.tsx';
import { Empty, Stale } from './Gate.tsx';
import { Lobby } from './Lobby.tsx';
import { Receive } from './Receive.tsx';
import { Send } from './Send.tsx';
import { Settings } from './Settings.tsx';
import { platform } from '../../platform.ts';
import type { KeyStatus } from '../../shell/keys.ts';
import type { State } from '../../shell/state.ts';
import { useOtus } from './store.ts';
import { StakeScreen } from './Stake.tsx';
import { WalletScreen } from './WalletScreen.tsx';
import { Wallets } from './Wallets.tsx';

export type Screen = 'lobby' | 'activity' | 'access' | 'wallet' | 'wallets' | 'settings' | 'receive' | 'send' | 'stake';

// The setup tab, for a new wallet or one to import: the one already open, if any, rather than another.
async function setUp(hash = '') {
    const page = chrome.runtime.getURL('welcome.html');
    const [tab] = await chrome.runtime.getContexts({ contextTypes: ['TAB' as chrome.runtime.ContextType], documentUrls: [page, `${page}#add`] }).catch(() => []);
    if (tab && tab.tabId >= 0) {
        await chrome.tabs.update(tab.tabId, { active: true });
        await chrome.windows.update(tab.windowId, { focused: true });
    } else {
        await chrome.tabs.create({ url: `${page}${hash}` });
    }
    window.close();
}

// Whether the background runs another build than this popup: one that does not answer is older still.
function useStale(): boolean {
    const [stale, setStale] = useState(false);
    useEffect(() => {
        platform.send({ build: true }).then(
            (reply) => setStale((reply as { build?: unknown } | undefined)?.build !== BUILD),
            () => setStale(true),
        );
    }, []);
    return stale;
}

// A background of another build first, as unlocking it would not last; then the screens, behind Otus's lock.
export function App() {
    const stale = useStale();
    if (stale) return <Stale />;
    return (
        <Shield>
            <Screens />
        </Shield>
    );
}

// Unlocked again, they start from the lobby.
function Screens() {
    const now = useOtus();
    const [screen, go] = useState<Screen>(() => (location.hash === '#activity' ? 'activity' : 'lobby')); // a review window that ended opens Activity
    if (!now) return null; // a moment, while what is stored is read
    const { state, keys } = now;
    if (state.accounts.length === 0) return <Empty setUp={() => void setUp()} />;
    // Each screen starts over when the wallet in use changes, as the setup tab can do: nothing typed or confirmed for one
    // wallet carries over to another.
    return <Fragment key={state.active ?? ''}>{shown(screen, state, keys, go)}</Fragment>;
}

function shown(screen: Screen, state: State, keys: KeyStatus, go: (to: Screen) => void) {
    switch (screen) {
        case 'wallet':
            return <WalletScreen state={state} go={go} />;
        case 'wallets':
            return <Wallets state={state} keys={keys} go={go} setUp={(hash) => void setUp(hash)} />;
        case 'activity':
            return <ActivityScreen state={state} go={go} />;
        case 'access':
            return <Access state={state} go={go} />;
        case 'settings':
            return <Settings state={state} keys={keys} go={go} />;
        case 'receive':
            return <Receive state={state} go={go} />;
        case 'send':
            return <Send state={state} go={go} />;
        case 'stake':
            return <StakeScreen state={state} go={go} />;
        default:
            return <Lobby state={state} go={go} />;
    }
}
