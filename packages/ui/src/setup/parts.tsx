// The setup tab's small pieces of text and layout, shared by its pages.
import type { ReactNode } from 'react';

export const Lead = ({ children }: { children: ReactNode }) => <h1 className="mt-2 text-xl font-extrabold">{children}</h1>;
export const Soft = ({ children }: { children: ReactNode }) => <p className="text-xs text-ink-2">{children}</p>;
export const Muted = ({ children }: { children: ReactNode }) => <p className="text-xs text-ink-3">{children}</p>;
export const Heading = ({ children }: { children: ReactNode }) => <h2 className="pixel text-xs text-ink-2">{children}</h2>;
export const Row = ({ children }: { children: ReactNode }) => <div className="flex flex-wrap justify-end gap-2">{children}</div>;
export const ErrorLine = ({ children }: { children: ReactNode }) =>
    children ? (
        <p role="alert" className="text-xs text-danger">
            {children}
        </p>
    ) : null;
