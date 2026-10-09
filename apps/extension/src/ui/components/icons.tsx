// Otus's own pictures as React components: the line icons (assets/icons/ui, Lucide, ISC), a wallet's tile and the
// token logos, drawn from the same bundled SVG files the rest of the extension uses, never from a string of HTML.
import { useLayoutEffect, useRef, type ComponentProps } from 'react';

import { icon, type IconName } from '../dom.ts';
import { cn } from '../lib/cn.ts';
import { logo, tile } from '../tile.ts';

type Span = Omit<ComponentProps<'span'>, 'children'>;

// A span holding an SVG element made by one of the builders above, made again when what it shows changes.
function Drawn({ make, deps, className, ...rest }: { make: () => SVGSVGElement; deps: unknown[] } & Span) {
    const ref = useRef<HTMLSpanElement>(null);
    useLayoutEffect(() => void ref.current?.replaceChildren(make()), deps);
    return <span ref={ref} aria-hidden="true" className={cn('inline-flex shrink-0 items-center justify-center', className)} {...rest} />;
}

/** One of Otus's line icons, in the current colour. `fill`: as large as its box, which the class sizes. */
export function Icon({ name, size = 16, stroke = 2, fill = false, ...rest }: { name: IconName; size?: number; stroke?: number; fill?: boolean } & Span) {
    const make = () => {
        const svg = icon(name, size, stroke);
        if (fill) for (const side of ['width', 'height']) svg.setAttribute(side, '100%');
        return svg;
    };
    return <Drawn make={make} deps={[name, size, stroke, fill]} {...rest} />;
}

/** A wallet's tile: a mirrored pixel pattern read from its address. */
export const Tile = ({ address, size = 24, ...rest }: { address: string; size?: number } & Span) => <Drawn make={() => tile(address, size)} deps={[address, size]} {...rest} />;

/** A logo the extension carries: SOL, USDC, USDT, or the chain's mark. */
export const Logo = ({ name, size = 28, ...rest }: { name: Parameters<typeof logo>[0]; size?: number } & Span) => <Drawn make={() => logo(name, size)} deps={[name, size]} {...rest} />;

// What shadcn/ui's components ask lucide-react for, from the same files.
export const CheckIcon = ({ className }: { className?: string }) => <Icon name="check" stroke={2.5} fill className={cn('size-4', className)} />;
export const ChevronDownIcon = ({ className }: { className?: string }) => <Icon name="down" stroke={2.5} fill className={cn('size-4', className)} />;
export const ChevronUpIcon = ({ className }: { className?: string }) => <Icon name="up" stroke={2.5} fill className={cn('size-4', className)} />;
