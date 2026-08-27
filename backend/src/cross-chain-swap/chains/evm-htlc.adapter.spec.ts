import { EthereumHtlcAdapter, PolygonHtlcAdapter } from './evm-htlc.adapter';
import { JsonRpcClient } from './json-rpc.client';
import { encodeWord } from './abi.util';
import { CrossChainSwap, SwapStatus } from '../entities/cross-chain-swap.entity';
import { SwapChain } from './chain.enum';

const HTLC_ADDRESS = '0x2222222222222222222222222222222222222222';
const RECIPIENT = '0x3333333333333333333333333333333333333333';
const TOKEN = '0x4444444444444444444444444444444444444444';
const SWAP_ID = '11'.repeat(32);
const SECRET_HASH = 'aa'.repeat(32);
const SECRET = 'bb'.repeat(32);

/** ABI-encodes a `LuminaHTLC.Swap` struct as `getSwap` returns it. */
function encodeSwapStruct(overrides: { amount?: bigint; status?: number; timeout?: bigint } = {}) {
  return [
    '0x',
    encodeWord('0x1111111111111111111111111111111111111111'), // sender
    encodeWord(RECIPIENT),
    encodeWord('0x0'), // token: native
    encodeWord(overrides.amount ?? 10n ** 18n),
    encodeWord(`0x${SECRET_HASH}`),
    encodeWord(overrides.timeout ?? 1_700_000_000n),
    encodeWord(overrides.status ?? 1), // Locked
  ].join('');
}

function makeSwap(overrides: Partial<CrossChainSwap> = {}): CrossChainSwap {
  return {
    swap_id: SWAP_ID,
    source_chain: SwapChain.ETHEREUM,
    amount: '1',
    secret_hash: SECRET_HASH,
    timeout_block: '1700000000',
    status: SwapStatus.PENDING,
    source_lock_tx: null,
    ...overrides,
  } as CrossChainSwap;
}

