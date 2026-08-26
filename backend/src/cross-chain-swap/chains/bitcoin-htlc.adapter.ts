import { Injectable } from '@nestjs/common';
import { CrossChainSwap } from '../entities/cross-chain-swap.entity';
import { SwapChain } from './chain.enum';
import {
  HtlcChainAdapter,
  HtlcLockRequest,
  OnChainHtlcState,
  OnChainHtlcStatus,
  UnsignedChainCall,
} from './htlc-chain.adapter';
import { RestClient } from './rest.client';
import { toSmallestUnit } from './amount.util';
import { BitcoinNetwork, buildHtlcScript, HtlcScript } from './bitcoin-htlc.script';

interface EsploraVout {
  scriptpubkey: string;
  scriptpubkey_address?: string;
  value: number;
}

interface EsploraVin {
  prevout: EsploraVout | null;
  witness?: string[];
  scriptsig?: string;
}

interface EsploraTx {
  txid: string;
  vin: EsploraVin[];
  vout: EsploraVout[];
  status: { confirmed: boolean; block_height?: number };
}

/**
 * Adapter for the Bitcoin leg.
 *
 * Bitcoin has nothing to deploy — the HTLC is the redeem script built by
 * `bitcoin-htlc.script.ts`, and its address is derived from the script itself.
 * Chain state is read from an Esplora-compatible explorer (Blockstream's public
 * instance by default), which is the same interface `bitcoinjs-lib` users reach
 * for and needs no extra dependency.
 */
@Injectable()
export class BitcoinHtlcAdapter implements HtlcChainAdapter {
  readonly chain = SwapChain.BITCOIN;

  constructor(private readonly rest: RestClient) {}

  isConfigured(): boolean {
    return Boolean(process.env.BITCOIN_SWAP_RECIPIENT_PUBKEY);
  }

  /** Bitcoin timelocks are block heights, matching OP_CHECKLOCKTIMEVERIFY. */
  async getTimeoutReference(): Promise<number> {
    return Number(await this.rest.getText(this.chain, 'tip_height', `${this.apiUrl()}/blocks/tip/height`));
  }

  async getHtlcState(swap: CrossChainSwap): Promise<OnChainHtlcState | null> {
    const script = this.scriptFor(swap);
    const address = script.p2wshAddress;

    const [tipHeight, transactions] = await Promise.all([
      this.getTimeoutReference(),
      this.rest.getJson<EsploraTx[]>(this.chain, 'address_txs', `${this.apiUrl()}/address/${address}/txs`),
    ]);

    const funding = transactions.find((tx) =>
      tx.vout.some((vout) => vout.scriptpubkey === script.p2wshScriptPubKey),
    );

    if (!funding) {
      return null;
    }

    const lockedValue = funding.vout
      .filter((vout) => vout.scriptpubkey === script.p2wshScriptPubKey)
      .reduce((total, vout) => total + vout.value, 0);

    const spend = transactions.find((tx) =>
      tx.vin.some((vin) => vin.prevout?.scriptpubkey === script.p2wshScriptPubKey),
    );

    const revealed = spend ? this.readPreimage(spend, script) : null;

    return {
      status: this.statusOf(spend, revealed),
      amount: String(lockedValue),
      secretHash: swap.secret_hash,
      timeout: swap.timeout_block,
      confirmations: this.confirmationsOf(funding, tipHeight),
      preimage: revealed,
      txHash: funding.txid,
    };
  }

  buildLockRequest(swap: CrossChainSwap): HtlcLockRequest {
    const script = this.scriptFor(swap);

    return {
      chain: this.chain,
      htlcAddress: script.p2wshAddress,
      amount: toSmallestUnit(swap.amount, this.chain).toString(),
      secretHash: swap.secret_hash,
      timeout: swap.timeout_block,
      payload: script.script,
      metadata: {
        // Legacy wallets that cannot pay a bech32 address can pay the P2SH form
        // of the same script instead.
        p2shAddress: script.p2shAddress,
        p2wshAddress: script.p2wshAddress,
        redeemScript: script.script,
        network: this.network(),
      },
    };
  }

