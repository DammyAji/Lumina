import { SwapChain } from './chains/chain.enum';
import {
  hasTimedOut,
  MIN_TIMELOCK_GAP_SECONDS,
  planTimelocks,
  secondsUntilTimeout,
  toChainTimeout,
} from './timelock.util';

const NOW = new Date('2026-01-01T00:00:00Z');

function plan(overrides: Partial<Parameters<typeof planTimelocks>[0]> = {}) {
  return planTimelocks({
    sourceChain: SwapChain.ETHEREUM,
    sourceReference: 1_700_000_000,
    targetReference: 50_000,
    sourceTtlSeconds: 24 * 3600,
    targetTtlSeconds: 12 * 3600,
    now: NOW,
    ...overrides,
  });
}

describe('planTimelocks', () => {
  it('expresses an EVM timeout as a unix timestamp', () => {
    expect(plan().sourceTimeout).toEqual(String(1_700_000_000 + 24 * 3600));
  });

  it('expresses a Bitcoin timeout as a projected block height', () => {
    // 24h of 10-minute blocks is 144 blocks past the tip.
    const result = plan({ sourceChain: SwapChain.BITCOIN, sourceReference: 800_000 });

    expect(result.sourceTimeout).toEqual(String(800_000 + 144));
  });

  it('always expresses the Stellar timeout as a ledger sequence', () => {
    // 12h of 5-second ledgers.
    expect(plan().targetTimeout).toEqual(String(50_000 + 12 * 3600 / 5));
  });

  it('returns wall-clock deadlines for both legs', () => {
    const result = plan();

    expect(result.sourceDeadline).toEqual(new Date('2026-01-02T00:00:00Z'));
    expect(result.targetDeadline).toEqual(new Date('2026-01-01T12:00:00Z'));
  });

  it('rejects a target timelock that does not expire well before the source', () => {
    // Without a gap the customer could refund while Lumina can still claim.
    expect(() => plan({ targetTtlSeconds: 24 * 3600 })).toThrow(/at least/);
    expect(() =>
      plan({ targetTtlSeconds: 24 * 3600 - MIN_TIMELOCK_GAP_SECONDS + 1 }),
    ).toThrow(/at least/);
  });

  it('accepts a pair exactly at the minimum gap', () => {
    expect(() => plan({ targetTtlSeconds: 24 * 3600 - MIN_TIMELOCK_GAP_SECONDS })).not.toThrow();
  });

  it('rejects non-positive durations', () => {
    expect(() => plan({ sourceTtlSeconds: 0 })).toThrow(/must be positive/);
    expect(() => plan({ targetTtlSeconds: -1 })).toThrow(/must be positive/);
  });
});

describe('toChainTimeout', () => {
  it('rounds block-height timeouts up so the deadline is never early', () => {
    // 61 seconds of 600-second blocks still has to reach the next block.
    expect(toChainTimeout(SwapChain.BITCOIN, 100, 61)).toEqual(101);
  });

  it('adds seconds directly on timestamp chains', () => {
    expect(toChainTimeout(SwapChain.SOLANA, 1_000, 61)).toEqual(1_061);
  });
});

describe('hasTimedOut', () => {
  it('is true at and after the timeout, false before', () => {
    expect(hasTimedOut('100', 99)).toBe(false);
    expect(hasTimedOut('100', 100)).toBe(true);
    expect(hasTimedOut('100', 101)).toBe(true);
  });
});

describe('secondsUntilTimeout', () => {
  it('returns the raw difference on timestamp chains', () => {
    expect(secondsUntilTimeout(SwapChain.ETHEREUM, '1000', 400)).toEqual(600);
  });

  it('scales block-height differences by block time', () => {
    expect(secondsUntilTimeout(SwapChain.BITCOIN, '110', 100)).toEqual(6_000);
  });

  it('goes negative once the timeout has passed', () => {
    expect(secondsUntilTimeout(SwapChain.ETHEREUM, '1000', 1_200)).toEqual(-200);
  });
});
