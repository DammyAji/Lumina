import { Injectable } from '@nestjs/common';
import { MetricsService } from '../../common/metrics/metrics.service';
import { retryWithBackoff } from '../../blockchain-listener/retry.util';
import { BlockchainException } from '../../common/exceptions';

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_ATTEMPTS = 3;

/**
 * Thin JSON-RPC 2.0 client shared by the EVM and Solana adapters.
 *
 * Both chains expose plain JSON-RPC over HTTP, so the module talks to them
 * directly instead of pulling in ethers and @solana/web3.js. Calls are retried
 * with exponential backoff and recorded as external calls so cross-chain RPC
 * latency shows up on the same dashboards as Stellar's.
 */
@Injectable()
export class JsonRpcClient {
  constructor(private readonly metricsService: MetricsService) {}

  async call<T>(
    service: string,
    url: string,
    method: string,
    params: unknown[],
    options: { timeoutMs?: number; maxAttempts?: number } = {},
  ): Promise<T> {
    const { timeoutMs = DEFAULT_TIMEOUT_MS, maxAttempts = DEFAULT_MAX_ATTEMPTS } = options;

    return this.metricsService.trackExternalCall(service, method, () =>
      retryWithBackoff(() => this.request<T>(url, method, params), { maxAttempts, timeoutMs }),
    );
  }

  private async request<T>(url: string, method: string, params: unknown[]): Promise<T> {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });

    if (!response.ok) {
      throw BlockchainException.rpcError(`${method} returned status ${response.status}`);
    }

    const json = await response.json();

    if (json.error) {
      throw BlockchainException.rpcError(`${method}: ${json.error.message ?? 'unknown error'}`);
    }

    return json.result as T;
  }
}