  /**
   * Bitcoin has no "call" to make — a claim is a spend of the `OP_IF` branch.
   * The returned payload is everything a signer needs to build that spend.
   */
  buildClaimCall(swap: CrossChainSwap, secretHex: string): UnsignedChainCall {
    const script = this.scriptFor(swap);

    return {
      chain: this.chain,
      to: script.p2wshAddress,
      data: script.script,
      value: toSmallestUnit(swap.amount, this.chain).toString(),
      metadata: {
        branch: 'claim',
        preimage: secretHex,
        // Witness for the claim branch, innermost first: <sig> <preimage> <1> <script>
        witnessTemplate: `<signature> ${secretHex} 01 ${script.script}`,
      },
    };
  }

  buildRefundCall(swap: CrossChainSwap): UnsignedChainCall {
    const script = this.scriptFor(swap);

    return {
      chain: this.chain,
      to: script.p2wshAddress,
      data: script.script,
      value: toSmallestUnit(swap.amount, this.chain).toString(),
      metadata: {
        branch: 'refund',
        // The refund spend must set nLockTime to the HTLC's locktime and a
        // non-final nSequence, or OP_CHECKLOCKTIMEVERIFY rejects it.
        nLockTime: swap.timeout_block,
        nSequence: '0xfffffffe',
        witnessTemplate: `<signature> 00 ${script.script}`,
      },
    };
  }

  /** Fee rate in sat/vB from the explorer's estimates, for the gas oracle. */
  async getFeeRate(targetBlocks = 3): Promise<number> {
    const estimates = await this.rest.getJson<Record<string, number>>(
      this.chain,
      'fee_estimates',
      `${this.apiUrl()}/fee-estimates`,
    );

    return estimates[String(targetBlocks)] ?? estimates['6'] ?? 1;
  }

  /** The redeem script for a swap, derived from its own locking parameters. */
  scriptFor(swap: CrossChainSwap): HtlcScript {
    return buildHtlcScript({
      secretHash: swap.secret_hash,
      recipientPubKey: this.requireEnv('BITCOIN_SWAP_RECIPIENT_PUBKEY'),
      // The customer supplies the pubkey their refund pays back to.
      senderPubKey: swap.source_address,
      locktime: Number(swap.timeout_block),
      network: this.network() as BitcoinNetwork,
    });
  }

  /**
   * A spend through the `OP_IF` branch carries the preimage in its witness:
   * `<signature> <preimage> <1> <script>`. The refund branch pushes an empty
   * value instead of the preimage, so the two are told apart by that push.
   */
  private readPreimage(spend: EsploraTx, script: HtlcScript): string | null {
    const input = spend.vin.find((vin) => vin.prevout?.scriptpubkey === script.p2wshScriptPubKey);
    const witness = input?.witness ?? [];

    if (witness.length < 4 || witness[witness.length - 1] !== script.script) {
      return null;
    }

    const branchSelector = witness[witness.length - 2];
    const preimage = witness[witness.length - 3];

    return branchSelector === '01' && preimage.length === 64 ? preimage : null;
  }

  private statusOf(spend: EsploraTx | undefined, preimage: string | null): OnChainHtlcStatus {
    if (!spend) {
      return OnChainHtlcStatus.LOCKED;
    }

    return preimage ? OnChainHtlcStatus.CLAIMED : OnChainHtlcStatus.REFUNDED;
  }

  private confirmationsOf(tx: EsploraTx, tipHeight: number): number {
    if (!tx.status.confirmed || tx.status.block_height === undefined) {
      return 0;
    }

    return Math.max(0, tipHeight - tx.status.block_height + 1);
  }

  private network(): string {
    return process.env.BITCOIN_NETWORK || BitcoinNetwork.TESTNET;
  }

  private apiUrl(): string {
    if (process.env.BITCOIN_API_URL) {
      return process.env.BITCOIN_API_URL.replace(/\/$/, '');
    }

    return this.network() === BitcoinNetwork.MAINNET
      ? 'https://blockstream.info/api'
      : 'https://blockstream.info/testnet/api';
  }

  private requireEnv(key: string): string {
    const value = process.env[key];

    if (!value) {
      throw new Error(`Bitcoin swaps are not configured; set ${key}`);
    }

    return value;
  }
}
