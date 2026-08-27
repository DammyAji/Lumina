import { ChainListenerService } from './chain-listener.service';
import { CrossChainSwap, SwapStatus } from './entities/cross-chain-swap.entity';
import { SwapChain } from './chains/chain.enum';

function makeSwap(overrides: Partial<CrossChainSwap> = {}): CrossChainSwap {
  return {
    swap_id: '11'.repeat(32),
    source_chain: SwapChain.ETHEREUM,
    status: SwapStatus.PENDING,
    next_retry_at: null,
    ...overrides,
  } as CrossChainSwap;
}

describe('ChainListenerService', () => {
  let swaps: { findActive: jest.Mock; advance: jest.Mock };
  let chains: { isConfigured: jest.Mock };
  let locks: { withLock: jest.Mock };
  let listener: ChainListenerService;

  beforeEach(() => {
    swaps = { findActive: jest.fn().mockResolvedValue([]), advance: jest.fn() };
    chains = { isConfigured: jest.fn().mockReturnValue(true) };
    locks = { withLock: jest.fn(async (_key, _id, fn) => fn()) };

    listener = new ChainListenerService(swaps as any, chains as any, locks as any);
  });

  it('does nothing when there are no active swaps', async () => {
    await listener.monitorSwaps();

    expect(swaps.advance).not.toHaveBeenCalled();
  });

  it('advances every due swap', async () => {
    swaps.findActive.mockResolvedValue([makeSwap(), makeSwap({ swap_id: '22'.repeat(32) })]);

    await listener.monitorSwaps();

    expect(swaps.advance).toHaveBeenCalledTimes(2);
  });

  it('takes a per-swap lock so replicas cannot double-broadcast', async () => {
    const swap = makeSwap();
    swaps.findActive.mockResolvedValue([swap]);

    await listener.monitorSwaps();

    expect(locks.withLock).toHaveBeenCalledWith(
      `swap:${swap.swap_id}`,
      expect.any(String),
      expect.any(Function),
      expect.objectContaining({ maxRetries: 1 }),
    );
  });

  it('skips a swap whose retry backoff has not elapsed', async () => {
    swaps.findActive.mockResolvedValue([
      makeSwap({ next_retry_at: new Date(Date.now() + 60_000) }),
    ]);

    await listener.monitorSwaps();

    expect(swaps.advance).not.toHaveBeenCalled();
  });

  it('advances a swap whose retry backoff has elapsed', async () => {
    swaps.findActive.mockResolvedValue([
      makeSwap({ next_retry_at: new Date(Date.now() - 1_000) }),
    ]);

    await listener.monitorSwaps();

    expect(swaps.advance).toHaveBeenCalled();
  });

  it('leaves refund-pending swaps to the refund service', async () => {
    swaps.findActive.mockResolvedValue([makeSwap({ status: SwapStatus.REFUND_PENDING })]);

    await listener.monitorSwaps();

    expect(swaps.advance).not.toHaveBeenCalled();
  });

  it('skips a swap whose chain is no longer configured', async () => {
    chains.isConfigured.mockReturnValue(false);
    swaps.findActive.mockResolvedValue([makeSwap()]);

    await listener.monitorSwaps();

    expect(swaps.advance).not.toHaveBeenCalled();
  });

  it('keeps advancing the other swaps when one of them fails', async () => {
    swaps.findActive.mockResolvedValue([makeSwap(), makeSwap({ swap_id: '22'.repeat(32) })]);
    swaps.advance.mockRejectedValueOnce(new Error('rpc down'));

    await expect(listener.monitorSwaps()).resolves.toBeUndefined();
    expect(swaps.advance).toHaveBeenCalledTimes(2);
  });

  it('does not overlap poll cycles', async () => {
    let release: () => void;
    swaps.findActive.mockImplementation(
      () => new Promise((resolve) => (release = () => resolve([]))),
    );

    const first = listener.monitorSwaps();
    await listener.monitorSwaps();

    expect(swaps.findActive).toHaveBeenCalledTimes(1);

    release();
    await first;
  });

  it('survives a repository failure without wedging the next cycle', async () => {
    swaps.findActive.mockRejectedValueOnce(new Error('db down'));

    await expect(listener.monitorSwaps()).resolves.toBeUndefined();

    swaps.findActive.mockResolvedValue([makeSwap()]);
    await listener.monitorSwaps();

    expect(swaps.advance).toHaveBeenCalledTimes(1);
  });
});
