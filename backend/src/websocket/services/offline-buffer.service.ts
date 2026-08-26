import { Injectable, Logger } from '@nestjs/common';
import { PaymentEventPayload } from '../interfaces/websocket.interfaces';

const DEFAULT_TTL_MS = 5 * 60 * 1000;
const MAX_BUFFER_PER_USER = 100;

interface BufferedEvent {
  event: PaymentEventPayload;
  bufferedAt: number;
}

/**
 * Buffers events for authenticated users while their sockets are offline,
 * then flushes on reconnect (replay).
 */
@Injectable()
export class OfflineBufferService {
  private readonly logger = new Logger(OfflineBufferService.name);
  private readonly buffers = new Map<string, BufferedEvent[]>();
  private readonly ttlMs = parseInt(process.env.WS_OFFLINE_BUFFER_TTL_MS || `${DEFAULT_TTL_MS}`, 10);

  buffer(userId: string, event: PaymentEventPayload): void {
    const list = this.buffers.get(userId) ?? [];
    list.push({ event, bufferedAt: Date.now() });

    while (list.length > MAX_BUFFER_PER_USER) {
      list.shift();
    }

    this.buffers.set(userId, list);
    this.logger.debug(`Buffered event ${event.type} for offline user ${userId}`);
  }

  flush(userId: string): PaymentEventPayload[] {
    const list = this.buffers.get(userId) ?? [];
    this.buffers.delete(userId);

    const now = Date.now();
    return list
      .filter((item) => now - item.bufferedAt <= this.ttlMs)
      .map((item) => item.event);
  }

  clear(userId: string): void {
    this.buffers.delete(userId);
  }
}
