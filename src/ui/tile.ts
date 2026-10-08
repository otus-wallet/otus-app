import { getAddressEncoder, type Address } from '@solana/kit';

import chain from '../../assets/logos/chain.svg';
import sol from '../../assets/logos/sol.svg';
import usdc from '../../assets/logos/usdc.svg';
import usdt from '../../assets/logos/usdt.svg';
import { svgOf } from './dom.ts';

const COLORS = ['#3df2a6', '#ffc247', '#7cc4ff', '#ff8fb1', '#c3a6ff', '#e6eef8'];

/** An address as a tile: a mirrored 5×5 pixel pattern in one colour, both read from its bytes, so always the same. */
export function tile(a: string, size = 24): SVGSVGElement {
    const bytes = getAddressEncoder().encode(a as Address);
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    for (const [k, v] of Object.entries({ width: size, height: size, viewBox: '-1 -1 7 7', 'shape-rendering': 'crispEdges', 'aria-hidden': 'true', class: 'tile' })) svg.setAttribute(k, String(v));
    const pixels = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    let d = '';
    for (let row = 0; row < 5; row++) {
        for (let col = 0; col < 3; col++) {
            if ((bytes[1 + row * 3 + col] & 1) === 0) continue;
            d += `M${col} ${row}h1v1h-1z`;
            if (col < 2) d += `M${4 - col} ${row}h1v1h-1z`;
        }
    }
    pixels.setAttribute('d', d || 'M2 2h1v1h-1z');
    pixels.setAttribute('fill', COLORS[bytes[0] % COLORS.length]);
    svg.append(pixels);
    return svg;
}

/** A token's logo from assets/logos: SOL, USDC and USDT, and the chain's mark in grey for a token without a logo of
 * its own. Drawn from files in the extension, so showing them asks no server for an image. */
export function logo(name: keyof typeof LOGOS, size = 28): SVGSVGElement {
    const svg = svgOf(LOGOS[name]);
    for (const [k, v] of Object.entries({ width: size, height: size, 'aria-hidden': 'true', class: `logo ${name}` })) svg.setAttribute(k, String(v));
    return svg;
}

const LOGOS = { sol, usdc, usdt, chain };
