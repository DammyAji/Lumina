import { Injectable, Logger } from '@nestjs/common';
import { CrossChainSwap } from '../entities/cross-chain-swap.entity';
import { SwapChain } from './chain.enum';
import {
  HtlcChainAdapter,
  HtlcLockRequest,
  OnChainHtlcState,
  OnChainHtlcStatus,
  UnsignedChainCall,
} from './htlc-chain.adapter';
import { JsonRpcClient } from './json-rpc.client';
import { encodeAddress, encodeCall, readBytes32, readUint } from './abi.util';
import { toSmallestUnit } from './amount.util';

/**
 * `LuminaHTLC` selectors. See `smartcontracts/evm/src/LuminaHTLC.sol`; they are
 * verifiable with `cast sig "<signature>"`.
 */
const SELECTORS = {
  getSwap: '0x3da0e66e', // getSwap(bytes32)
  getPreimage: '0x0f622b04', // getPreimage(bytes32)
  claim: '0x84cc9dfb', // claim(bytes32,bytes32)
  refund: '0x7249fbb6', // refund(bytes32)
  lockNative: '0x170b2ab0', // lockNative(bytes32,address,bytes32,uint256)
  lockERC20: '0xc0ef049c', // lockERC20(bytes32,address,address,uint256,bytes32,uint256)
} as const;

/** `LuminaHTLC.Status`, in declaration order. */
const CONTRACT_STATUS = ['invalid', 'locked', 'claimed', 'refunded'] as const;

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const ZERO_BYTES32 = '0'.repeat(64);

interface EvmChainConfig {
  rpcUrl: string;
  htlcAddress: string;
  /** Address Lumina claims the source leg with. */
  recipientAddress: string;
  /** ERC-20 to escrow, or unset for the chain's native currency. */
  tokenAddress?: string;
}

const ENV_KEYS: Record<string, { rpc: string; htlc: string; recipient: string; token: string }> = {
  [SwapChain.ETHEREUM]: {
    rpc: 'ETHEREUM_RPC_URL',
    htlc: 'ETHEREUM_HTLC_ADDRESS',
    recipient: 'ETHEREUM_SWAP_RECIPIENT',
    token: 'ETHEREUM_SWAP_TOKEN',
  },
  [SwapChain.POLYGON]: {
    rpc: 'POLYGON_RPC_URL',
    htlc: 'POLYGON_HTLC_ADDRESS',
    recipient: 'POLYGON_SWAP_RECIPIENT',
    token: 'POLYGON_SWAP_TOKEN',
  },
};

/**
 * Adapter for the Ethereum and Polygon legs, both of which run the same
 * `LuminaHTLC` contract and speak the same JSON-RPC.
 *
 * Timeouts on these chains are unix timestamps, matching the contract's use of
 * `block.timestamp`.
 */
export abstract class EvmHtlcAdapter implements HtlcChainAdapter {
  protected readonly logger = new Logger(EvmHtlcAdapter.name);

  protected constructor(
    readonly chain: SwapChain,
    private readonly rpc: JsonRpcClient,
  ) {}

  isConfigured(): boolean {
    const keys = ENV_KEYS[this.chain];
    return Boolean(process.env[keys.rpc] && process.env[keys.htlc] && process.env[keys.recipient]);
  }

  async getTimeoutReference(): Promise<number> {
    const block = await this.rpc.call<{ timestamp: string }>(
      this.chain,
      this.config().rpcUrl,
      'eth_getBlockByNumber',
      ['latest', false],
    );

    return Number(BigInt(block.timestamp));
  }

  async getHtlcState(swap: CrossChainSwap): Promise<OnChainHtlcState | null> {
    const config = this.config();
    const swapIdWord = `0x${swap.swap_id}`;

    const data = await this.ethCall(
      config.rpcUrl,
      config.htlcAddress,
      encodeCall(SELECTORS.getSwap, [swapIdWord]),
    );

    // getSwap returns a single struct, so the words are laid out inline:
    // sender, recipient, token, amount, secretHash, timeout, status.
    const status = CONTRACT_STATUS[Number(readUint(data, 6))];

    if (!status || status === 'invalid') {
      return null;
    }

    const [tipHeight, lockHeight] = await Promise.all([
      this.getBlockNumber(config.rpcUrl),
      this.findLockBlock(swap),
    ]);

    const preimage =
      status === 'locked'
        ? null
        : await this.readPreimage(config, swapIdWord);

    return {
      status: status as OnChainHtlcStatus,
      amount: readUint(data, 3).toString(),
      secretHash: readBytes32(data, 4),
      timeout: readUint(data, 5).toString(),
      confirmations: lockHeight === null ? 0 : Math.max(0, tipHeight - lockHeight + 1),
      preimage,
      txHash: swap.source_lock_tx,
    };
  }

