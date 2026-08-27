import { CrossChainSwap } from '../entities/cross-chain-swap.entity';
import { SwapChain } from './chain.enum';

/** State of an HTLC as the chain itself reports it. */
export enum OnChainHtlcStatus {
  LOCKED = 'locked',
  CLAIMED = 'claimed',
  REFUNDED = 'refunded',
}

export interface OnChainHtlcState {
  status: OnChainHtlcStatus;
  /** Locked amount in the chain's smallest unit. */
  amount: string;
  /** sha256 hashlock, hex without `0x`. */
  secretHash: string;
  /** Timeout in the chain's own unit — block height or unix seconds. */
  timeout: string;
  /** Confirmations behind the chain tip, used to ride out reorgs. */
  confirmations: number;
  /** Revealed by a claim; `null` while the swap is still locked. */
  preimage: string | null;
  txHash: string | null;
}

/**
 * What the customer has to do on the source chain to fund their leg. Returned
 * verbatim to the checkout so it can render a QR code or prompt a wallet.
 */
export interface HtlcLockRequest {
  chain: SwapChain;
  /** Contract, program, or script address that will hold the escrow. */
  htlcAddress: string;
  /** Amount in the chain's smallest unit. */
  amount: string;
  secretHash: string;
  timeout: string;
  /** ABI-encoded calldata (EVM/Solana) or the redeem script hex (Bitcoin). */
  payload: string | null;
  /** Extra chain-specific fields — redeem script, PDA, memo, and so on. */
  metadata?: Record<string, string>;
}

/**
 * An unsigned call the coordinator wants broadcast. Signing is deliberately
 * outside this module: keys live in the deployment's signer, and adapters only
 * ever produce the payload to sign.
 */
export interface UnsignedChainCall {
  chain: SwapChain;
  to: string;
  /** ABI-encoded calldata, instruction data, or raw script — chain dependent. */
  data: string;
  value: string;
  /** Suggested fee in the chain's smallest unit, from the gas price oracle. */
  suggestedFee?: string;
  metadata?: Record<string, string>;
}

/**
 * One chain's half of the HTLC protocol.
 *
 * Adapters are read-and-build only: they observe the chain and produce unsigned
 * calls. Nothing here holds a key or broadcasts, which keeps the coordinator's
 * retry logic free to run any of these calls more than once.
 */
export interface HtlcChainAdapter {
  readonly chain: SwapChain;

  /** False when the chain's RPC/contract env vars are missing. */
  isConfigured(): boolean;

  /**
   * The value a timelock is compared against on this chain: block height for
   * Bitcoin and Stellar, unix seconds for EVM chains and Solana.
   */
  getTimeoutReference(): Promise<number>;

  /** Reads the swap's HTLC, or `null` if it has not been funded yet. */
  getHtlcState(swap: CrossChainSwap): Promise<OnChainHtlcState | null>;

  buildLockRequest(swap: CrossChainSwap): HtlcLockRequest;

  buildClaimCall(swap: CrossChainSwap, secretHex: string): UnsignedChainCall;

  buildRefundCall(swap: CrossChainSwap): UnsignedChainCall;
}
