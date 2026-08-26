import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CrossChainSwap } from './entities/cross-chain-swap.entity';
import { CrossChainSwapController } from './cross-chain-swap.controller';
import { CrossChainSwapService } from './cross-chain-swap.service';
import { ChainListenerService } from './chain-listener.service';
import { RefundService } from './refund.service';
import { SecretManagerService } from './secret-manager.service';
import { GasPriceOracleService } from './gas-price-oracle.service';
import { ChainRegistryService } from './chains/chain-registry.service';
import { EthereumHtlcAdapter, PolygonHtlcAdapter } from './chains/evm-htlc.adapter';
import { BitcoinHtlcAdapter } from './chains/bitcoin-htlc.adapter';
import { SolanaHtlcAdapter } from './chains/solana-htlc.adapter';
import { StellarHtlcAdapter } from './chains/stellar-htlc.adapter';
import { JsonRpcClient } from './chains/json-rpc.client';
import { RestClient } from './chains/rest.client';
import { SWAP_BROADCASTER } from './swap-broadcaster.interface';
import { UnconfiguredSwapBroadcaster } from './unconfigured-swap-broadcaster';
import { MetricsModule } from '../common/metrics/metrics.module';
import { DistributedLedgerModule } from '../distributed-ledger/distributed-ledger.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([CrossChainSwap]),
    MetricsModule,
    // Provides DistributedLockService, the Redis lock that keeps two replicas
    // from advancing the same swap at once.
    DistributedLedgerModule,
  ],
  controllers: [CrossChainSwapController],
  providers: [
    CrossChainSwapService,
    ChainListenerService,
    RefundService,
    SecretManagerService,
    GasPriceOracleService,
    ChainRegistryService,
    JsonRpcClient,
    RestClient,
    EthereumHtlcAdapter,
    PolygonHtlcAdapter,
    BitcoinHtlcAdapter,
    SolanaHtlcAdapter,
    StellarHtlcAdapter,
    // Swapped for a real signer by deployments that settle swaps; see
    // swap-broadcaster.interface.ts.
    { provide: SWAP_BROADCASTER, useClass: UnconfiguredSwapBroadcaster },
  ],
  exports: [CrossChainSwapService, SecretManagerService],
})
export class CrossChainSwapModule {}
