import { createHash } from 'node:crypto';
import { CrossChainSwapService } from '../cross-chain-swap.service';
import { ChainListenerService } from '../chain-listener.service';
import { RefundService } from '../refund.service';
import { SecretManagerService } from '../secret-manager.service';
import { CrossChainSwap, SwapStatus } from '../entities/cross-chain-swap.entity';
import { CHAIN_METADATA, SwapChain } from '../chains/chain.enum';
import {
  HtlcChainAdapter,
  HtlcLockRequest,
  OnChainHtlcState,
  OnChainHtlcStatus,
  UnsignedChainCall,
} from '../chains/htlc-chain.adapter';
import { toSmallestUnit } from '../chains/amount.util';
import { SwapBroadcaster } from '../swap-broadcaster.interface';

/**
 * Full-lifecycle tests for a cross-chain swap.
 *
 * Both chains are replaced by in-memory HTLCs that enforce the same rules the
 * real contracts do — hashlock on claim, timelock on refund, terminal states —
 * so the coordinator, listener, and refund worker are exercised together
 * against something that can actually reject an invalid move.
 */

interface FakeHtlc {
  status: OnChainHtlcStatus;
  amount: string;
  secretHash: string;
  timeout: number;
  lockedAtReference: number;
  preimage: string | null;
  txHash: string;
}

class FakeChain implements HtlcChainAdapter {
  readonly htlcs = new Map<string, FakeHtlc>();
  reference: number;
  private nextTx = 1;

  constructor(
    readonly chain: SwapChain,
    reference: number,
  ) {
    this.reference = reference;
  }

  isConfigured(): boolean {
    return true;
  }

  async getTimeoutReference(): Promise<number> {
    return this.reference;
  }

  async getHtlcState(swap: CrossChainSwap): Promise<OnChainHtlcState | null> {
    const htlc = this.htlcs.get(swap.swap_id);

    if (!htlc) {
      return null;
    }

    return {
      status: htlc.status,
      amount: htlc.amount,
      secretHash: htlc.secretHash,
      timeout: String(htlc.timeout),
      confirmations: this.confirmationsFor(htlc),
      preimage: htlc.preimage,
      txHash: htlc.txHash,
    };
  }

  buildLockRequest(swap: CrossChainSwap): HtlcLockRequest {
    return {
      chain: this.chain,
      htlcAddress: `${this.chain}-htlc`,
      amount: toSmallestUnit(swap.amount, this.chain).toString(),
      secretHash: swap.secret_hash,
      timeout: this.timeoutFor(swap),
      payload: null,
    };
  }

  buildClaimCall(swap: CrossChainSwap, secretHex: string): UnsignedChainCall {
    return {
      chain: this.chain,
      to: `${this.chain}-htlc`,
      data: 'claim',
      value: '0',
      metadata: { op: 'claim', swapId: swap.swap_id, preimage: secretHex },
    };
  }

  buildRefundCall(swap: CrossChainSwap): UnsignedChainCall {
    return {
      chain: this.chain,
      to: `${this.chain}-htlc`,
      data: 'refund',
      value: '0',
      metadata: { op: 'refund', swapId: swap.swap_id },
    };
  }

  /** Simulates whoever funds this leg locking their funds. */
  lock(swap: CrossChainSwap, options: { amount?: string; secretHash?: string } = {}): string {
    const txHash = `${this.chain}-tx-${this.nextTx++}`;

    this.htlcs.set(swap.swap_id, {
      status: OnChainHtlcStatus.LOCKED,
      amount: options.amount ?? toSmallestUnit(swap.amount, this.chain).toString(),
      secretHash: options.secretHash ?? swap.secret_hash,
      timeout: Number(this.timeoutFor(swap)),
      lockedAtReference: this.reference,
      preimage: null,
      txHash,
    });

    return txHash;
  }

  /** Enforces the same rules the on-chain contracts do. */
  claim(swapId: string, preimage: string): string {
    const htlc = this.require(swapId);

    if (htlc.status !== OnChainHtlcStatus.LOCKED) {
      throw new Error(`${this.chain}: swap is not locked`);
    }

    if (this.reference >= htlc.timeout) {
      throw new Error(`${this.chain}: timelock expired`);
    }

    if (createHash('sha256').update(Buffer.from(preimage, 'hex')).digest('hex') !== htlc.secretHash) {
      throw new Error(`${this.chain}: invalid preimage`);
    }

    htlc.status = OnChainHtlcStatus.CLAIMED;
    htlc.preimage = preimage;

    return `${this.chain}-claim-${this.nextTx++}`;
  }

