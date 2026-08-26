import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { SubscriptionManagerService } from './subscription-manager.service';
import { ConnectionManagerService } from './connection-manager.service';
import { WebSocketEventType } from '../enums/websocket-event.enum';
import { PaymentEventPayload } from '../interfaces/websocket.interfaces';
import { WebSocketConnection } from '../entities/websocket-connection.entity';

describe('SubscriptionManagerService', () => {
  let service: SubscriptionManagerService;
  let connectionManager: ConnectionManagerService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SubscriptionManagerService,
        ConnectionManagerService,
        {
          provide: getRepositoryToken(WebSocketConnection),
          useValue: {
            save: jest.fn().mockResolvedValue({}),
            update: jest.fn().mockResolvedValue({}),
            create: jest.fn((x) => x),
          },
        },
      ],
    }).compile();

    service = module.get(SubscriptionManagerService);
    connectionManager = module.get(ConnectionManagerService);
  });

  afterEach(() => {
    connectionManager.onModuleDestroy();
  });

  it('lists all channels with events', () => {
    const channels = service.listChannels();
    expect(channels.length).toBeGreaterThanOrEqual(6);
    expect(channels.find((c) => c.channel === 'payments')?.events).toContain(
      WebSocketEventType.PAYMENT_CONFIRMED,
    );
  });

  it('subscribes a connection to a payment room', async () => {
    await connectionManager.register({
      connectionId: 'sock-1',
      userId: 'user-1',
      merchantId: 'merchant-1',
      connectedAt: new Date(),
    });

    const result = service.subscribe('sock-1', {
      channel: 'payments',
      room: 'payment.pay_1',
      filter: { paymentId: 'pay_1' },
    });

    expect(result.key).toBe('payments:payment.pay_1');
    expect(result.room).toBe('payment.pay_1');
  });

  it('rejects subscription to another merchant', async () => {
    await connectionManager.register({
      connectionId: 'sock-2',
      userId: 'user-1',
      merchantId: 'merchant-1',
      connectedAt: new Date(),
    });

    expect(() =>
      service.subscribe('sock-2', {
        channel: 'payments',
        filter: { merchantId: 'merchant-other' },
      }),
    ).toThrow(/Not authorized/);
  });

  it('matches event filters', () => {
    const event: PaymentEventPayload = {
      event_id: 'e1',
      type: WebSocketEventType.PAYMENT_CONFIRMED,
      channel: 'payments',
      timestamp: new Date().toISOString(),
      data: {
        payment_id: 'pay_1',
        amount: 50,
        currency: 'USDC',
        status: 'confirmed',
        merchant_id: 'merchant-1',
      },
    };

    expect(service.matchesFilter(event, { minAmount: 10, currencies: ['USDC'] })).toBe(true);
    expect(service.matchesFilter(event, { minAmount: 100 })).toBe(false);
    expect(service.matchesFilter(event, { paymentId: 'pay_other' })).toBe(false);
    expect(
      service.matchesFilter(event, {
        eventTypes: [WebSocketEventType.PAYMENT_FAILED],
      }),
    ).toBe(false);
  });
});
