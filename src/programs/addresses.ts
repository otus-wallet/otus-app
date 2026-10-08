// Addresses Otus knows by heart: programs it reads, and tokens it names without asking. Constants only, so any page
// can take them without the plugins.
import { TOKEN_PROGRAM_ADDRESS } from '@solana-program/token';
import { address, type Address } from '@solana/kit';

export const TOKEN_2022_PROGRAM_ADDRESS = address('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
export const TOKEN_PROGRAMS: readonly Address[] = [TOKEN_PROGRAM_ADDRESS, TOKEN_2022_PROGRAM_ADDRESS];
export const isTokenProgram = (a: string) => (TOKEN_PROGRAMS as readonly string[]).includes(a);
export const STAKE_PROGRAM = address('Stake11111111111111111111111111111111111111');
// Lighthouse sees your wallet as a signer. On mainnet it is immutable: no upgrade authority since slot 294179293.
export const LIGHTHOUSE = address('L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95');

export const WSOL = address('So11111111111111111111111111111111111111112');
export const USDC = address('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
export const USDT = address('Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB');
