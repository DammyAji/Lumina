import { BitcoinHtlcAdapter } from './bitcoin-htlc.adapter';
import { RestClient } from './rest.client';
import { CrossChainSwap, SwapStatus } from '../entities/cross-chain-swap.entity';
import { SwapChain } from './chain.enum';

const RECIPIENT_PUBKEY = `02${'ab'.repeat(32)}`;
const SENDER_PUBKEY = `03${'cd'.repeat(32)}`;
const SECRET_HASH = 'aa'.repeat(32);
const SECRET = 'bb'.repeat(32);

function makeSwap(overrides: Partial<CrossChainSwap> = {}): CrossChainSwap {
  return {
    swap_id: '11'.repeat(32),
    source_chain: SwapChain.BITCOIN,
    source_address: SENDER_PUBKEY,
    amount: '0.5',
    secret_hash: SECRET_HASH,
    timeout_block: '800144',
    status: SwapStatus.PENDING,
    ...overrides,
  } as CrossChainSwap;
}

describe('BitcoinHtlcAdapter', () => {
  let rest: { getJson: jest.Mock; getText: jest.Mock };
  let adapter: BitcoinHtlcAdapter;
  let scriptPubKey: string;

  beforeEach(() => {
    process.env.BITCOIN_SWAP_RECIPIENT_PUBKEY = RECIPIENT_PUBKEY;
    process.env.BITCOIN_NETWORK = 'testnet';
    delete process.env.BITCOIN_API_URL;

    rest = { getJson: jest.fn(), getText: jest.fn() };
    adapter = new BitcoinHtlcAdapter(rest as unknown as RestClient);
    scriptPubKey = adapter.scriptFor(makeSwap()).p2wshScriptPubKey;
  });

  afterEach(() => {
    delete process.env.BITCOIN_SWAP_RECIPIENT_PUBKEY;
    delete process.env.BITCOIN_NETWORK;
  });

  const script = () => adapter.scriptFor(makeSwap());

  function fundingTx(blockHeight: number | null = 800_000) {
    return {
      txid: 'funding-tx',
      vin: [],
      vout: [{ scriptpubkey: scriptPubKey, value: 50_000_000 }],
      status:
        blockHeight === null
          ? { confirmed: false }
          : { confirmed: true, block_height: blockHeight },
    };
  }

  function spendTx(witness: string[]) {
    return {
      txid: 'spend-tx',
      vin: [{ prevout: { scriptpubkey: scriptPubKey, value: 50_000_000 }, witness }],
      vout: [],
      status: { confirmed: true, block_height: 800_010 },
    };
  }

  describe('isConfigured', () => {
    it('needs only the recipient pubkey, since there is no contract to deploy', () => {
      expect(adapter.isConfigured()).toBe(true);

      delete process.env.BITCOIN_SWAP_RECIPIENT_PUBKEY;
      expect(adapter.isConfigured()).toBe(false);
    });
  });

  describe('getTimeoutReference', () => {
    it('returns the tip height, since Bitcoin timelocks are heights', async () => {
      rest.getText.mockResolvedValue('800123');

      await expect(adapter.getTimeoutReference()).resolves.toEqual(800123);
    });
  });

  describe('getHtlcState', () => {
    beforeEach(() => {
      rest.getText.mockResolvedValue('800005');
    });

    it('returns null while nothing has paid the script address', async () => {
      rest.getJson.mockResolvedValue([]);

      await expect(adapter.getHtlcState(makeSwap())).resolves.toBeNull();
    });

    it('reports a funded, unspent script as locked with its confirmations', async () => {
      rest.getJson.mockResolvedValue([fundingTx(800_000)]);

      const state = await adapter.getHtlcState(makeSwap());

      expect(state).toMatchObject({
        status: 'locked',
        amount: '50000000',
        confirmations: 6,
        preimage: null,
        txHash: 'funding-tx',
      });
    });

    it('reports zero confirmations for an unconfirmed funding transaction', async () => {
      rest.getJson.mockResolvedValue([fundingTx(null)]);

      const state = await adapter.getHtlcState(makeSwap());

      expect(state.confirmations).toEqual(0);
    });

    it('extracts the preimage from a claim spend of the OP_IF branch', async () => {
      rest.getJson.mockResolvedValue([
        fundingTx(),
        spendTx(['30440220signature', SECRET, '01', script().script]),
      ]);

      const state = await adapter.getHtlcState(makeSwap());

      expect(state.status).toEqual('claimed');
      expect(state.preimage).toEqual(SECRET);
    });

    it('reads a refund spend of the OP_ELSE branch as refunded, with no preimage', async () => {
      rest.getJson.mockResolvedValue([
        fundingTx(),
        spendTx(['30440220signature', '', script().script]),
      ]);

      const state = await adapter.getHtlcState(makeSwap());

      expect(state.status).toEqual('refunded');
      expect(state.preimage).toBeNull();
    });

    it('ignores a witness whose final push is not this HTLC script', async () => {
      rest.getJson.mockResolvedValue([
        fundingTx(),
        spendTx(['30440220signature', SECRET, '01', 'deadbeef']),
      ]);

      const state = await adapter.getHtlcState(makeSwap());

      expect(state.status).toEqual('refunded');
      expect(state.preimage).toBeNull();
    });

    it('sums every output paying the script address', async () => {
      rest.getJson.mockResolvedValue([
        {
          ...fundingTx(),
          vout: [
            { scriptpubkey: scriptPubKey, value: 30_000_000 },
            { scriptpubkey: scriptPubKey, value: 20_000_000 },
            { scriptpubkey: 'other', value: 99 },
          ],
        },
      ]);

      const state = await adapter.getHtlcState(makeSwap());

      expect(state.amount).toEqual('50000000');
    });
  });

  describe('buildLockRequest', () => {
    it('offers both the SegWit and legacy forms of the same script', () => {
      const request = adapter.buildLockRequest(makeSwap());

      expect(request.htlcAddress).toEqual(script().p2wshAddress);
      expect(request.metadata.p2shAddress).toEqual(script().p2shAddress);
      expect(request.metadata.redeemScript).toEqual(script().script);
      expect(request.amount).toEqual('50000000');
    });
  });

  describe('buildRefundCall', () => {
    it('carries the nLockTime and nSequence the refund branch requires', () => {
      const call = adapter.buildRefundCall(makeSwap());

      expect(call.metadata.branch).toEqual('refund');
      expect(call.metadata.nLockTime).toEqual('800144');
      // A final nSequence disables nLockTime, which would break CLTV.
      expect(call.metadata.nSequence).toEqual('0xfffffffe');
    });
  });

  describe('buildClaimCall', () => {
    it('carries the preimage and the claim-branch witness', () => {
      const call = adapter.buildClaimCall(makeSwap(), SECRET);

      expect(call.metadata.branch).toEqual('claim');
      expect(call.metadata.preimage).toEqual(SECRET);
      expect(call.metadata.witnessTemplate).toContain(SECRET);
    });
  });

  describe('getFeeRate', () => {
    it('prefers the requested confirmation target', async () => {
      rest.getJson.mockResolvedValue({ '3': 12.5, '6': 4 });

      await expect(adapter.getFeeRate(3)).resolves.toEqual(12.5);
    });

    it('falls back when the explorer has no estimate for that target', async () => {
      rest.getJson.mockResolvedValue({ '6': 4 });

      await expect(adapter.getFeeRate(3)).resolves.toEqual(4);
    });

    it('falls back to the minimum relay rate when nothing is quoted', async () => {
      rest.getJson.mockResolvedValue({});

      await expect(adapter.getFeeRate(3)).resolves.toEqual(1);
    });
  });

  it('refuses to derive a script when the recipient pubkey is unset', () => {
    delete process.env.BITCOIN_SWAP_RECIPIENT_PUBKEY;

    expect(() => adapter.scriptFor(makeSwap())).toThrow(/not configured/);
  });
});
