import { SolanaHtlcAdapter } from './solana-htlc.adapter';
import { JsonRpcClient } from './json-rpc.client';
import { base58Decode } from './solana-pda.util';
import { CrossChainSwap, SwapStatus } from '../entities/cross-chain-swap.entity';
import { SwapChain } from './chain.enum';

const PROGRAM_ID = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const RECIPIENT = '11111111111111111111111111111112';
const SWAP_ID = '11'.repeat(32);
const SECRET_HASH = 'aa'.repeat(32);
const SECRET = 'bb'.repeat(32);
const ACCOUNT_LEN = 209;

function makeSwap(overrides: Partial<CrossChainSwap> = {}): CrossChainSwap {
  return {
    swap_id: SWAP_ID,
    source_chain: SwapChain.SOLANA,
    amount: '1.5',
    secret_hash: SECRET_HASH,
    timeout_block: '1700000000',
    status: SwapStatus.PENDING,
    source_lock_tx: null,
    ...overrides,
  } as CrossChainSwap;
}

/** Packs an `HtlcSwap` exactly as the on-chain program's `state.rs` writes it. */
function encodeAccount(options: { status: number; preimage?: string; amount?: bigint } = { status: 1 }) {
  const data = Buffer.alloc(ACCOUNT_LEN);
  Buffer.from(SWAP_ID, 'hex').copy(data, 0);
  data.writeBigUInt64LE(options.amount ?? 1_500_000_000n, 128);
  Buffer.from(SECRET_HASH, 'hex').copy(data, 136);
  data.writeBigInt64LE(1_700_000_000n, 168);
  data.writeUInt8(options.status, 176);

  if (options.preimage) {
    Buffer.from(options.preimage, 'hex').copy(data, 177);
  }

  return data.toString('base64');
}

