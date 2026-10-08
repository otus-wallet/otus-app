// Class names joined, with Tailwind's conflicting ones resolved: what shadcn/ui's components expect as `cn`.
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export const cn = (...inputs: ClassValue[]) => twMerge(clsx(inputs));
