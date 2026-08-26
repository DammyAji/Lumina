import { UnsignedChainCall } from './chains/htlc-chain.adapter';

export const SWAP_BROADCASTER = Symbol('SWAP_BROADCASTER');

export interface BroadcastResult {
  txHash: string;
}

/**
 * Signs and broadcasts the unsigned calls the coordinator produces.
 *
 * Signing is kept behind this port on purpose. The coordinator decides *what*
 * has to happen on-chain and when; whichever custody setup a deployment runs —
 * an HSM, a KMS, a remote signer — decides how it gets signed, without the swap
 * state machine ever holding a key.
 */
export interface SwapBroadcaster {
  broadcast(call: UnsignedChainCall): Promise<BroadcastResult>;
}
