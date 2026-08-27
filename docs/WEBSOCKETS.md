# Lumina WebSocket API — Real-Time Payment Events

Lumina exposes a Socket.IO WebSocket gateway for sub-second streaming of payment lifecycle events, fraud alerts, balance changes, and webhook delivery notifications. This replaces inefficient REST polling (5–10s) with authenticated, channel-based subscriptions.

---

## 1. Endpoints

| Method | Endpoint | Description |
|---|---|---|
| `WS` | `/ws` | Socket.IO namespace for event streaming |
| `GET` | `/ws/channels` | List available channels and event types |
| `POST` | `/ws/authenticate` | Issue a short-lived WebSocket JWT (requires Bearer access token) |
| `GET` | `/ws/stats` | Active connection metrics (authenticated) |

Default backend URL: `http://localhost:4000`  
Socket.IO path: connect to `http://localhost:4000/ws`

---

## 2. Authentication

Every socket must authenticate on handshake using one of:

1. **Access JWT** — `auth.token`, `Authorization: Bearer <token>`, or `?token=`
2. **WS token** — short-lived token from `POST /ws/authenticate` (`scope: ws`, default TTL 5m)
3. **API key** — `auth.apiKey` or header `x-api-key`

### Obtain a WS token

```bash
curl -X POST http://localhost:4000/ws/authenticate \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"channels":["payments","fraud"]}'
```

Response:

```json
{
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "expires_in": 1710000000,
  "namespace": "/ws",
  "url": "http://localhost:4000"
}
```

---

## 3. Channels & Event Schema

| Channel | Events |
|---|---|
| `payments` | `payment.created`, `payment.confirmed`, `payment.failed`, `payment.completed` |
| `account` | `account.update` |
| `fraud` | `fraud.alert` |
| `balance` | `balance.change` |
| `withdrawals` | `withdrawal.requested`, `withdrawal.completed` |
| `webhooks` | `webhook.delivered`, `webhook.failed` |

### Event envelope

```json
{
  "event_id": "550e8400-e29b-41d4-a716-446655440000",
  "type": "payment.confirmed",
  "channel": "payments",
  "timestamp": "2026-08-26T12:00:00.000Z",
  "data": {
    "payment_id": "pay_1724_abc",
    "merchant_id": "uuid",
    "merchant_address": "G...",
    "amount": 100.5,
    "currency": "USDC",
    "status": "confirmed",
    "transaction_hash": "abc123"
  }
}
```

---

## 4. Client Protocol

### Connect (Socket.IO)

```js
import { io } from 'socket.io-client';

const socket = io('http://localhost:4000/ws', {
  auth: { token: wsToken },
  transports: ['websocket', 'polling'],
});

socket.on('connected', (info) => console.log('connected', info));
socket.on('event', (event) => console.log(event.type, event.data));
socket.on('error', (err) => console.error(err));
```

### Subscribe / unsubscribe

```js
socket.emit('subscribe', {
  channel: 'payments',
  room: 'payment.pay_1724_abc',
  filter: {
    paymentId: 'pay_1724_abc',
    minAmount: 1,
    currencies: ['USDC', 'XLM'],
    statuses: ['confirmed', 'failed'],
  },
});

socket.on('subscribed', (ack) => console.log(ack));

socket.emit('unsubscribe', {
  channel: 'payments',
  room: 'payment.pay_1724_abc',
});
```

### Heartbeat

Server uses Socket.IO ping/pong. Clients may also emit `ping` and receive `pong`:

```js
socket.emit('ping');
socket.on('pong', ({ ts }) => console.log('pong', ts));
```

---

## 5. React Hook

```tsx
import { usePaymentWebSocket } from '@/hooks/usePaymentWebSocket';

export function PaymentStatus({ paymentId, token }: { paymentId: string; token: string }) {
  const { status, error, connected } = usePaymentWebSocket(paymentId, { token });

  return (
    <div>
      <p>WS: {connected ? 'live' : 'offline'}</p>
      <p>Status: {status ?? '…'}</p>
      {error && <p>{error}</p>}
    </div>
  );
}
```

The frontend client (`services/websocket.ts`) implements:

- Exponential backoff reconnection (500ms → 15s)
- Offline subscribe buffering until connected
- Application-level heartbeat every 25s

---

## 6. Filtering

Subscription `filter` supports:

| Field | Description |
|---|---|
| `paymentId` | Exact payment id |
| `merchantId` | Merchant UUID or stellar address |
| `minAmount` / `maxAmount` | Amount range |
| `currencies` | Currency allow-list |
| `statuses` | Status allow-list |
| `eventTypes` | Restrict to specific event types |

Merchants cannot subscribe to another merchant’s filtered stream.

---

## 7. Architecture

```
PaymentService.create / updateStatus
        │
        ▼
EventPublisherService ──► Redis pub/sub (lumina:websocket:events)
        │
        ▼
PaymentEventsGateway ──► Socket.IO rooms (payment.*, merchant.*, channel:*)
        │
        ▼
Authenticated clients (+ offline buffer replay on reconnect)
```

- **Connection manager** — lifecycle, heartbeat stale cleanup (90s), DB audit row in `websocket_connections`
- **Subscription manager** — channel/room keys + filter matching
- **Rate limiting** — per-connection message window (`WS_RATE_LIMIT_PER_MINUTE`, default 120) and max connections per user (`WS_MAX_CONNECTIONS_PER_USER`, default 10)
- **Redis adapter** — `@socket.io/redis-adapter` for horizontal scaling across backend replicas
- **Compression** — `perMessageDeflate: true`
- **Offline buffer** — last 100 events / 5 minutes per user, replayed on `connected`

---

## 8. Metrics (Prometheus)

| Metric | Type | Description |
|---|---|---|
| `websocket_connections_active` | Gauge | Live connections |
| `websocket_events_total` | Counter | Events published |
| `websocket_event_publish_duration_seconds` | Histogram | Publish latency |
| `websocket_events_delivered_total` | Counter | Events delivered to sockets |
| `websocket_connection_errors_total` | Counter | Auth / rate-limit / connection errors |

---

## 9. Environment

```env
WS_TOKEN_EXPIRY=5m
WS_RATE_LIMIT_PER_MINUTE=120
WS_MAX_CONNECTIONS_PER_USER=10
WS_OFFLINE_BUFFER_TTL_MS=300000
WS_EVENT_BATCH_MS=25
WS_EVENT_BATCH_MAX=50
WS_PUBLIC_URL=http://localhost:4000
REDIS_HOST=localhost
REDIS_PORT=6379
```

---

## 10. Load testing

See the script header for targeting 10,000+ concurrent connections (requires Redis + adequate `ulimit -n`).

```bash
cd backend
npx ts-node src/websocket/load/websocket.load-test.ts --connections=1000 --duration=60
```

---

## 11. Security notes

- Handshake auth is mandatory; unauthenticated sockets are disconnected immediately
- API keys are validated via the same hashed-key path as REST
- Access tokens are checked against the blacklist (except short-lived `ws_*` jtis)
- Channel subscriptions are permission-scoped to the authenticated merchant
