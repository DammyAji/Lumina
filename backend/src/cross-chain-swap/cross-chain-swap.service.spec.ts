import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { CrossChainSwapService } from './cross-chain-swap.service';
import { ChainRegistryService } from './chains/chain-registry.service';
import { SecretManagerService } from './secret-manager.service';
import { GasPriceOracleService } from './gas-price-oracle.service';
import { MetricsService } from '../common/metrics/metrics.service';
import { SWAP_BROADCASTER } from './swap-broadcaster.interface';
import { CrossChainSwap, SwapStatus } from './entities/cross-chain-swap.entity';
import { SwapChain } from './chains/chain.enum';
import { OnChainHtlcStatus } from './chains/htlc-chain.adapter';
import { SwapException } from '../common/exceptions';

const SECRET = 'bb'.repeat(32);
const SECRET_HASH = 'aa'.repeat(32);
const SOURCE_TIMEOUT = 1_700_090_000;
const TARGET_TIMEOUT = 60_000;

function makeSwap(overrides: Partial<CrossChainSwap> = {}): CrossChainSwap {
  return {
    id: 'row-1',
    swap_id: '11'.repeat(32),
    source_chain: SwapChain.ETHEREUM,
    target_chain: SwapChain.STELLAR,
    source_address: '0xcustomer',
    target_address: 'GMERCHANT',
    amount: '1',
    source_asset: 'ETH',
    target_asset: 'USDC',
    secret_hash: SECRET_HASH,
    encrypted_secret: 'sealed',
    timeout_block: String(SOURCE_TIMEOUT),
    target_timeout_block: String(TARGET_TIMEOUT),
    status: SwapStatus.PENDING,
    attempts: 0,
    max_attempts: 5,
    next_retry_at: null,
    error_message: null,
    source_lock_tx: null,
    target_lock_tx: null,
    target_claim_tx: null,
    source_claim_tx: null,
    refund_tx: null,
    updated_at: new Date(),
    ...overrides,
  } as CrossChainSwap;
}

function lockedState(overrides: Record<string, unknown> = {}) {
  return {
    status: OnChainHtlcStatus.LOCKED,
    amount: (10n ** 18n).toString(),
    secretHash: SECRET_HASH,
    timeout: String(SOURCE_TIMEOUT),
    confirmations: 12,
    preimage: null,
    txHash: '0xlock',
    ...overrides,
  };
}

