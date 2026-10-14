// How hard a new password is to guess, under its field: three marks, filled and coloured as it is weak, fair or strong.
import { strength } from '@otus-wallet/core/password.ts';
import { cn } from '../lib/cn.ts';

const SHOWN = {
    weak: { marks: 1, word: 'Weak', bar: 'bg-danger', text: 'text-danger' },
    fair: { marks: 2, word: 'Fair', bar: 'bg-warn', text: 'text-warn' },
    strong: { marks: 3, word: 'Strong', bar: 'bg-ok', text: 'text-ok' },
} as const;

export function Strength({ password }: { password: string }) {
    if (!password) return null;
    const s = SHOWN[strength(password)];
    return (
        <div className="flex items-center gap-2" role="status" aria-label={`Password strength: ${s.word}`}>
            <span className="flex flex-1 gap-1">
                {[1, 2, 3].map((m) => (
                    <span key={m} className={cn('h-1 flex-1 rounded-full', m <= s.marks ? s.bar : 'bg-rule-2')} />
                ))}
            </span>
            <span className={cn('w-12 text-right text-xs', s.text)}>{s.word}</span>
        </div>
    );
}
