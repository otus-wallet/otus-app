// An address as a QR code: dark squares on a light tile, the quiet margin scanners need around them, and in the middle
// the wallet's tile, which the code's error correction reads past.
import qrcode from 'qrcode-generator';

import { tile } from '../tile.ts';

const SVG = 'http://www.w3.org/2000/svg';
const node = <K extends keyof SVGElementTagNameMap>(tag: K, attributes: Record<string, string | number>) => {
    const n = document.createElementNS(SVG, tag);
    for (const [k, v] of Object.entries(attributes)) n.setAttribute(k, String(v));
    return n;
};

export function qr(text: string, px = 196): SVGSVGElement {
    const code = qrcode(0, 'Q');
    code.addData(text);
    code.make();
    const n = code.getModuleCount();
    const [quiet, middle] = [4, 7]; // in modules
    const size = n + quiet * 2;
    const from = Math.floor((n - middle) / 2);
    let d = '';
    for (let y = 0; y < n; y++) {
        for (let x = 0; x < n; x++) {
            const inside = x >= from && x < from + middle && y >= from && y < from + middle;
            if (!inside && code.isDark(y, x)) d += `M${x + quiet} ${y + quiet}h1v1h-1z`;
        }
    }
    const svg = node('svg', { viewBox: `0 0 ${size} ${size}`, width: px, height: px, 'shape-rendering': 'crispEdges', role: 'img', 'aria-label': 'QR code of this address' });
    const mark = tile(text, middle);
    for (const [k, v] of Object.entries({ x: from + quiet, y: from + quiet, width: middle, height: middle })) mark.setAttribute(k, String(v));
    svg.append(node('rect', { width: size, height: size, fill: '#e6eef8' }), node('path', { d, fill: '#000' }), node('rect', { x: from + quiet, y: from + quiet, width: middle, height: middle, fill: '#000' }), mark);
    return svg;
}
