import { RefundService } from './refund.service';
import { CrossChainSwap, SwapStatus } from './entities/cross-chain-swap.entity';
import { SwapChain } from './chains/chain.enum';
import { OnChainHtlcStatus } from './chains/htlc-chain.adapter';

const SOURCE_TIMEOUT = 1_700_090_000;
const TARGET_TIMEOUT = 60_000;

function makeSwap(overrides: Partial<CrossChainSwap> = {}): CrossChainSwap {
  return {
    id: 'row-1',
    swap_id: '11'.repeat(32),
    source_chain: SwapChain.ETHEREUM,
    target_chain: SwapChain.STELLAR,
    source_htlc_address: '0xhtlc',
    timeout_block: String(SOURCE_TIMEOUT),
    target_timeout_block: String(TARGET_TIMEOUT),
    status: SwapStatus.REFUND_PENDING,
    attempts: 0,
    next_retry_at: null,
    target_lock_tx: null,
    refund_tx: null,
    ...overrides,
  } as CrossChainSwap;
}

describe('RefundService', () => {
  let repository: Record<string, jest.Mock>;
  let sourceAdapter: Record<string, jest.Mock>;
  let stellarAdapter: Record<string, jest.Mock>;
  let locks: { withLock: jest.Mock };
  let broadcaster: { broadcast: jest.Mock };
  let service: RefundService;

  beforeEach(() => {
    repository = {
      find: jest.fn().mockResolvedValue([]),
      save: jest.fn(async (entity) => entity),
      update: jest.fn(),
    };

    sourceAdapter = {
      getHtlcState: jest.fn().mockResolvedValue(null),
      getTimeoutReference: jest.fn().mockResolvedValue(SOURCE_TIMEOUT + 1),
      buildRefundCall: jest.fn().mockReturnValue({ chain: SwapChain.ETHEREUM }),
    };

    stellarAdapter = {
      getHtlcState: jest.fn().mockResolvedValue(null),
      getTimeoutReference: jest.fn().mockResolvedValue(TARGET_TIMEOUT + 1),
      buildRefundCall: jest.fn().mockReturnValue({ chain: SwapChain.STELLAR }),
    };

    const chains = {
      get: jest.fn((chain: SwapChain) =>
        chain === SwapChain.STELLAR ? stellarAdapter : sourceAdapter,
      ),
    };

    locks = { withLock: jest.fn(async (_key, _id, fn) => fn()) };
    broadcaster = { broadcast: jest.fn().mockResolvedValue({ txHash: 'refund-tx' }) };

    service = new RefundService(
      repository as any,
      chains as any,
      locks as any,
      broadcaster as any,
    );
  });

  describe('processRefunds', () => {
    it('does nothing when nothing is pending', async () => {
      await service.processRefunds();

      expect(broadcaster.broadcast).not.toHaveBeenCalled();
    });

    it('skips a swap still inside its retry backoff', async () => {
      repository.find.mockResolvedValue([
        makeSwap({ next_retry_at: new Date(Date.now() + 60_000) }),
      ]);

      await service.processRefunds();

      expect(repository.save).not.toHaveBeenCalled();
    });

    it('takes a per-swap lock, the same one the listener uses', async () => {
      const swap = makeSwap();
      repository.find.mockResolvedValue([swap]);

      await service.processRefunds();

      expect(locks.withLock).toHaveBeenCalledWith(
        `swap:${swap.swap_id}`,
        expect.any(String),
        expect.any(Function),
        expect.objectContaining({ maxRetries: 1 }),
      );
    });

    it('keeps going when one refund fails', async () => {
      repository.find.mockResolvedValue([makeSwap(), makeSwap({ swap_id: '22'.repeat(32) })]);
      locks.withLock.mockRejectedValueOnce(new Error('lock held'));

      await expect(service.processRefunds()).resolves.toBeUndefined();
      expect(locks.withLock).toHaveBeenCalledTimes(2);
    });
  });

  describe('refund', () => {
    it('marks a never-funded swap refunded without broadcasting anything', async () => {
      const swap = await service.refund(makeSwap());

      expect(swap.status).toEqual(SwapStatus.REFUNDED);
      expect(broadcaster.broadcast).not.toHaveBeenCalled();
    });

    it('refunds the Stellar leg once its own timelock has expired', async () => {
      stellarAdapter.getHtlcState.mockResolvedValue({ status: OnChainHtlcStatus.LOCKED });

      const swap = await service.refund(makeSwap({ target_lock_tx: 'stellar-lock' }));

      expect(broadcaster.broadcast).toHaveBeenCalledWith({ chain: SwapChain.STELLAR });
      expect(swap.refund_tx).toEqual('refund-tx');
      expect(swap.status).toEqual(SwapStatus.REFUNDED);
    });

    it('waits rather than refunding the Stellar leg before its timelock', async () => {
      stellarAdapter.getHtlcState.mockResolvedValue({ status: OnChainHtlcStatus.LOCKED });
      stellarAdapter.getTimeoutReference.mockResolvedValue(TARGET_TIMEOUT - 1);

      const swap = await service.refund(makeSwap({ target_lock_tx: 'stellar-lock' }));

      expect(broadcaster.broadcast).not.toHaveBeenCalled();
      expect(swap.status).toEqual(SwapStatus.REFUND_PENDING);
      expect(swap.next_retry_at.getTime()).toBeGreaterThan(Date.now());
    });

    it('does not re-broadcast a Stellar refund it already sent', async () => {
      stellarAdapter.getHtlcState.mockResolvedValue({ status: OnChainHtlcStatus.LOCKED });

      await service.refund(makeSwap({ target_lock_tx: 'stellar-lock', refund_tx: 'already' }));

      expect(broadcaster.broadcast).not.toHaveBeenCalled();
    });

    it('waits on a source leg that only the customer can refund', async () => {
      sourceAdapter.getHtlcState.mockResolvedValue({ status: OnChainHtlcStatus.LOCKED });

      const swap = await service.refund(makeSwap());

      expect(swap.status).toEqual(SwapStatus.REFUND_PENDING);
      expect(swap.error_message).toMatch(/timelock/i);
    });

    it('completes once the customer has refunded their own leg', async () => {
      sourceAdapter.getHtlcState.mockResolvedValue({ status: OnChainHtlcStatus.REFUNDED });

      const swap = await service.refund(makeSwap());

      expect(swap.status).toEqual(SwapStatus.REFUNDED);
    });

    it('backs off exponentially across repeated attempts', async () => {
      sourceAdapter.getHtlcState.mockResolvedValue({ status: OnChainHtlcStatus.LOCKED });

      const first = await service.refund(makeSwap({ attempts: 0 }));
      const later = await service.refund(makeSwap({ attempts: 5 }));

      expect(later.next_retry_at.getTime()).toBeGreaterThan(first.next_retry_at.getTime());
    });

    it('retries rather than giving up when a chain query throws', async () => {
      sourceAdapter.getHtlcState.mockRejectedValue(new Error('rpc down'));

      const swap = await service.refund(makeSwap());

      expect(swap.status).toEqual(SwapStatus.REFUND_PENDING);
      expect(swap.error_message).toEqual('rpc down');
      expect(swap.attempts).toEqual(1);
    });
  });
});