describe('EvmHtlcAdapter', () => {
  let rpc: { call: jest.Mock };
  let adapter: EthereumHtlcAdapter;

  beforeEach(() => {
    process.env.ETHEREUM_RPC_URL = 'https://rpc.example';
    process.env.ETHEREUM_HTLC_ADDRESS = HTLC_ADDRESS;
    process.env.ETHEREUM_SWAP_RECIPIENT = RECIPIENT;
    delete process.env.ETHEREUM_SWAP_TOKEN;

    rpc = { call: jest.fn() };
    adapter = new EthereumHtlcAdapter(rpc as unknown as JsonRpcClient);
  });

  afterEach(() => {
    delete process.env.ETHEREUM_RPC_URL;
    delete process.env.ETHEREUM_HTLC_ADDRESS;
    delete process.env.ETHEREUM_SWAP_RECIPIENT;
    delete process.env.ETHEREUM_SWAP_TOKEN;
  });

  describe('isConfigured', () => {
    it('is true once the RPC, contract, and recipient are set', () => {
      expect(adapter.isConfigured()).toBe(true);
    });

    it('is false when any of them is missing', () => {
      delete process.env.ETHEREUM_HTLC_ADDRESS;

      expect(adapter.isConfigured()).toBe(false);
    });

    it('reads its own chain env vars, not another chain\'s', () => {
      const polygon = new PolygonHtlcAdapter(rpc as unknown as JsonRpcClient);

      expect(polygon.isConfigured()).toBe(false);
    });
  });

  describe('getTimeoutReference', () => {
    it('returns the latest block timestamp, since EVM timelocks are timestamps', async () => {
      rpc.call.mockResolvedValue({ timestamp: '0x65500000' });

      await expect(adapter.getTimeoutReference()).resolves.toEqual(0x65500000);
    });
  });

  describe('getHtlcState', () => {
    it('returns null when the contract has no such swap', async () => {
      rpc.call.mockResolvedValue(encodeSwapStruct({ status: 0 }));

      await expect(adapter.getHtlcState(makeSwap())).resolves.toBeNull();
    });

    it('reports a locked swap with zero confirmations before its tx is mined', async () => {
      rpc.call.mockImplementation(async (_chain, _url, method) => {
        if (method === 'eth_call') return encodeSwapStruct();
        if (method === 'eth_blockNumber') return '0x64';
        return null;
      });

      const state = await adapter.getHtlcState(makeSwap());

      expect(state).toMatchObject({
        status: 'locked',
        amount: (10n ** 18n).toString(),
        secretHash: SECRET_HASH,
        timeout: '1700000000',
        confirmations: 0,
        preimage: null,
      });
    });

    it('counts confirmations from the block the lock landed in', async () => {
      rpc.call.mockImplementation(async (_chain, _url, method) => {
        if (method === 'eth_call') return encodeSwapStruct();
        if (method === 'eth_blockNumber') return '0x64'; // 100
        if (method === 'eth_getTransactionReceipt') return { blockNumber: '0x5b', status: '0x1' }; // 91
        return null;
      });

      const state = await adapter.getHtlcState(makeSwap({ source_lock_tx: '0xdead' }));

      expect(state.confirmations).toEqual(10);
    });

    it('treats a reverted lock transaction as unmined', async () => {
      rpc.call.mockImplementation(async (_chain, _url, method) => {
        if (method === 'eth_call') return encodeSwapStruct();
        if (method === 'eth_blockNumber') return '0x64';
        if (method === 'eth_getTransactionReceipt') return { blockNumber: '0x5b', status: '0x0' };
        return null;
      });

      const state = await adapter.getHtlcState(makeSwap({ source_lock_tx: '0xdead' }));

      expect(state.confirmations).toEqual(0);
    });

    it('reads the revealed preimage once the swap is claimed', async () => {
      rpc.call.mockImplementation(async (_chain, _url, method, params: any[]) => {
        if (method === 'eth_call') {
          return params[0].data.startsWith('0x0f622b04')
            ? `0x${SECRET}`
            : encodeSwapStruct({ status: 2 });
        }
        if (method === 'eth_blockNumber') return '0x64';
        return null;
      });

      const state = await adapter.getHtlcState(makeSwap());

      expect(state.status).toEqual('claimed');
      expect(state.preimage).toEqual(SECRET);
    });

    it('reports no preimage when a refunded swap left the slot zeroed', async () => {
      rpc.call.mockImplementation(async (_chain, _url, method, params: any[]) => {
        if (method === 'eth_call') {
          return params[0].data.startsWith('0x0f622b04')
            ? `0x${'00'.repeat(32)}`
            : encodeSwapStruct({ status: 3 });
        }
        if (method === 'eth_blockNumber') return '0x64';
        return null;
      });

      const state = await adapter.getHtlcState(makeSwap());

      expect(state.status).toEqual('refunded');
      expect(state.preimage).toBeNull();
    });
  });

  describe('buildLockRequest', () => {
    it('builds a native lock carrying the amount as msg.value', () => {
      const request = adapter.buildLockRequest(makeSwap());

      expect(request.htlcAddress).toEqual(HTLC_ADDRESS);
      expect(request.amount).toEqual((10n ** 18n).toString());
      expect(request.payload.startsWith('0x170b2ab0')).toBe(true);
      expect(request.metadata.valueWei).toEqual((10n ** 18n).toString());
    });

    it('builds an ERC-20 lock with no value once a token is configured', () => {
      process.env.ETHEREUM_SWAP_TOKEN = TOKEN;

      const request = adapter.buildLockRequest(makeSwap());

      expect(request.payload.startsWith('0xc0ef049c')).toBe(true);
      expect(request.payload).toContain(TOKEN.slice(2).toLowerCase());
      expect(request.metadata.valueWei).toEqual('0');
    });
  });

  describe('buildClaimCall / buildRefundCall', () => {
    it('encodes claim(swapId, preimage)', () => {
      const call = adapter.buildClaimCall(makeSwap(), SECRET);

      expect(call.to).toEqual(HTLC_ADDRESS);
      expect(call.data).toEqual(`0x84cc9dfb${SWAP_ID}${SECRET}`);
      expect(call.value).toEqual('0');
    });

    it('encodes refund(swapId)', () => {
      expect(adapter.buildRefundCall(makeSwap()).data).toEqual(`0x7249fbb6${SWAP_ID}`);
    });
  });

  describe('getGasPrice', () => {
    it('returns eth_gasPrice as a bigint', async () => {
      rpc.call.mockResolvedValue('0x3b9aca00');

      await expect(adapter.getGasPrice()).resolves.toEqual(1_000_000_000n);
    });
  });

  it('refuses to build anything when the chain is unconfigured', () => {
    delete process.env.ETHEREUM_HTLC_ADDRESS;

    expect(() => adapter.buildRefundCall(makeSwap())).toThrow(/not configured/);
  });
});