describe('CrossChainSwapService', () => {
  let service: CrossChainSwapService;
  let repository: Record<string, jest.Mock>;
  let sourceAdapter: Record<string, jest.Mock>;
  let stellarAdapter: Record<string, jest.Mock>;
  let secrets: Record<string, jest.Mock>;
  let gasOracle: Record<string, jest.Mock>;
  let broadcaster: { broadcast: jest.Mock };

  beforeEach(async () => {
    repository = {
      create: jest.fn((data) => ({ attempts: 0, max_attempts: 5, ...data })),
      save: jest.fn(async (entity) => ({ id: entity.id ?? 'row-1', ...entity })),
      update: jest.fn(),
      findOne: jest.fn(),
      find: jest.fn(),
    };

    sourceAdapter = {
      getTimeoutReference: jest.fn().mockResolvedValue(1_700_000_000),
      getHtlcState: jest.fn().mockResolvedValue(null),
      buildLockRequest: jest.fn().mockReturnValue({ htlcAddress: '0xhtlc', timeout: '1' }),
      buildClaimCall: jest.fn().mockReturnValue({ chain: SwapChain.ETHEREUM, to: '0xhtlc' }),
      buildRefundCall: jest.fn(),
    };

    stellarAdapter = {
      getTimeoutReference: jest.fn().mockResolvedValue(50_000),
      getHtlcState: jest.fn().mockResolvedValue(null),
      buildLockRequest: jest.fn().mockReturnValue({ htlcAddress: 'CHTLC', amount: '10000000', timeout: String(TARGET_TIMEOUT) }),
      buildClaimCall: jest.fn().mockReturnValue({ chain: SwapChain.STELLAR, to: 'CHTLC' }),
      buildRefundCall: jest.fn(),
    };

    const chains = {
      get: jest.fn((chain: SwapChain) =>
        chain === SwapChain.STELLAR ? stellarAdapter : sourceAdapter,
      ),
      isConfigured: jest.fn().mockReturnValue(true),
      configuredChains: jest.fn().mockReturnValue([SwapChain.ETHEREUM]),
    };

    secrets = {
      generateSecret: jest
        .fn()
        .mockReturnValue({ secret: SECRET, secretHash: SECRET_HASH, encryptedSecret: 'sealed' }),
      decrypt: jest.fn().mockReturnValue(SECRET),
    };

    gasOracle = { shouldDefer: jest.fn().mockResolvedValue(false) };
    broadcaster = { broadcast: jest.fn().mockResolvedValue({ txHash: '0xbroadcast' }) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CrossChainSwapService,
        { provide: getRepositoryToken(CrossChainSwap), useValue: repository },
        { provide: ChainRegistryService, useValue: chains },
        { provide: SecretManagerService, useValue: secrets },
        { provide: GasPriceOracleService, useValue: gasOracle },
        { provide: MetricsService, useValue: { recordBlockchainTx: jest.fn() } },
        { provide: SWAP_BROADCASTER, useValue: broadcaster },
      ],
    }).compile();

    service = module.get(CrossChainSwapService);
  });

  describe('supportedChains', () => {
    it('lists every source chain with whether it is configured here', () => {
      const chains = service.supportedChains();

      expect(chains.map((chain) => chain.chain)).toEqual([
        SwapChain.ETHEREUM,
        SwapChain.POLYGON,
        SwapChain.BITCOIN,
        SwapChain.SOLANA,
      ]);
      expect(chains.every((chain) => chain.configured)).toBe(true);
    });

    it('never offers Stellar as a source, since it is always the target', () => {
      expect(service.supportedChains().map((chain) => chain.chain)).not.toContain(
        SwapChain.STELLAR,
      );
    });
  });

  describe('initiate', () => {
    const dto = {
      source_chain: SwapChain.ETHEREUM,
      source_address: '0xcustomer',
      target_address: 'GMERCHANT',
      amount: '1',
      source_asset: 'ETH',
    };

    it('creates a pending swap with a fresh hashlock and both timelocks', async () => {
      const { swap } = await service.initiate(dto);

      expect(swap.status).toEqual(SwapStatus.PENDING);
      expect(swap.secret_hash).toEqual(SECRET_HASH);
      expect(swap.swap_id).toMatch(/^[0-9a-f]{64}$/);
      expect(Number(swap.timeout_block)).toBeGreaterThan(1_700_000_000);
      expect(Number(swap.target_timeout_block)).toBeGreaterThan(50_000);
    });

    it('never returns the sealed secret to the caller', async () => {
      const { swap } = await service.initiate(dto);

      expect(swap).not.toHaveProperty('encrypted_secret');
    });

    it('returns the lock request the customer has to satisfy', async () => {
      const { lockRequest } = await service.initiate(dto);

      expect(lockRequest.htlcAddress).toEqual('0xhtlc');
      expect(repository.update).toHaveBeenCalledWith('row-1', {
        source_htlc_address: '0xhtlc',
      });
    });

    it('broadcasts nothing — the customer funds their own leg', async () => {
      await service.initiate(dto);

      expect(broadcaster.broadcast).not.toHaveBeenCalled();
    });

    it('rejects Stellar as a source chain', async () => {
      await expect(
        service.initiate({ ...dto, source_chain: SwapChain.STELLAR }),
      ).rejects.toThrow(SwapException);
    });

    it('rejects a chain this deployment has not configured', async () => {
      (service as any).chains.isConfigured.mockReturnValue(false);

      await expect(service.initiate(dto)).rejects.toThrow(/not configured/);
    });
  });

  describe('advance from PENDING', () => {
    it('waits while nothing is on-chain and the timelock is still in the future', async () => {
      const swap = await service.advance(makeSwap());

      expect(swap.status).toEqual(SwapStatus.PENDING);
      expect(repository.save).not.toHaveBeenCalled();
    });

    it('expires the swap when the timelock passes with no lock at all', async () => {
      sourceAdapter.getTimeoutReference.mockResolvedValue(SOURCE_TIMEOUT + 1);

      const swap = await service.advance(makeSwap());

      expect(swap.status).toEqual(SwapStatus.EXPIRED);
    });

    it('waits while the lock is still short of the required confirmations', async () => {
      sourceAdapter.getHtlcState.mockResolvedValue(lockedState({ confirmations: 3 }));

      const swap = await service.advance(makeSwap());

      expect(swap.status).toEqual(SwapStatus.PENDING);
    });

    it('records the lock once it is confirmed to the chain\'s reorg depth', async () => {
      sourceAdapter.getHtlcState.mockResolvedValue(lockedState());

      const swap = await service.advance(makeSwap());

      expect(swap.status).toEqual(SwapStatus.SOURCE_LOCKED);
      expect(swap.source_lock_tx).toEqual('0xlock');
    });

    it('refuses a lock whose hashlock is not the one this swap agreed to', async () => {
      sourceAdapter.getHtlcState.mockResolvedValue(lockedState({ secretHash: 'cc'.repeat(32) }));

      const swap = await service.advance(makeSwap());

      expect(swap.status).toEqual(SwapStatus.PENDING);
      expect(swap.error_message).toMatch(/hashlock/i);
      expect(swap.attempts).toEqual(1);
    });

    it('refuses a lock that underpays the agreed amount', async () => {
      sourceAdapter.getHtlcState.mockResolvedValue(lockedState({ amount: '1' }));

      const swap = await service.advance(makeSwap());

      expect(swap.status).toEqual(SwapStatus.PENDING);
      expect(swap.error_message).toMatch(/expected/);
    });

    it('accepts a lock that overpays', async () => {
      sourceAdapter.getHtlcState.mockResolvedValue(lockedState({ amount: (10n ** 19n).toString() }));

      await expect(service.advance(makeSwap())).resolves.toMatchObject({
        status: SwapStatus.SOURCE_LOCKED,
      });
    });

    it('sends a lock that only confirmed after its timelock straight to refund', async () => {
      sourceAdapter.getHtlcState.mockResolvedValue(lockedState());
      sourceAdapter.getTimeoutReference.mockResolvedValue(SOURCE_TIMEOUT);

      const swap = await service.advance(makeSwap());

      expect(swap.status).toEqual(SwapStatus.REFUND_PENDING);
    });
  });

  describe('advance from SOURCE_LOCKED', () => {
    it('funds the Stellar leg and records its transaction', async () => {
      const swap = await service.advance(makeSwap({ status: SwapStatus.SOURCE_LOCKED }));

      expect(broadcaster.broadcast).toHaveBeenCalledWith(
        expect.objectContaining({ chain: SwapChain.STELLAR, data: 'lock' }),
      );
      expect(swap.status).toEqual(SwapStatus.TARGET_LOCKED);
      expect(swap.target_lock_tx).toEqual('0xbroadcast');
    });

    it('retries with backoff when the broadcast fails', async () => {
      broadcaster.broadcast.mockRejectedValue(new Error('signer unavailable'));

      const swap = await service.advance(makeSwap({ status: SwapStatus.SOURCE_LOCKED }));

      expect(swap.status).toEqual(SwapStatus.SOURCE_LOCKED);
      expect(swap.attempts).toEqual(1);
      expect(swap.next_retry_at.getTime()).toBeGreaterThan(Date.now());
    });

    it('falls back to the refund path once the attempts are exhausted', async () => {
      broadcaster.broadcast.mockRejectedValue(new Error('signer unavailable'));

      const swap = await service.advance(
        makeSwap({ status: SwapStatus.SOURCE_LOCKED, attempts: 4, max_attempts: 5 }),
      );

      expect(swap.status).toEqual(SwapStatus.REFUND_PENDING);
      expect(swap.next_retry_at).toBeNull();
    });
  });

  describe('advance from TARGET_LOCKED', () => {
    it('claims the merchant\'s leg, which publishes the secret', async () => {
      const swap = await service.advance(makeSwap({ status: SwapStatus.TARGET_LOCKED }));

      expect(secrets.decrypt).toHaveBeenCalledWith('sealed');
      expect(stellarAdapter.buildClaimCall).toHaveBeenCalledWith(expect.anything(), SECRET);
      expect(swap.status).toEqual(SwapStatus.TARGET_CLAIMED);
      expect(swap.target_claim_tx).toEqual('0xbroadcast');
    });

    it('does not re-claim a leg the chain already reports as claimed', async () => {
      stellarAdapter.getHtlcState.mockResolvedValue({ status: OnChainHtlcStatus.CLAIMED });

      const swap = await service.advance(makeSwap({ status: SwapStatus.TARGET_LOCKED }));

      expect(swap.status).toEqual(SwapStatus.TARGET_CLAIMED);
      expect(broadcaster.broadcast).not.toHaveBeenCalled();
    });

    it('refunds instead of claiming once the target timelock has expired', async () => {
      stellarAdapter.getTimeoutReference.mockResolvedValue(TARGET_TIMEOUT);

      const swap = await service.advance(makeSwap({ status: SwapStatus.TARGET_LOCKED }));

      expect(swap.status).toEqual(SwapStatus.REFUND_PENDING);
      expect(broadcaster.broadcast).not.toHaveBeenCalled();
    });
  });

  describe('advance from TARGET_CLAIMED', () => {
    it('claims the source leg with the revealed secret and completes', async () => {
      const swap = await service.advance(makeSwap({ status: SwapStatus.TARGET_CLAIMED }));

      expect(sourceAdapter.buildClaimCall).toHaveBeenCalledWith(expect.anything(), SECRET);
      expect(swap.status).toEqual(SwapStatus.COMPLETED);
      expect(swap.source_claim_tx).toEqual('0xbroadcast');
    });

    it('completes without broadcasting when the source leg is already claimed', async () => {
      sourceAdapter.getHtlcState.mockResolvedValue({ status: OnChainHtlcStatus.CLAIMED });

      const swap = await service.advance(makeSwap({ status: SwapStatus.TARGET_CLAIMED }));

      expect(swap.status).toEqual(SwapStatus.COMPLETED);
      expect(broadcaster.broadcast).not.toHaveBeenCalled();
    });

    it('defers the claim while gas is above the ceiling', async () => {
      gasOracle.shouldDefer.mockResolvedValue(true);

      const swap = await service.advance(makeSwap({ status: SwapStatus.TARGET_CLAIMED }));

      expect(swap.status).toEqual(SwapStatus.TARGET_CLAIMED);
      expect(broadcaster.broadcast).not.toHaveBeenCalled();
    });

    it('fails for manual reconciliation if the source timelock beat the claim', async () => {
      // The secret is public by now, so neither side can refund cleanly.
      sourceAdapter.getTimeoutReference.mockResolvedValue(SOURCE_TIMEOUT + 1);

      const swap = await service.advance(makeSwap({ status: SwapStatus.TARGET_CLAIMED }));

      expect(swap.status).toEqual(SwapStatus.FAILED);
      expect(swap.error_message).toMatch(/manual reconciliation/);
    });
  });

  describe('advance from a terminal state', () => {
    it.each([SwapStatus.COMPLETED, SwapStatus.REFUNDED, SwapStatus.EXPIRED, SwapStatus.FAILED])(
      'leaves a %s swap untouched',
      async (status) => {
        const swap = await service.advance(makeSwap({ status }));

        expect(swap.status).toEqual(status);
        expect(broadcaster.broadcast).not.toHaveBeenCalled();
      },
    );
  });

  describe('requestRefund', () => {
    it('marks a timed-out swap for refund', async () => {
      repository.findOne.mockResolvedValue(makeSwap({ status: SwapStatus.SOURCE_LOCKED }));
      sourceAdapter.getTimeoutReference.mockResolvedValue(SOURCE_TIMEOUT);

      const swap = await service.requestRefund('11'.repeat(32));

      expect(swap.status).toEqual(SwapStatus.REFUND_PENDING);
    });

    it('refuses before the source timelock has expired', async () => {
      repository.findOne.mockResolvedValue(makeSwap({ status: SwapStatus.SOURCE_LOCKED }));

      await expect(service.requestRefund('11'.repeat(32))).rejects.toThrow(/timelock/);
    });

    it('refuses once the secret is out, since the swap can only complete', async () => {
      repository.findOne.mockResolvedValue(makeSwap({ status: SwapStatus.TARGET_CLAIMED }));

      await expect(service.requestRefund('11'.repeat(32))).rejects.toThrow(/cannot be refunded/);
    });

    it('reports an unknown swap as not found', async () => {
      repository.findOne.mockResolvedValue(null);

      await expect(service.requestRefund('missing')).rejects.toThrow(SwapException);
    });
  });

  describe('findBySwapId', () => {
    it('never exposes the sealed secret', async () => {
      repository.findOne.mockResolvedValue(makeSwap());

      await expect(service.findBySwapId('11'.repeat(32))).resolves.not.toHaveProperty(
        'encrypted_secret',
      );
    });
  });
});
