import type { Cluster } from './intake.ts';

/** What the user can change. Every default is the cautious choice. */
export type Settings = {
    signAll: boolean; // let a site ask for several transactions in one call
    rpc: string | null; // a custom mainnet endpoint; null uses Otus's
    lockAfter: number; // minutes Otus stays unlocked once closed; 0 locks it as it closes
    explorer: Explorer; // where a transaction opens
    preflight: boolean; // the RPC simulates a transaction as it is sent, and refuses one that would fail
};

export const DEFAULT_SETTINGS: Settings = { signAll: false, rpc: null, lockAfter: 15, explorer: 'solscan', preflight: true };

/** The explorers a transaction can open in, by name, and the page each gives one. */
export const EXPLORERS = {
    solscan: { name: 'Solscan', tx: (signature: string) => `https://solscan.io/tx/${signature}` },
    solana: { name: 'Solana Explorer', tx: (signature: string) => `https://explorer.solana.com/tx/${signature}` },
    orb: { name: 'Orb', tx: (signature: string) => `https://orbmarkets.io/tx/${signature}` },
} as const;
export type Explorer = keyof typeof EXPLORERS;

/** The explorer chosen, or the default when what is stored is not one. */
export const explorerOf = (settings: Settings) => EXPLORERS[Object.hasOwn(EXPLORERS, settings.explorer) ? settings.explorer : DEFAULT_SETTINGS.explorer];

export const LOCK_CHOICES = [0, 1, 2, 5, 15, 30, 60];
export const MAX_LOCK_AFTER = 1440; // a day

/** A lock time as stored → minutes, or the default when it is not a whole number in range. */
export const lockMinutes = (v: unknown) => (Number.isInteger(v) && (v as number) >= 0 && (v as number) <= MAX_LOCK_AFTER ? (v as number) : DEFAULT_SETTINGS.lockAfter);

// Otus's RPC: otus-server's proxy, which holds the provider's key (never in the extension) and lets through only
// Otus Wallet's origin and the methods it calls.
export const OTUS_RPC = 'https://otus-server-production.up.railway.app';

const PUBLIC_RPC: Record<Cluster, string> = {
    'solana:mainnet': OTUS_RPC,
    'solana:devnet': 'https://api.devnet.solana.com',
    'solana:testnet': 'https://api.testnet.solana.com',
    'solana:localnet': 'http://127.0.0.1:8899',
};

/** The endpoint for a cluster: the user's own for mainnet when set. */
export const rpcFor = (cluster: Cluster, settings: Settings) => (cluster === 'solana:mainnet' && settings.rpc) || PUBLIC_RPC[cluster];
