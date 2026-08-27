import { Injectable, Logger } from '@nestjs/common';
import {
  AVAILABLE_CHANNELS,
  CHANNEL_EVENT_MAP,
  WebSocketChannel,
  WebSocketEventType,
} from '../enums/websocket-event.enum';
import {
  EventFilter,
  PaymentEventPayload,
  SubscribeMessage,
} from '../interfaces/websocket.interfaces';
import { ConnectionManagerService } from './connection-manager.service';

@Injectable()
export class SubscriptionManagerService {
  private readonly logger = new Logger(SubscriptionManagerService.name);

  constructor(private readonly connectionManager: ConnectionManagerService) {}

  listChannels(): Array<{
    channel: WebSocketChannel;
    events: WebSocketEventType[];
    description: string;
  }> {
    const descriptions: Record<WebSocketChannel, string> = {
      [WebSocketChannel.PAYMENTS]: 'Payment lifecycle events (created, confirmed, failed, completed)',
      [WebSocketChannel.ACCOUNT]: 'Merchant account profile and settings updates',
      [WebSocketChannel.FRAUD]: 'Fraud alerts and risk score changes',
      [WebSocketChannel.BALANCE]: 'Merchant balance changes',
      [WebSocketChannel.WITHDRAWALS]: 'Withdrawal request and completion events',
      [WebSocketChannel.WEBHOOKS]: 'Webhook delivery success and failure events',
    };

    return AVAILABLE_CHANNELS.map((channel) => ({
      channel,
      events: CHANNEL_EVENT_MAP[channel],
      description: descriptions[channel],
    }));
  }

  isValidChannel(channel: string): channel is WebSocketChannel {
    return AVAILABLE_CHANNELS.includes(channel as WebSocketChannel);
  }

  subscriptionKey(channel: string, room?: string): string {
    return room ? `${channel}:${room}` : channel;
  }

  roomName(channel: string, room?: string): string {
    if (room) return room;
    return `channel:${channel}`;
  }

  canSubscribe(
    channel: string,
    merchantId: string | undefined,
    filter: EventFilter | undefined,
  ): { ok: boolean; reason?: string } {
    if (!this.isValidChannel(channel)) {
      return { ok: false, reason: `Unknown channel: ${channel}` };
    }

    if (channel === WebSocketChannel.FRAUD && !merchantId) {
      return { ok: false, reason: 'Fraud channel requires an authenticated merchant' };
    }

    if (filter?.merchantId && merchantId && filter.merchantId !== merchantId) {
      return { ok: false, reason: 'Not authorized to subscribe to another merchant' };
    }

    return { ok: true };
  }

  subscribe(connectionId: string, message: SubscribeMessage): { key: string; room: string } {
    const conn = this.connectionManager.get(connectionId);
    if (!conn) {
      throw new Error('Connection not found');
    }

    const auth = this.canSubscribe(message.channel, conn.merchantId, message.filter);
    if (!auth.ok) {
      throw new Error(auth.reason);
    }

    const key = this.subscriptionKey(message.channel, message.room);
    const room = this.roomName(message.channel, message.room);
    const filter: EventFilter = {
      ...(message.filter ?? {}),
      merchantId: message.filter?.merchantId ?? conn.merchantId,
    };

    conn.subscriptions.set(key, filter);
    this.connectionManager.updateSubscriptions(connectionId, conn.subscriptions);
    this.logger.debug(`Connection ${connectionId} subscribed to ${key}`);

    return { key, room };
  }

  unsubscribe(connectionId: string, channel: string, room?: string): string {
    const conn = this.connectionManager.get(connectionId);
    if (!conn) {
      throw new Error('Connection not found');
    }

    const key = this.subscriptionKey(channel, room);
    conn.subscriptions.delete(key);
    this.connectionManager.updateSubscriptions(connectionId, conn.subscriptions);
    return this.roomName(channel, room);
  }

  matchesFilter(event: PaymentEventPayload, filter: EventFilter): boolean {
    if (filter.eventTypes?.length && !filter.eventTypes.includes(event.type)) {
      return false;
    }

    const amount = event.data.amount;
    if (filter.minAmount != null && (amount == null || amount < filter.minAmount)) {
      return false;
    }
    if (filter.maxAmount != null && (amount == null || amount > filter.maxAmount)) {
      return false;
    }

    if (filter.currencies?.length) {
      const currency = event.data.currency;
      if (!currency || !filter.currencies.includes(currency)) {
        return false;
      }
    }

    if (filter.statuses?.length) {
      const status = event.data.status;
      if (!status || !filter.statuses.includes(status)) {
        return false;
      }
    }

    if (filter.paymentId && event.data.payment_id !== filter.paymentId) {
      return false;
    }

    if (filter.merchantId) {
      const merchantMatch =
        event.data.merchant_id === filter.merchantId ||
        event.data.merchant_address === filter.merchantId;
      if (!merchantMatch) {
        return false;
      }
    }

    return true;
  }

  channelForEvent(type: WebSocketEventType): WebSocketChannel {
    for (const [channel, events] of Object.entries(CHANNEL_EVENT_MAP) as Array<
      [WebSocketChannel, WebSocketEventType[]]
    >) {
      if (events.includes(type)) {
        return channel;
      }
    }
    return WebSocketChannel.PAYMENTS;
  }
}
