import { io, Socket } from 'socket.io-client';

export type PaymentWsEventType =
  | 'payment.created'
  | 'payment.confirmed'
  | 'payment.failed'
  | 'payment.completed'
  | 'fraud.alert'
  | 'account.update'
  | 'balance.change'
  | 'withdrawal.requested'
  | 'withdrawal.completed'
  | 'webhook.delivered'
  | 'webhook.failed';

export interface PaymentWsEvent {
  event_id: string;
  type: PaymentWsEventType;
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

export interface EventFilter {
  paymentId?: string;
  merchantId?: string;
  minAmount?: number;
  maxAmount?: number;
  currencies?: string[];
  statuses?: string[];
  eventTypes?: PaymentWsEventType[];
}

export interface WebSocketClientOptions {
  url?: string;
  token?: string;
  apiKey?: string;
  /** Max reconnect attempts before giving up (default: Infinity) */
  maxReconnectAttempts?: number;
  /** Initial reconnect delay in ms (default: 500) */
  reconnectDelayMs?: number;
  /** Max reconnect delay in ms (default: 15000) */
  maxReconnectDelayMs?: number;
  onEvent?: (event: PaymentWsEvent) => void;
  onConnected?: (info: Record<string, unknown>) => void;
  onError?: (error: { code?: string; message: string }) => void;
  onDisconnect?: (reason: string) => void;
}

const DEFAULT_URL =
  (typeof process !== 'undefined' && process.env.NEXT_PUBLIC_API_URL) ||
  'http://localhost:4000';

/**
 * Lumina Socket.IO client with exponential backoff reconnection
 * and offline event buffering until the socket is ready.
 */
export class LuminaWebSocketClient {
  private socket: Socket | null = null;
  private readonly options: WebSocketClientOptions;
  private reconnectAttempts = 0;
  private intentionalClose = false;
  private readonly offlineQueue: Array<{ event: string; payload: unknown }> = [];
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  constructor(options: WebSocketClientOptions = {}) {
    this.options = options;
  }

  connect(): Socket {
    if (this.socket?.connected) {
      return this.socket;
    }

    this.intentionalClose = false;
    const url = this.options.url || DEFAULT_URL;

    this.socket = io(`${url}/ws`, {
      transports: ['websocket', 'polling'],
      auth: {
        token: this.options.token,
        apiKey: this.options.apiKey,
      },
      extraHeaders: this.options.apiKey
        ? { 'x-api-key': this.options.apiKey }
        : undefined,
      reconnection: true,
      reconnectionAttempts: this.options.maxReconnectAttempts ?? Infinity,
      reconnectionDelay: this.options.reconnectDelayMs ?? 500,
      reconnectionDelayMax: this.options.maxReconnectDelayMs ?? 15_000,
      randomizationFactor: 0.5,
    });

    this.socket.on('connected', (info: Record<string, unknown>) => {
      this.reconnectAttempts = 0;
      this.flushOfflineQueue();
      this.startHeartbeat();
      this.options.onConnected?.(info);
    });

    this.socket.on('event', (event: PaymentWsEvent) => {
      this.options.onEvent?.(event);
    });

    this.socket.on('error', (error: { code?: string; message: string }) => {
      this.options.onError?.(error);
    });

    this.socket.on('disconnect', (reason: string) => {
      this.stopHeartbeat();
      this.options.onDisconnect?.(reason);
      if (!this.intentionalClose) {
        this.reconnectAttempts += 1;
      }
    });

    this.socket.on('pong', () => {
      /* heartbeat ack */
    });

    return this.socket;
  }

  subscribe(channel: string, room?: string, filter?: EventFilter): void {
    this.emitOrQueue('subscribe', { channel, room, filter });
  }

  unsubscribe(channel: string, room?: string): void {
    this.emitOrQueue('unsubscribe', { channel, room });
  }

  /**
   * Subscribe to a specific payment room: payments + payment.<id>
   */
  subscribePayment(paymentId: string, filter?: EventFilter): void {
    this.subscribe('payments', `payment.${paymentId}`, {
      ...filter,
      paymentId,
    });
  }

  disconnect(): void {
    this.intentionalClose = true;
    this.stopHeartbeat();
    this.socket?.disconnect();
    this.socket = null;
  }

  get isConnected(): boolean {
    return !!this.socket?.connected;
  }

  private emitOrQueue(event: string, payload: unknown): void {
    if (this.socket?.connected) {
      this.socket.emit(event, payload);
      return;
    }
    this.offlineQueue.push({ event, payload });
    if (this.offlineQueue.length > 100) {
      this.offlineQueue.shift();
    }
  }

  private flushOfflineQueue(): void {
    while (this.offlineQueue.length > 0 && this.socket?.connected) {
      const item = this.offlineQueue.shift();
      if (item) {
        this.socket.emit(item.event, item.payload);
      }
    }
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      this.socket?.emit('ping');
    }, 25_000);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }
}

export function connectWebSocket(options?: WebSocketClientOptions): LuminaWebSocketClient {
  const client = new LuminaWebSocketClient(options);
  client.connect();
  return client;
}
