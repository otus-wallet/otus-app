import bang from '../assets/icons/bang.svg';
import book from '../assets/icons/book-user.svg';
import receive from '../assets/icons/arrow-down-to-line.svg';
import swap from '../assets/icons/arrow-left-right.svg';
import send from '../assets/icons/arrow-up-from-line.svg';
import caps from '../assets/icons/arrow-big-up-dash.svg';
import check from '../assets/icons/check.svg';
import down from '../assets/icons/chevron-down.svg';
import left from '../assets/icons/chevron-left.svg';
import right from '../assets/icons/chevron-right.svg';
import up from '../assets/icons/chevron-up.svg';
import copy from '../assets/icons/copy.svg';
import external from '../assets/icons/external-link.svg';
import hidden from '../assets/icons/eye-off.svg';
import eye from '../assets/icons/eye.svg';
import fingerprint from '../assets/icons/fingerprint.svg';
import grip from '../assets/icons/grip-vertical.svg';
import key from '../assets/icons/key-round.svg';
import lock from '../assets/icons/lock.svg';
import pencil from '../assets/icons/pencil.svg';
import plus from '../assets/icons/plus.svg';
import refresh from '../assets/icons/refresh-cw.svg';
import server from '../assets/icons/server.svg';
import gear from '../assets/icons/settings.svg';
import shield from '../assets/icons/shield-check.svg';
import trash from '../assets/icons/trash-2.svg';
import wallet from '../assets/icons/wallet.svg';
import cross from '../assets/icons/x.svg';
import home from '../assets/icons/house.svg';
import history from '../assets/icons/history.svg';
import github from '../assets/icons/github.svg';
import ledger from '../assets/icons/ledger.svg';
import box from '../assets/icons/box.svg';
import only from '../assets/icons/user-round-check.svg';
import others from '../assets/icons/users-round.svg';
import stake from '../assets/icons/money-bag.svg';

// Otus's line icons, from the SVG files in assets/icons (Lucide, ISC; the money bag Otus's own), for the pages to draw;
// and short addresses.
export { short } from '@otus-wallet/sdk/format';

const ICONS = { bang, book, box, caps, check, home, history, cross, down, up, left, right, copy, external, eye, hidden, fingerprint, grip, key, lock, pencil, plus, refresh, gear, server, shield, trash, wallet, receive, send, swap, stake, github, ledger, only, others };
export type IconName = keyof typeof ICONS;

/** One of Otus's line icons (assets/icons), drawn in the current text colour. */
export function icon(name: IconName, size = 11, stroke = 3): SVGSVGElement {
    const svg = svgOf(ICONS[name]);
    for (const [k, v] of Object.entries({ width: size, height: size, 'aria-hidden': 'true', class: 'icon', 'stroke-width': stroke })) svg.setAttribute(k, String(v));
    return svg;
}

// A copy of a bundled SVG file. The files are Otus's own, so parsing them is safe.
const parsed = new Map<string, SVGSVGElement>();
export function svgOf(text: string): SVGSVGElement {
    if (!parsed.has(text)) parsed.set(text, new DOMParser().parseFromString(text, 'image/svg+xml').documentElement as unknown as SVGSVGElement);
    return parsed.get(text)!.cloneNode(true) as SVGSVGElement;
}
