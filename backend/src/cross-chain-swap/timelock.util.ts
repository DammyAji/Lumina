import { CHAIN_METADATA, SwapChain, TimeoutUnit } from './chains/chain.enum';

/**
 * Minimum gap between the two legs' deadlines.
 *
 * The Stellar leg must expire well before the source leg, or the customer could
 * refund their side while Lumina's side is still claimable and walk away with
 * both. An hour is comfortably longer than the confirmation depth of any
 * supported chain.
 */
export const MIN_TIMELOCK_GAP_SECONDS = 3_600;

export interface TimelockInputs {
  sourceChain: SwapChain;
  /** Source chain's current block height or unix timestamp. */
  sourceReference: number;
  /** Stellar's current ledger sequence. */
  targetReference: number;
  /** How long the customer has to fund and settle the source leg. */
  sourceTtlSeconds: number;
  /** How long the merchant's Stellar leg stays claimable. */
  targetTtlSeconds: number;
  now: Date;
}

export interface TimelockPlan {
  /** Source-chain timeout in that chain's own unit. */
  sourceTimeout: string;
  /** Stellar ledger sequence the target leg expires at. */
  targetTimeout: string;
  sourceDeadline: Date;
  targetDeadline: Date;
}

/**
 * Turns two durations into the concrete timelocks each chain understands, and
 * refuses any pair that would leave the swap non-atomic.
 */
export function planTimelocks(inputs: TimelockInputs): TimelockPlan {
  const { sourceChain, sourceReference, targetReference, sourceTtlSeconds, targetTtlSeconds, now } =
    inputs;

  if (sourceTtlSeconds <= 0 || targetTtlSeconds <= 0) {
    throw new Error('Swap timelock durations must be positive');
  }

  if (sourceTtlSeconds - targetTtlSeconds < MIN_TIMELOCK_GAP_SECONDS) {
    throw new Error(
      `Source timelock must expire at least ${MIN_TIMELOCK_GAP_SECONDS}s after the target ` +
        `timelock, got a gap of ${sourceTtlSeconds - targetTtlSeconds}s`,
    );
  }

  return {
    sourceTimeout: String(toChainTimeout(sourceChain, sourceReference, sourceTtlSeconds)),
    targetTimeout: String(toChainTimeout(SwapChain.STELLAR, targetReference, targetTtlSeconds)),
    sourceDeadline: new Date(now.getTime() + sourceTtlSeconds * 1000),
    targetDeadline: new Date(now.getTime() + targetTtlSeconds * 1000),
  };
}

/**
 * Converts a duration into a chain's timeout value: a unix timestamp on chains
 * that compare against wall-clock time, or a projected height on chains that
 * compare against block count.
 */
export function toChainTimeout(chain: SwapChain, reference: number, ttlSeconds: number): number {
  const { timeoutUnit, averageBlockTimeSeconds } = CHAIN_METADATA[chain];

  if (timeoutUnit === TimeoutUnit.UNIX_SECONDS) {
    return reference + ttlSeconds;
  }

  // Round up so the deadline is never earlier than the requested duration.
  return reference + Math.ceil(ttlSeconds / averageBlockTimeSeconds);
}

/** True when `reference` has reached or passed `timeout` on that chain. */
export function hasTimedOut(timeout: string, reference: number): boolean {
  return reference >= Number(timeout);
}

/** Seconds left before `timeout`, negative once it has passed. */
export function secondsUntilTimeout(
  chain: SwapChain,
  timeout: string,
  reference: number,
): number {
  const { timeoutUnit, averageBlockTimeSeconds } = CHAIN_METADATA[chain];
  const remaining = Number(timeout) - reference;

  return timeoutUnit === TimeoutUnit.UNIX_SECONDS
    ? remaining
    : remaining * averageBlockTimeSeconds;
}
