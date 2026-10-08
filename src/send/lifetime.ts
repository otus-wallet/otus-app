// How long a transaction can be signed, as first shown: a blockhash lasts 150 blocks, 30 s once blocks are 200 ms
// (mainnet from epoch 1053, 2026-10-09; 37.5 s at 250 ms before), and signing is allowed for most of it, leaving time
// to land. Counted from when the blockhash was asked for. The network's own word (its blockhash's place among the
// recent ones, at its pace) replaces it as soon as it comes.
export const SIGN_WITHIN = 25_000; // ms
