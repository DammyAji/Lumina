import { OfflineBufferService } from './offline-buffer.service';
import { WebSocketEventType } from '../enums/websocket-event.enum';
import { WebSocketRateLimitService } from './websocket-rate-limit.service';

describe('OfflineBufferService', () => {
  it('buffers and flushes events for a user', () => {
    const buffer = new OfflineBufferService();
    buffer.buffer('user-1', {
      event_id: '1',
      type: WebSocketEventType.PAYMENT_CREATED,
      channel: 'payments',
      timestamp: new Date().toISOString(),
      data: { payment_id: 'pay_1' },
    });

    const flushed = buffer.flush('user-1');
    expect(flushed).toHaveLength(1);
    expect(buffer.flush('user-1')).toHaveLength(0);
  });
});

describe('WebSocketRateLimitService', () => {
  it('allows messages under the limit and blocks when exceeded', () => {
    process.env.WS_RATE_LIMIT_PER_MINUTE = '3';
    const limiter = new WebSocketRateLimitService();

    expect(limiter.allowMessage('c1').allowed).toBe(true);
    expect(limiter.allowMessage('c1').allowed).toBe(true);
    expect(limiter.allowMessage('c1').allowed).toBe(true);
    expect(limiter.allowMessage('c1').allowed).toBe(false);

    delete process.env.WS_RATE_LIMIT_PER_MINUTE;
  });

  it('enforces max connections per user', () => {
    process.env.WS_MAX_CONNECTIONS_PER_USER = '2';
    const limiter = new WebSocketRateLimitService();
    expect(limiter.allowNewConnection('u1', 1)).toBe(true);
    expect(limiter.allowNewConnection('u1', 2)).toBe(false);
    delete process.env.WS_MAX_CONNECTIONS_PER_USER;
  });
});
