// A password field with an eye beside it, to see what was typed and set it right, and before it, while Caps Lock is on,
// its sign: the keyboard says so with each key and click in the field. Shown, it is a plain text field, so
// nothing may read it as text to correct: no spellcheck (Chrome's enhanced one sends text fields to Google), no
// autocorrect; nor keep it: Chrome writes a text field's value to the profile's session files on disk unless its
// autocomplete is off. The eye keeps the focus in the field. What is typed stays out of the page's markup: React writes
// a controlled field's value into its attribute too, where a stylesheet could read it; this one is put in the field
// only when the page sets it, as when it clears it.
import { useEffect, useRef, useState, type ComponentProps, type KeyboardEvent, type MouseEvent } from 'react';

import { cn } from '../lib/cn.ts';
import { Icon } from './icons.tsx';
import { Input } from './ui/input.tsx';

/** `what`: what the field holds, for the eye's label; a password unless said. */
export function PasswordInput({ className, what = 'password', value, autoComplete, onKeyDown, onKeyUp, onMouseDown, ...props }: Omit<ComponentProps<typeof Input>, 'type' | 'defaultValue'> & { what?: string }) {
    const [shown, setShown] = useState(false);
    const [caps, setCaps] = useState(false);
    const read = (e: KeyboardEvent | MouseEvent) => setCaps(e.getModifierState('CapsLock'));
    const [first] = useState(value);
    const field = useRef<HTMLInputElement>(null);
    useEffect(() => {
        if (field.current && field.current.value !== String(value ?? '')) field.current.value = String(value ?? '');
    }, [value]);
    return (
        <div className="relative">
            <Input
                {...props}
                ref={field}
                defaultValue={first}
                type={shown ? 'text' : 'password'}
                autoComplete={shown ? 'off' : autoComplete}
                spellCheck={false}
                autoCorrect="off"
                autoCapitalize="off"
                onKeyDown={(e) => (read(e), onKeyDown?.(e))}
                onKeyUp={(e) => (read(e), onKeyUp?.(e))}
                onMouseDown={(e) => (read(e), onMouseDown?.(e))}
                className={cn(caps ? 'pr-14' : 'pr-9', className)}
            />
            {caps && (
                <span role="img" aria-label="Caps Lock is on" className="absolute inset-y-0 right-8 grid w-5 place-items-center text-warn">
                    <Icon name="caps" size={14} />
                </span>
            )}
            <button
                type="button"
                aria-label={`${shown ? 'Hide' : 'Show'} ${what}`}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => setShown((s) => !s)}
                className="absolute inset-y-0 right-0 grid w-9 cursor-pointer place-items-center text-ink-3 hover:text-ink"
            >
                <Icon name={shown ? 'hidden' : 'eye'} size={14} />
            </button>
        </div>
    );
}
