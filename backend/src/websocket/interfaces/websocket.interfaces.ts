import { WebSocketEventType } from '../enums/websocket-event.enum';

export interface EventFilter {
  /** Exact payment id, e.g. pay_... */
  paymentId?: string;
  /** Merchant UUID or stellar address */
  merchantId?: string;
  /** Inclusive minimum amount */
  minAmount?: number;
  /** Inclusive maximum amount */
  maxAmount?: number;
  /** Currency codes, e.g. USDC, XLM */
  currencies?: string[];
  /** Payment statuses */
  statuses?: string[];
  /** Restrict to specific event types */
  eventTypes?: WebSocketEventType[];
}

export interface PaymentEventPayload {
  event_id: string;
  type: WebSocketEventType;
  channel: string;
  timestamp: string;
  data: {
    payment_id?: string;
    merchant_id?: string;
    merchant_address?: string;
    amount?: number;
    currency?: string;
    status?: string;
    transaction_hash?: string;
    reason?: string;
    [key: string]: unknown;
  };
}

export interface ConnectionMeta {
  connectionId: string;
  userId: string;
  merchantId?: string;
  role?: string;
  ipAddress?: string;
  userAgent?: string;
  connectedAt: Date;
  lastPing: Date;
  subscriptions: Map<string, EventFilter>;
  messageCount: number;
  rateLimitedUntil?: number;
}

export interface SubscribeMessage {
  channel: string;
  /** Optional room key, e.g. payment.pay_xxx or merchant.<id> */
  room?: string;
  filter?: EventFilter;
}

export interface UnsubscribeMessage {
  channel: string;
  room?: string;
}
