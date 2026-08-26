import { Injectable } from '@nestjs/common';
import { MetricsService } from '../../common/metrics/metrics.service';
import { retryWithBackoff } from '../../blockchain-listener/retry.util';
import { BlockchainException } from '../../common/exceptions';

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_ATTEMPTS = 3;

/**
 * Small REST client for chains without JSON-RPC, currently just Bitcoin, whose
 * Esplora-compatible explorers expose plain HTTP endpoints.
 */
@Injectable()
export class RestClient {
  constructor(private readonly metricsService: MetricsService) {}

  async getJson<T>(service: string, operation: string, url: string): Promise<T> {
    return this.fetchWith(service, operation, url, (response) => response.json() as Promise<T>);
  }

  async getText(service: string, operation: string, url: string): Promise<string> {
    return this.fetchWith(service, operation, url, (response) => response.text());
  }

  private async fetchWith<T>(
    service: string,
    operation: string,
    url: string,
    parse: (response: Response) => Promise<T>,
  ): Promise<T> {
    return this.metricsService.trackExternalCall(service, operation, () =>
      retryWithBackoff(
        async () => {
          const response = await fetch(url);

          if (!response.ok) {
            throw BlockchainException.rpcError(
              `${operation} returned status ${response.status}`,
            );
          }

          return parse(response);
        },
        { maxAttempts: DEFAULT_MAX_ATTEMPTS, timeoutMs: DEFAULT_TIMEOUT_MS },
      ),
    );
  }
}
