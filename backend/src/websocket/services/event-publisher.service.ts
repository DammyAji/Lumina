import { Injectable, Logger, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { randomUUID } from 'crypto';
import { WebSocketEventType } from '../enums/websocket-event.enum';
import { PaymentEventPayload } from '../interfaces/websocket.interfaces';
import { SubscriptionManagerService } from './subscription-manager.service';
import { MetricsService } from '../../common/metrics/metrics.service';

export const WS_REDIS_CHANNEL = 'lumina:websocket:events';

export type EventEmitHandler = (event: PaymentEventPayload, rooms: string[]) => void;

/**
 * Publishes payment events to Redis pub/sub (for multi-instance fan-out)
 * and invokes the local Socket.IO emit handler.
 */
@Injectable()
export class EventPublisherService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(EventPublisherService.name);
  private publisher: Redis | null = null;
  private subscriber: Redis | null = null;
  private emitHandler: EventEmitHandler | null = null;
  private readonly batchQueue: PaymentEventPayload[] = [];
  private batchTimer: NodeJS.Timeout | null = null;
  private readonly batchWindowMs = parseInt(process.env.WS_EVENT_BATCH_MS || '25', 10);
  private readonly batchMax = parseInt(process.env.WS_EVENT_BATCH_MAX || '50', 10);

  constructor(
    private readonly subscriptionManager: SubscriptionManagerService,
    private readonly configService: ConfigService,
    @Optional() private readonly metricsService?: MetricsService,
  ) {}

  async onModuleInit(): Promise<void> {
    const host = this.configService.get<string>('REDIS_HOST') || process.env.REDIS_HOST || 'localhost';
    const port = parseInt(
      this.configService.get<string>('REDIS_PORT') || process.env.REDIS_PORT || '6379',
      10,
    );

    try {
      this.publisher = new Redis({ host, port, maxRetriesPerRequest: 1, lazyConnect: true });
      this.subscriber = new Redis({ host, port, maxRetriesPerRequest: 1, lazyConnect: true });
      await this.publisher.connect();
      await this.subscriber.connect();

      await this.subscriber.subscribe(WS_REDIS_CHANNEL);
      this.subscriber.on('message', (channel, message) => {
        if (channel !== WS_REDIS_CHANNEL) return;
        try {
          const event = JSON.parse(message) as PaymentEventPayload;
          this.deliverLocal(event);
        } catch (error) {
          this.logger.error(`Failed to parse redis WS event: ${(error as Error).message}`);
        }
      });

      this.logger.log(`WebSocket Redis pub/sub connected at ${host}:${port}`);
    } catch (error) {
      this.logger.warn(
        `Redis pub/sub unavailable for WebSocket fan-out; using local emit only: ${(error as Error).message}`,
      );
      this.publisher = null;
      this.subscriber = null;
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (this.batchTimer) clearTimeout(this.batchTimer);
    try {
      await this.subscriber?.quit();
      await this.publisher?.quit();
    } catch {
      /* ignore */
    }
  }

  setEmitHandler(handler: EventEmitHandler): void {
    this.emitHandler = handler;
  }

  /**
   * Build and publish a typed payment event. Prefer this from PaymentService.
   */
  async publish(
    type: WebSocketEventType,
    data: PaymentEventPayload['data'],
    options?: { batch?: boolean },
  ): Promise<PaymentEventPayload> {
    const channel = this.subscriptionManager.channelForEvent(type);
    const event: PaymentEventPayload = {
      event_id: randomUUID(),
      type,
      channel,
      timestamp: new Date().toISOString(),
      data,
    };

    if (options?.batch) {
      this.enqueueBatch(event);
      return event;
    }

    await this.publishNow(event);
    return event;
  }

  private enqueueBatch(event: PaymentEventPayload): void {
    this.batchQueue.push(event);
    if (this.batchQueue.length >= this.batchMax) {
      void this.flushBatch();
      return;
    }
    if (!this.batchTimer) {
      this.batchTimer = setTimeout(() => void this.flushBatch(), this.batchWindowMs);
    }
  }

  private async flushBatch(): Promise<void> {
    if (this.batchTimer) {
      clearTimeout(this.batchTimer);
      this.batchTimer = null;
    }
    const events = this.batchQueue.splice(0, this.batchQueue.length);
    for (const event of events) {
      await this.publishNow(event);
    }
  }

  private async publishNow(event: PaymentEventPayload): Promise<void> {
    const start = process.hrtime.bigint();

    if (this.publisher) {
      try {
        await this.publisher.publish(WS_REDIS_CHANNEL, JSON.stringify(event));
      } catch (error) {
        this.logger.warn(`Redis publish failed, falling back to local: ${(error as Error).message}`);
        this.deliverLocal(event);
      }
    } else {
      this.deliverLocal(event);
    }

    const durationNs = Number(process.hrtime.bigint() - start);
    const durationSeconds = durationNs / 1e9;
    this.metricsService?.recordWebSocketEvent(event.type, durationSeconds);
  }

  private deliverLocal(event: PaymentEventPayload): void {
    if (!this.emitHandler) {
      this.logger.debug(`No emit handler registered; dropping event ${event.type}`);
      return;
    }

    const rooms = this.resolveRooms(event);
    this.emitHandler(event, rooms);
  }

  private resolveRooms(event: PaymentEventPayload): string[] {
    const rooms = new Set<string>();
    rooms.add(`channel:${event.channel}`);

    if (event.data.payment_id) {
      rooms.add(`payment.${event.data.payment_id}`);
      rooms.add(`payments:payment.${event.data.payment_id}`);
    }
    if (event.data.merchant_id) {
      rooms.add(`merchant.${event.data.merchant_id}`);
      rooms.add(`payments:merchant.${event.data.merchant_id}`);
    }
    if (event.data.merchant_address) {
      rooms.add(`merchant.${event.data.merchant_address}`);
    }

    return Array.from(rooms);
  }
}
