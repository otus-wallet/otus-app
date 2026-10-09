// The platform in Chrome: the background over runtime messages and ports, chrome.storage, and tabs. Each page imports
// this first, so it is set before any module of the page uses it. Chrome's objects are read on each call, as an
// extension reloaded under a page takes them away.
import { install } from '../platform.ts';

install({
    send: (call) => chrome.runtime.sendMessage(call),
    connect: (name) => chrome.runtime.connect({ name }),
    get storage() {
        return chrome.storage;
    },
    url: (page) => chrome.runtime.getURL(page),
    version: () => chrome.runtime.getManifest().version,
    async showSetup(hash) {
        const page = chrome.runtime.getURL('welcome.html');
        const [tab] = await chrome.runtime.getContexts({ contextTypes: ['TAB' as chrome.runtime.ContextType], documentUrls: [page, `${page}#add`] }).catch(() => []);
        if (tab && tab.tabId >= 0) {
            await chrome.tabs.update(tab.tabId, { active: true });
            await chrome.windows.update(tab.windowId, { focused: true });
        } else {
            await chrome.tabs.create({ url: `${page}${hash}` });
        }
    },
    openTab: async (page) => void (await chrome.tabs.create({ url: chrome.runtime.getURL(page) })),
    inTab: () => chrome.tabs.getCurrent().then((tab) => tab !== undefined),
    closeTab: () => chrome.tabs.getCurrent((t) => void (t?.id !== undefined && chrome.tabs.remove(t.id))),
    reload: () => chrome.runtime.reload(),
    alive: () => Boolean(chrome.runtime?.id),
});