  refund(swapId: string): string {
    const htlc = this.require(swapId);

    if (htlc.status !== OnChainHtlcStatus.LOCKED) {
      throw new Error(`${this.chain}: swap is not locked`);
    }

    if (this.reference < htlc.timeout) {
      throw new Error(`${this.chain}: timelock has not expired`);
    }

    htlc.status = OnChainHtlcStatus.REFUNDED;

    return `${this.chain}-refund-${this.nextTx++}`;
  }

  private require(swapId: string): FakeHtlc {
    const htlc = this.htlcs.get(swapId);

    if (!htlc) {
      throw new Error(`${this.chain}: no such swap`);
    }

    return htlc;
  }

  private confirmationsFor(htlc: FakeHtlc): number {
    if (CHAIN_METADATA[this.chain].timeoutUnit === 'unix_seconds') {
      // Timestamps advance in seconds; treat each block time as one confirmation.
      const blockTime = CHAIN_METADATA[this.chain].averageBlockTimeSeconds;
      return Math.floor((this.reference - htlc.lockedAtReference) / blockTime) + 1;
    }

    return this.reference - htlc.lockedAtReference + 1;
  }

  private timeoutFor(swap: CrossChainSwap): string {
    return this.chain === SwapChain.STELLAR
      ? (swap.target_timeout_block ?? swap.timeout_block)
      : swap.timeout_block;
  }
}

/** Applies broadcast calls to whichever fake chain they name. */
class FakeBroadcaster implements SwapBroadcaster {
  readonly calls: UnsignedChainCall[] = [];

  constructor(private readonly chains: Map<SwapChain, FakeChain>) {}

  async broadcast(call: UnsignedChainCall) {
    this.calls.push(call);
    const chain = this.chains.get(call.chain);
    const swapId = call.metadata?.swapId;

    if (call.data === 'lock') {
      const txHash = `${call.chain}-lock`;
      chain.htlcs.set(swapId, {
        status: OnChainHtlcStatus.LOCKED,
        amount: call.value,
        secretHash: call.metadata.secretHash,
        timeout: Number(call.metadata.timeout),
        lockedAtReference: chain.reference,
        preimage: null,
        txHash,
      });
      return { txHash };
    }

    if (call.metadata?.op === 'claim') {
      return { txHash: chain.claim(swapId, call.metadata.preimage) };
    }

    return { txHash: chain.refund(swapId) };
  }
}

/** Minimal in-memory stand-in for the TypeORM repository. */
class FakeRepository {
  readonly rows: CrossChainSwap[] = [];
  private nextId = 1;

  create(data: Partial<CrossChainSwap>): CrossChainSwap {
    return { attempts: 0, max_attempts: 5, ...data } as CrossChainSwap;
  }

  async save(entity: CrossChainSwap): Promise<CrossChainSwap> {
    entity.id ??= `row-${this.nextId++}`;
    entity.updated_at = new Date();

    const index = this.rows.findIndex((row) => row.id === entity.id);
    index >= 0 ? (this.rows[index] = entity) : this.rows.push(entity);

    return entity;
  }

  async update(id: string, patch: Partial<CrossChainSwap>): Promise<void> {
    Object.assign(this.rows.find((row) => row.id === id) ?? {}, patch);
  }

  async findOne({ where }: { where: Partial<CrossChainSwap> }): Promise<CrossChainSwap | null> {
    return this.rows.find((row) => row.swap_id === where.swap_id) ?? null;
  }

  async find({ where }: { where?: any } = {}): Promise<CrossChainSwap[]> {
    if (where?.status && typeof where.status === 'string') {
      return this.rows.filter((row) => row.status === where.status);
    }

    // Stands in for `Not(In(TERMINAL_STATUSES))`.
    const terminal = [
      SwapStatus.COMPLETED,
      SwapStatus.REFUNDED,
      SwapStatus.EXPIRED,
      SwapStatus.FAILED,
    ];

    return this.rows.filter((row) => !terminal.includes(row.status));
  }
}

/** Exclusive lock, so two listeners racing behave the way Redis would. */
class FakeLocks {
  private readonly held = new Set<string>();

  async withLock<T>(key: string, _id: string, fn: () => Promise<T>): Promise<T> {
    if (this.held.has(key)) {
      throw new Error(`Failed to acquire lock for key: ${key}`);
    }

    this.held.add(key);

    try {
      return await fn();
    } finally {
      this.held.delete(key);
    }
  }
}

