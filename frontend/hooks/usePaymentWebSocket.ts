'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  connectWebSocket,
  LuminaWebSocketClient,
  PaymentWsEvent,
  WebSocketClientOptions,
} from '@/services/websocket';

export interface UsePaymentWebSocketOptions {
  token?: string;
  apiKey?: string;
  url?: string;
  enabled?: boolean;
  onEvent?: (event: PaymentWsEvent) => void;
}

export interface UsePaymentWebSocketResult {
  status: string | null;
  event: PaymentWsEvent | null;
  error: string | null;
  connected: boolean;
  reconnect: () => void;
  disconnect: () => void;
}

/**
 * React hook for real-time payment status via the Lumina WebSocket API.
 *
 * @example
 * const { status, error, connected } = usePaymentWebSocket(paymentId, { token });
 */
export function usePaymentWebSocket(
  paymentId: string | null | undefined,
  options: UsePaymentWebSocketOptions = {},
): UsePaymentWebSocketResult {
  const [status, setStatus] = useState<string | null>(null);
  const [event, setEvent] = useState<PaymentWsEvent | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const clientRef = useRef<LuminaWebSocketClient | null>(null);
  const onEventRef = useRef(options.onEvent);
  onEventRef.current = options.onEvent;

  const disconnect = useCallback(() => {
    clientRef.current?.disconnect();
    clientRef.current = null;
    setConnected(false);
  }, []);

  const connect = useCallback(() => {
    if (!paymentId || options.enabled === false) return;
    if (!options.token && !options.apiKey) {
      // Allow unauthenticated connect attempts only if server permits;
      // still try — server will reject with AUTH_FAILED.
    }

    disconnect();

    const clientOptions: WebSocketClientOptions = {
      url: options.url,
      token: options.token,
      apiKey: options.apiKey,
      onConnected: () => {
        setConnected(true);
        setError(null);
        clientRef.current?.subscribePayment(paymentId);
      },
      onEvent: (wsEvent) => {
        if (wsEvent.data.payment_id && wsEvent.data.payment_id !== paymentId) {
          return;
        }
        setEvent(wsEvent);
        if (wsEvent.data.status) {
          setStatus(wsEvent.data.status);
        } else if (wsEvent.type === 'payment.confirmed') {
          setStatus('confirmed');
        } else if (wsEvent.type === 'payment.failed') {
          setStatus('failed');
        } else if (wsEvent.type === 'payment.completed') {
          setStatus('completed');
        } else if (wsEvent.type === 'payment.created') {
          setStatus('pending');
        }
        onEventRef.current?.(wsEvent);
      },
      onError: (err) => {
        setError(err.message || err.code || 'WebSocket error');
      },
      onDisconnect: () => {
        setConnected(false);
      },
    };

    clientRef.current = connectWebSocket(clientOptions);
  }, [paymentId, options.enabled, options.token, options.apiKey, options.url, disconnect]);

  useEffect(() => {
    connect();
    return () => disconnect();
  }, [connect, disconnect]);

  return {
    status,
    event,
    error,
    connected,
    reconnect: connect,
    disconnect,
  };
}

/**
 * Merchant-wide payment event stream (all payments for the authenticated merchant).
 */
export function useMerchantPaymentEvents(
  options: UsePaymentWebSocketOptions = {},
): {
  events: PaymentWsEvent[];
  error: string | null;
  connected: boolean;
  clear: () => void;
} {
  const [events, setEvents] = useState<PaymentWsEvent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const clientRef = useRef<LuminaWebSocketClient | null>(null);

  useEffect(() => {
    if (options.enabled === false) return;

    const client = connectWebSocket({
      url: options.url,
      token: options.token,
      apiKey: options.apiKey,
      onConnected: () => {
        setConnected(true);
        client.subscribe('payments');
      },
      onEvent: (event) => {
        if (event.channel !== 'payments' && !event.type.startsWith('payment.')) return;
        setEvents((prev) => [event, ...prev].slice(0, 200));
        options.onEvent?.(event);
      },
      onError: (err) => setError(err.message || 'WebSocket error'),
      onDisconnect: () => setConnected(false),
    });

    clientRef.current = client;
    return () => client.disconnect();
  }, [options.enabled, options.token, options.apiKey, options.url]);

  return {
    events,
    error,
    connected,
    clear: () => setEvents([]),
  };
}
