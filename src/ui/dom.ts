import bang from '../../assets/icons/ui/bang.svg';
import book from '../../assets/icons/ui/book-user.svg';
import receive from '../../assets/icons/ui/arrow-down-to-line.svg';
import swap from '../../assets/icons/ui/arrow-left-right.svg';
import send from '../../assets/icons/ui/arrow-up-from-line.svg';
import caps from '../../assets/icons/ui/arrow-big-up-dash.svg';
import check from '../../assets/icons/ui/check.svg';
import down from '../../assets/icons/ui/chevron-down.svg';
import left from '../../assets/icons/ui/chevron-left.svg';
import right from '../../assets/icons/ui/chevron-right.svg';
import up from '../../assets/icons/ui/chevron-up.svg';
import copy from '../../assets/icons/ui/copy.svg';
import external from '../../assets/icons/ui/external-link.svg';
import hidden from '../../assets/icons/ui/eye-off.svg';
import eye from '../../assets/icons/ui/eye.svg';
import fingerprint from '../../assets/icons/ui/fingerprint.svg';
import grip from '../../assets/icons/ui/grip-vertical.svg';
import key from '../../assets/icons/ui/key-round.svg';
import lock from '../../assets/icons/ui/lock.svg';
import pencil from '../../assets/icons/ui/pencil.svg';
import plus from '../../assets/icons/ui/plus.svg';
import refresh from '../../assets/icons/ui/refresh-cw.svg';
import server from '../../assets/icons/ui/server.svg';
import gear from '../../assets/icons/ui/settings.svg';
import shield from '../../assets/icons/ui/shield-check.svg';
import trash from '../../assets/icons/ui/trash-2.svg';
import wallet from '../../assets/icons/ui/wallet.svg';
import cross from '../../assets/icons/ui/x.svg';
import home from '../../assets/icons/ui/house.svg';
import history from '../../assets/icons/ui/history.svg';
import github from '../../assets/icons/ui/github.svg';
import ledger from '../../assets/icons/ui/ledger.svg';
import box from '../../assets/icons/ui/box.svg';

// Otus's line icons, from the SVG files in assets/icons/ui (Lucide, ISC), for the pages to draw; and short addresses.
export { short } from '../format.ts';

const ICONS = { bang, book, box, caps, check, home, history, cross, down, up, left, right, copy, external, eye, hidden, fingerprint, grip, key, lock, pencil, plus, refresh, gear, server, shield, trash, wallet, receive, send, swap, github, ledger };
export type IconName = keyof typeof ICONS;

/** One of Otus's line icons (assets/icons/ui), drawn in the current text colour. */
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