const INITIAL_EVM_TIME = 1_700_000_000;
const INITIAL_LEDGER = 50_000;

describe('cross-chain swap lifecycle', () => {
  let source: FakeChain;
  let stellar: FakeChain;
  let repository: FakeRepository;
  let broadcaster: FakeBroadcaster;
  let locks: FakeLocks;
  let coordinator: CrossChainSwapService;
  let listener: ChainListenerService;
  let refunds: RefundService;

  const initiate = () =>
    coordinator.initiate({
      source_chain: SwapChain.ETHEREUM,
      source_address: '0xcustomer',
      target_address: 'GMERCHANT',
      amount: '1',
      source_asset: 'ETH',
    });

  const row = () => repository.rows[0];

  beforeEach(() => {
    process.env.SWAP_SECRET_ENCRYPTION_KEY = 'a'.repeat(64);

    source = new FakeChain(SwapChain.ETHEREUM, INITIAL_EVM_TIME);
    stellar = new FakeChain(SwapChain.STELLAR, INITIAL_LEDGER);

    const chainMap = new Map([
      [SwapChain.ETHEREUM, source],
      [SwapChain.STELLAR, stellar],
    ]);
    const chains = {
      get: (chain: SwapChain) => chainMap.get(chain),
      isConfigured: () => true,
      configuredChains: () => [...chainMap.keys()],
    };

    repository = new FakeRepository();
    broadcaster = new FakeBroadcaster(chainMap);
    locks = new FakeLocks();

    coordinator = new CrossChainSwapService(
      repository as any,
      chains as any,
      new SecretManagerService(),
      { shouldDefer: async () => false } as any,
      { recordBlockchainTx: jest.fn() } as any,
      broadcaster,
    );

    listener = new ChainListenerService(coordinator, chains as any, locks as any);
    refunds = new RefundService(repository as any, chains as any, locks as any, broadcaster);
  });

  afterEach(() => {
    delete process.env.SWAP_SECRET_ENCRYPTION_KEY;
  });

  it('settles a funded swap end to end, ending with the merchant paid', async () => {
    const { swap } = await initiate();
    expect(row().status).toEqual(SwapStatus.PENDING);

    // The customer funds their leg, but it is not confirmed yet.
    source.lock(row());
    await listener.monitorSwaps();
    expect(row().status).toEqual(SwapStatus.PENDING);

    // Enough blocks pass to clear Ethereum's reorg depth.
    source.reference += 12 * CHAIN_METADATA[SwapChain.ETHEREUM].averageBlockTimeSeconds;
    await listener.monitorSwaps();
    expect(row().status).toEqual(SwapStatus.SOURCE_LOCKED);

    // Lumina funds the merchant's Stellar leg.
    await listener.monitorSwaps();
    expect(row().status).toEqual(SwapStatus.TARGET_LOCKED);
    expect(stellar.htlcs.get(swap.swap_id).status).toEqual(OnChainHtlcStatus.LOCKED);

    // The Stellar claim publishes the secret.
    await listener.monitorSwaps();
    expect(row().status).toEqual(SwapStatus.TARGET_CLAIMED);

    // Lumina claims the source leg with the same secret.
    await listener.monitorSwaps();
    expect(row().status).toEqual(SwapStatus.COMPLETED);

    expect(source.htlcs.get(swap.swap_id).status).toEqual(OnChainHtlcStatus.CLAIMED);
    expect(stellar.htlcs.get(swap.swap_id).status).toEqual(OnChainHtlcStatus.CLAIMED);
  });

  it('settles both legs with the same preimage, which is what makes it atomic', async () => {
    const { swap } = await initiate();
    source.lock(row());
    source.reference += 12 * 12;

    for (let i = 0; i < 4; i++) {
      await listener.monitorSwaps();
    }

    const sourcePreimage = source.htlcs.get(swap.swap_id).preimage;
    const stellarPreimage = stellar.htlcs.get(swap.swap_id).preimage;

    expect(sourcePreimage).toEqual(stellarPreimage);
    expect(createHash('sha256').update(Buffer.from(sourcePreimage, 'hex')).digest('hex')).toEqual(
      swap.secret_hash,
    );
  });

  it('never lets the merchant leg outlive the customer leg', async () => {
    const { swap } = await initiate();

    // The Stellar timelock has to expire first, or the customer could refund
    // while Lumina's payout is still claimable.
    const stellarSecondsLeft =
      (Number(swap.target_timeout_block) - INITIAL_LEDGER) *
      CHAIN_METADATA[SwapChain.STELLAR].averageBlockTimeSeconds;
    const sourceSecondsLeft = Number(swap.timeout_block) - INITIAL_EVM_TIME;

    expect(stellarSecondsLeft).toBeLessThan(sourceSecondsLeft);
  });

  it('expires a swap the customer never funded', async () => {
    await initiate();

    source.reference = Number(row().timeout_block) + 1;
    await listener.monitorSwaps();

    expect(row().status).toEqual(SwapStatus.EXPIRED);
    expect(broadcaster.calls).toHaveLength(0);
  });

  it('refuses a lock whose hashlock is not the one the swap agreed to', async () => {
    await initiate();

    source.lock(row(), { secretHash: 'ff'.repeat(32) });
    source.reference += 12 * 12;
    await listener.monitorSwaps();

    expect(row().status).toEqual(SwapStatus.PENDING);
    expect(row().error_message).toMatch(/hashlock/i);
    // Nothing was paid out against a lock Lumina cannot claim.
    expect(broadcaster.calls).toHaveLength(0);
  });

  it('refunds both legs when the swap times out mid-flight', async () => {
    const { swap } = await initiate();

    source.lock(row());
    source.reference += 12 * 12;
    await listener.monitorSwaps(); // SOURCE_LOCKED
    await listener.monitorSwaps(); // TARGET_LOCKED

    // Both timelocks lapse before the Stellar claim goes out.
    stellar.reference = Number(row().target_timeout_block) + 1;
    source.reference = Number(row().timeout_block) + 1;

    await listener.monitorSwaps();
    expect(row().status).toEqual(SwapStatus.REFUND_PENDING);

    // Stellar's leg is Lumina's to refund; the source leg is the customer's.
    await refunds.processRefunds();
    expect(stellar.htlcs.get(swap.swap_id).status).toEqual(OnChainHtlcStatus.REFUNDED);
    expect(row().status).toEqual(SwapStatus.REFUND_PENDING);

    source.refund(swap.swap_id);
    // The worker backed off after finding the source leg still outstanding;
    // fast-forward past that backoff rather than waiting out the timer.
    row().next_retry_at = null;
    await refunds.processRefunds();

    expect(row().status).toEqual(SwapStatus.REFUNDED);
  });

  it('honours a customer refund request only after the timelock', async () => {
    const { swap } = await initiate();
    source.lock(row());
    source.reference += 12 * 12;
    await listener.monitorSwaps();

    await expect(coordinator.requestRefund(swap.swap_id)).rejects.toThrow(/timelock/);

    source.reference = Number(row().timeout_block);
    await expect(coordinator.requestRefund(swap.swap_id)).resolves.toMatchObject({
      status: SwapStatus.REFUND_PENDING,
    });
  });

  it('refuses to refund once the secret has been published', async () => {
    const { swap } = await initiate();
    source.lock(row());
    source.reference += 12 * 12;

    await listener.monitorSwaps(); // SOURCE_LOCKED
    await listener.monitorSwaps(); // TARGET_LOCKED
    await listener.monitorSwaps(); // TARGET_CLAIMED

    source.reference = Number(row().timeout_block);

    await expect(coordinator.requestRefund(swap.swap_id)).rejects.toThrow(/cannot be refunded/);
  });

  it('lets two listeners run concurrently without double-broadcasting', async () => {
    await initiate();
    source.lock(row());
    source.reference += 12 * 12;
    await listener.monitorSwaps(); // SOURCE_LOCKED

    const second = new ChainListenerService(coordinator, { isConfigured: () => true } as any, locks as any);

    await Promise.all([listener.monitorSwaps(), second.monitorSwaps()]);

    expect(broadcaster.calls.filter((call) => call.data === 'lock')).toHaveLength(1);
    expect(row().status).toEqual(SwapStatus.TARGET_LOCKED);
  });

  it('keeps the secret out of everything the API returns', async () => {
    const { swap } = await initiate();

    expect(swap).not.toHaveProperty('encrypted_secret');
    await expect(coordinator.findBySwapId(swap.swap_id)).resolves.not.toHaveProperty(
      'encrypted_secret',
    );
    expect(row().encrypted_secret).toBeTruthy();
  });
});
