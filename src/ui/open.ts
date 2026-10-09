/**
 * Tells the background a page of Otus's is open: Otus stays unlocked while it is, and counts its lock time from
 * when it closes. The popup counts while open, as Chrome closes it once it loses the focus; the setup tab and a review
 * window gone on to Activity (`whileFocused`), only while they have the focus, as the popup would be. Approval windows
 * do not count, since a site opens them. The beat keeps the background awake, and its count.
 */
export function stayOpen({ whileFocused = false } = {}) {
    let shut: (() => void) | null = null;
    const focused = () => !whileFocused || document.hasFocus();
    const open = () => {
        try {
            const port = chrome.runtime.connect({ name: 'open' });
            const beat = setInterval(() => port.postMessage(0), 20_000);
            shut = () => (clearInterval(beat), port.disconnect(), (shut = null));
            port.onDisconnect.addListener(() => {
                clearInterval(beat);
                shut = null;
                setTimeout(() => follow(focused()), 1_000); // the background restarted: tell the new one
            });
        } catch {} // the extension was reloaded, and this page with it
    };
    const follow = (now: boolean) => {
        if (now && !shut) open();
        if (!now) shut?.();
    };
    if (whileFocused) {
        addEventListener('focus', () => follow(true));
        addEventListener('blur', () => follow(false));
    }
    follow(focused());
}
