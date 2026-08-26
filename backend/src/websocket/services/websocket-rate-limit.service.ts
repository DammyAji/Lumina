import { Injectable, Logger } from '@nestjs/common';

interface WindowBucket {
  timestamps: number[];
}

/**
 * Per-connection sliding-window rate limiter for WebSocket messages.
 * Defaults: 100 subscribe/auth messages per minute, 1000 events outbound tracked separately.
 */
@Injectable()
export class WebSocketRateLimitService {
  private readonly logger = new Logger(WebSocketRateLimitService.name);
  private readonly buckets = new Map<string, WindowBucket>();

  private readonly maxMessagesPerMinute =
    parseInt(process.env.WS_RATE_LIMIT_PER_MINUTE || '120', 10) || 120;
  private readonly maxConnectionsPerUser =
    parseInt(process.env.WS_MAX_CONNECTIONS_PER_USER || '10', 10) || 10;
  private readonly windowMs = 60_000;

  allowMessage(connectionId: string): { allowed: boolean; retryAfterMs?: number } {
    const now = Date.now();
    const key = `msg:${connectionId}`;
    const bucket = this.buckets.get(key) ?? { timestamps: [] };
    bucket.timestamps = bucket.timestamps.filter((t) => now - t < this.windowMs);

    if (bucket.timestamps.length >= this.maxMessagesPerMinute) {
      const oldest = bucket.timestamps[0];
      const retryAfterMs = this.windowMs - (now - oldest);
      this.logger.debug(`Rate limit hit for connection ${connectionId}`);
      this.buckets.set(key, bucket);
      return { allowed: false, retryAfterMs };
    }

    bucket.timestamps.push(now);
    this.buckets.set(key, bucket);
    return { allowed: true };
  }

  allowNewConnection(userId: string, currentUserConnections: number): boolean {
    if (currentUserConnections >= this.maxConnectionsPerUser) {
      this.logger.warn(`User ${userId} exceeded max websocket connections`);
      return false;
    }
    return true;
  }

  clear(connectionId: string): void {
    this.buckets.delete(`msg:${connectionId}`);
  }
}