  buildLockRequest(swap: CrossChainSwap): HtlcLockRequest {
    const config = this.config();
    const amount = toSmallestUnit(swap.amount, this.chain);
    const args: Array<string | bigint> = config.tokenAddress
      ? [
          `0x${swap.swap_id}`,
          encodeAddress(config.recipientAddress),
          encodeAddress(config.tokenAddress),
          amount,
          `0x${swap.secret_hash}`,
          BigInt(swap.timeout_block),
        ]
      : [
          `0x${swap.swap_id}`,
          encodeAddress(config.recipientAddress),
          `0x${swap.secret_hash}`,
          BigInt(swap.timeout_block),
        ];

    return {
      chain: this.chain,
      htlcAddress: config.htlcAddress,
      amount: amount.toString(),
      secretHash: swap.secret_hash,
      timeout: swap.timeout_block,
      payload: encodeCall(
        config.tokenAddress ? SELECTORS.lockERC20 : SELECTORS.lockNative,
        args,
      ),
      metadata: {
        recipient: config.recipientAddress,
        token: config.tokenAddress ?? ZERO_ADDRESS,
        // Native locks carry the amount as msg.value; ERC-20 locks need an
        // approval for the same amount before the call will succeed.
        valueWei: config.tokenAddress ? '0' : amount.toString(),
      },
    };
  }

  buildClaimCall(swap: CrossChainSwap, secretHex: string): UnsignedChainCall {
    return {
      chain: this.chain,
      to: this.config().htlcAddress,
      data: encodeCall(SELECTORS.claim, [`0x${swap.swap_id}`, `0x${secretHex}`]),
      value: '0',
    };
  }

  buildRefundCall(swap: CrossChainSwap): UnsignedChainCall {
    return {
      chain: this.chain,
      to: this.config().htlcAddress,
      data: encodeCall(SELECTORS.refund, [`0x${swap.swap_id}`]),
      value: '0',
    };
  }

  /** Current gas price in wei, for the gas price oracle. */
  async getGasPrice(): Promise<bigint> {
    return BigInt(await this.rpc.call<string>(this.chain, this.config().rpcUrl, 'eth_gasPrice', []));
  }

  protected config(): EvmChainConfig {
    const keys = ENV_KEYS[this.chain];
    const rpcUrl = process.env[keys.rpc];
    const htlcAddress = process.env[keys.htlc];
    const recipientAddress = process.env[keys.recipient];

    if (!rpcUrl || !htlcAddress || !recipientAddress) {
      throw new Error(
        `${this.chain} swaps are not configured; set ${keys.rpc}, ${keys.htlc}, and ${keys.recipient}`,
      );
    }

    return { rpcUrl, htlcAddress, recipientAddress, tokenAddress: process.env[keys.token] };
  }

  private async readPreimage(config: EvmChainConfig, swapIdWord: string): Promise<string | null> {
    const data = await this.ethCall(
      config.rpcUrl,
      config.htlcAddress,
      encodeCall(SELECTORS.getPreimage, [swapIdWord]),
    );
    const preimage = readBytes32(data, 0);

    return preimage === ZERO_BYTES32 ? null : preimage;
  }

  private async getBlockNumber(rpcUrl: string): Promise<number> {
    return Number(BigInt(await this.rpc.call<string>(this.chain, rpcUrl, 'eth_blockNumber', [])));
  }

  /**
   * Block the lock transaction landed in, or `null` if it is still unmined.
   * Confirmations are counted from here so a reorg that unmines the lock drops
   * the swap back below its confirmation threshold instead of settling.
   */
  private async findLockBlock(swap: CrossChainSwap): Promise<number | null> {
    if (!swap.source_lock_tx) {
      return null;
    }

    const receipt = await this.rpc.call<{ blockNumber: string; status: string } | null>(
      this.chain,
      this.config().rpcUrl,
      'eth_getTransactionReceipt',
      [swap.source_lock_tx],
    );

    if (!receipt || BigInt(receipt.status) !== 1n) {
      return null;
    }

    return Number(BigInt(receipt.blockNumber));
  }

  private async ethCall(rpcUrl: string, to: string, data: string): Promise<string> {
    return this.rpc.call<string>(this.chain, rpcUrl, 'eth_call', [{ to, data }, 'latest']);
  }

}

@Injectable()
export class EthereumHtlcAdapter extends EvmHtlcAdapter {
  constructor(rpc: JsonRpcClient) {
    super(SwapChain.ETHEREUM, rpc);
  }
}

@Injectable()
export class PolygonHtlcAdapter extends EvmHtlcAdapter {
  constructor(rpc: JsonRpcClient) {
    super(SwapChain.POLYGON, rpc);
  }
}
