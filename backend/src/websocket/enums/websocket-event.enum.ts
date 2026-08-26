/**
 * Real-time WebSocket event types for payment streaming.
 * Extends the webhook notification surface with fraud, account, and delivery events.
 */
export enum WebSocketEventType {
  PAYMENT_CREATED = 'payment.created',
  PAYMENT_CONFIRMED = 'payment.confirmed',
  PAYMENT_FAILED = 'payment.failed',
  PAYMENT_COMPLETED = 'payment.completed',
  FRAUD_ALERT = 'fraud.alert',
  ACCOUNT_UPDATE = 'account.update',
  BALANCE_CHANGE = 'balance.change',
  WITHDRAWAL_REQUESTED = 'withdrawal.requested',
  WITHDRAWAL_COMPLETED = 'withdrawal.completed',
  WEBHOOK_DELIVERED = 'webhook.delivered',
  WEBHOOK_FAILED = 'webhook.failed',
}

export enum WebSocketChannel {
  PAYMENTS = 'payments',
  ACCOUNT = 'account',
  FRAUD = 'fraud',
  BALANCE = 'balance',
  WITHDRAWALS = 'withdrawals',
  WEBHOOKS = 'webhooks',
}

export const CHANNEL_EVENT_MAP: Record<WebSocketChannel, WebSocketEventType[]> = {
  [WebSocketChannel.PAYMENTS]: [
    WebSocketEventType.PAYMENT_CREATED,
    WebSocketEventType.PAYMENT_CONFIRMED,
    WebSocketEventType.PAYMENT_FAILED,
    WebSocketEventType.PAYMENT_COMPLETED,
  ],
  [WebSocketChannel.ACCOUNT]: [WebSocketEventType.ACCOUNT_UPDATE],
  [WebSocketChannel.FRAUD]: [WebSocketEventType.FRAUD_ALERT],
  [WebSocketChannel.BALANCE]: [WebSocketEventType.BALANCE_CHANGE],
  [WebSocketChannel.WITHDRAWALS]: [
    WebSocketEventType.WITHDRAWAL_REQUESTED,
    WebSocketEventType.WITHDRAWAL_COMPLETED,
  ],
  [WebSocketChannel.WEBHOOKS]: [
    WebSocketEventType.WEBHOOK_DELIVERED,
    WebSocketEventType.WEBHOOK_FAILED,
  ],
};

export const AVAILABLE_CHANNELS = Object.values(WebSocketChannel);