describe('SolanaHtlcAdapter', () => {
  let rpc: { call: jest.Mock };
  let adapter: SolanaHtlcAdapter;

  beforeEach(() => {
    process.env.SOLANA_RPC_URL = 'https://rpc.example';
    process.env.SOLANA_HTLC_PROGRAM_ID = PROGRAM_ID;
    process.env.SOLANA_SWAP_RECIPIENT = RECIPIENT;

    rpc = { call: jest.fn() };
    adapter = new SolanaHtlcAdapter(rpc as unknown as JsonRpcClient);
  });

  afterEach(() => {
    delete process.env.SOLANA_RPC_URL;
    delete process.env.SOLANA_HTLC_PROGRAM_ID;
    delete process.env.SOLANA_SWAP_RECIPIENT;
  });

  describe('isConfigured', () => {
    it('needs the RPC, program, and recipient', () => {
      expect(adapter.isConfigured()).toBe(true);

      delete process.env.SOLANA_SWAP_RECIPIENT;
      expect(adapter.isConfigured()).toBe(false);
    });
  });

  describe('getTimeoutReference', () => {
    it('returns the latest slot block time, since timelocks are unix seconds', async () => {
      rpc.call.mockImplementation(async (_chain, _url, method) =>
        method === 'getSlot' ? 250 : 1_700_000_500,
      );

      await expect(adapter.getTimeoutReference()).resolves.toEqual(1_700_000_500);
    });

    it('falls back to wall-clock time for a slot with no block time yet', async () => {
      rpc.call.mockImplementation(async (_chain, _url, method) =>
        method === 'getSlot' ? 250 : null,
      );

      const reference = await adapter.getTimeoutReference();

      expect(Math.abs(reference - Math.floor(Date.now() / 1000))).toBeLessThan(5);
    });
  });

  describe('getHtlcState', () => {
    it('returns null when the swap account does not exist', async () => {
      rpc.call.mockResolvedValue({ value: null, context: { slot: 1 } });

      await expect(adapter.getHtlcState(makeSwap())).resolves.toBeNull();
    });

    it('returns null for an account that was never initialised', async () => {
      rpc.call.mockResolvedValue({
        value: { data: [encodeAccount({ status: 0 }), 'base64'] },
        context: { slot: 1 },
      });

      await expect(adapter.getHtlcState(makeSwap())).resolves.toBeNull();
    });

    it('returns null for an account that is too small to hold a swap', async () => {
      rpc.call.mockResolvedValue({
        value: { data: [Buffer.alloc(10).toString('base64'), 'base64'] },
        context: { slot: 1 },
      });

      await expect(adapter.getHtlcState(makeSwap())).resolves.toBeNull();
    });

    it('decodes a locked swap using the program\'s fixed layout', async () => {
      rpc.call.mockResolvedValue({
        value: { data: [encodeAccount({ status: 1 }), 'base64'] },
        context: { slot: 1 },
      });

      const state = await adapter.getHtlcState(makeSwap());

      expect(state).toMatchObject({
        status: 'locked',
        amount: '1500000000',
        secretHash: SECRET_HASH,
        timeout: '1700000000',
        preimage: null,
      });
    });

    it('decodes the revealed preimage from a claimed swap', async () => {
      rpc.call.mockResolvedValue({
        value: { data: [encodeAccount({ status: 2, preimage: SECRET }), 'base64'] },
        context: { slot: 1 },
      });

      const state = await adapter.getHtlcState(makeSwap());

      expect(state.status).toEqual('claimed');
      expect(state.preimage).toEqual(SECRET);
    });

    it('reads a zeroed preimage slot as no preimage', async () => {
      rpc.call.mockResolvedValue({
        value: { data: [encodeAccount({ status: 3 }), 'base64'] },
        context: { slot: 1 },
      });

      const state = await adapter.getHtlcState(makeSwap());

      expect(state.status).toEqual('refunded');
      expect(state.preimage).toBeNull();
    });
  });

  describe('buildLockRequest', () => {
    it('packs the Lock instruction the program unpacks', () => {
      const request = adapter.buildLockRequest(makeSwap());
      const data = Buffer.from(request.payload, 'base64');

      expect(data.readUInt8(0)).toEqual(0); // Lock tag
      expect(data.subarray(1, 33).toString('hex')).toEqual(SWAP_ID);
      expect(data.subarray(33, 65)).toEqual(Buffer.from(base58Decode(RECIPIENT)));
      expect(data.readBigUInt64LE(65)).toEqual(1_500_000_000n);
      expect(data.subarray(73, 105).toString('hex')).toEqual(SECRET_HASH);
      expect(data.readBigInt64LE(105)).toEqual(1_700_000_000n);
      expect(data.length).toEqual(113);
    });

    it('names the PDA that will hold the escrow', () => {
      const request = adapter.buildLockRequest(makeSwap());

      expect(request.metadata.swapAccount).toEqual(adapter.swapAccount(makeSwap()).address);
      expect(request.metadata.programId).toEqual(PROGRAM_ID);
    });
  });

  describe('buildClaimCall / buildRefundCall', () => {
    it('packs Claim with the preimage', () => {
      const data = Buffer.from(adapter.buildClaimCall(makeSwap(), SECRET).data, 'base64');

      expect(data.readUInt8(0)).toEqual(1);
      expect(data.subarray(1).toString('hex')).toEqual(SECRET);
    });

    it('packs Refund as a bare tag', () => {
      const data = Buffer.from(adapter.buildRefundCall(makeSwap()).data, 'base64');

      expect(Array.from(data)).toEqual([2]);
    });
  });

  describe('getPriorityFee', () => {
    it('takes the median so one hot account cannot skew the quote', async () => {
      rpc.call.mockResolvedValue([
        { prioritizationFee: 1 },
        { prioritizationFee: 5 },
        { prioritizationFee: 100_000 },
      ]);

      await expect(adapter.getPriorityFee()).resolves.toEqual(5n);
    });

    it('returns zero when the cluster reports no recent fees', async () => {
      rpc.call.mockResolvedValue([]);

      await expect(adapter.getPriorityFee()).resolves.toEqual(0n);
    });
  });

  it('refuses to build anything when the program id is unset', () => {
    delete process.env.SOLANA_HTLC_PROGRAM_ID;

    expect(() => adapter.buildRefundCall(makeSwap())).toThrow(/not configured/);
  });
});
