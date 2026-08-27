import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { BullModule } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { WebhookQueueProcessor, WEBHOOK_DELIVERY_QUEUE, WebhookDeliveryJobData } from './webhook-queue.processor';
import { Webhook } from '../entities/webhook.entity';
import { WebhookDelivery, WebhookDeliveryStatus } from '../entities/webhook-delivery.entity';
import { WebhookDLQ } from '../entities/webhook-dlq.entity';
import { WebhookSignatureService } from '../services/webhook-signature.service';
import { MetricsService } from '../../common/metrics/metrics.service';

function createMetricsServiceStub(): MetricsService {
  return {
    trackExternalCall: (_service: string, _operation: string, fn: () => Promise<unknown>) => fn(),
    setQueueDepth: jest.fn(),
    recordQueueJob: jest.fn(),
  } as unknown as MetricsService;
}

describe('WebhookQueueProcessor', () => {
  let processor: WebhookQueueProcessor;
  let webhookRepository: any;
  let deliveryRepository: any;
  let dlqRepository: any;
  let signatureService: WebhookSignatureService;
  let metricsService: MetricsService;

  beforeEach(async () => {
    webhookRepository = {
      findOne: jest.fn(),
    };
    deliveryRepository = {
      findOne: jest.fn(),
      save: jest.fn(),
    };
    dlqRepository = {
      save: jest.fn(),
      create: jest.fn((data: any) => data),
    };

    const module: TestingModule = await Test.createTestingModule({
      imports: [
        BullModule.forRoot({
          connection: {
            host: 'localhost',
            port: 6379,
          },
        }),
        BullModule.registerQueue({
          name: WEBHOOK_DELIVERY_QUEUE,
        }),
      ],
      providers: [
        WebhookQueueProcessor,
        WebhookSignatureService,
        { provide: getRepositoryToken(Webhook), useValue: webhookRepository },
        { provide: getRepositoryToken(WebhookDelivery), useValue: deliveryRepository },
        { provide: getRepositoryToken(WebhookDLQ), useValue: dlqRepository },
        { provide: MetricsService, useValue: createMetricsServiceStub() },
      ],
    }).compile();

    processor = module.get<WebhookQueueProcessor>(WebhookQueueProcessor);
    signatureService = module.get<WebhookSignatureService>(WebhookSignatureService);
    metricsService = module.get<MetricsService>(MetricsService);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('handleWebhookDelivery', () => {
    it('successfully delivers webhook and updates status', async () => {
      const webhook = {
        id: 'webhook-1',
        url: 'https://example.com/hook',
        secret: 'test-secret',
        is_active: true,
        headers: {},
      };
      const delivery = {
        id: 'delivery-1',
        webhook_id: 'webhook-1',
        event: 'payment.confirmed',
        payload: { amount: 100 },
        status: WebhookDeliveryStatus.PENDING,
        max_attempts: 5,
      };

      webhookRepository.findOne.mockResolvedValue(webhook);
      deliveryRepository.findOne.mockResolvedValue(delivery);
      deliveryRepository.save.mockResolvedValue({ ...delivery, status: WebhookDeliveryStatus.SUCCESS });

      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: async () => 'OK',
      }) as any;

      const job = {
        id: 'job-1',
        data: {
          webhookId: 'webhook-1',
          deliveryId: 'delivery-1',
          event: 'payment.confirmed',
          payload: { amount: 100 },
          attempt: 1,
        } as WebhookDeliveryJobData,
        updateData: jest.fn(),
        moveToDelayed: jest.fn(),
      } as unknown as Job<WebhookDeliveryJobData>;

      const result = await processor.handleWebhookDelivery(job);

      expect(deliveryRepository.save).toHaveBeenCalled();
      expect(result.status).toBe(WebhookDeliveryStatus.SUCCESS);
    });

    it('moves failed webhook to DLQ after max attempts', async () => {
      const webhook = {
        id: 'webhook-1',
        url: 'https://example.com/hook',
        secret: 'test-secret',
        is_active: true,
        headers: {},
      };
      const delivery = {
        id: 'delivery-1',
        webhook_id: 'webhook-1',
        event: 'payment.confirmed',
        payload: { amount: 100 },
        status: WebhookDeliveryStatus.PENDING,
        max_attempts: 5,
      };

      webhookRepository.findOne.mockResolvedValue(webhook);
      deliveryRepository.findOne.mockResolvedValue(delivery);
      deliveryRepository.save.mockResolvedValue({ ...delivery, status: WebhookDeliveryStatus.DLQ });

      global.fetch = jest.fn().mockResolvedValue({
        ok: false,
        status: 400,
        text: async () => 'Bad Request',
      }) as any;

      const job = {
        id: 'job-1',
        data: {
          webhookId: 'webhook-1',
          deliveryId: 'delivery-1',
          event: 'payment.confirmed',
          payload: { amount: 100 },
          attempt: 5,
        } as WebhookDeliveryJobData,
        updateData: jest.fn(),
        moveToDelayed: jest.fn(),
      } as unknown as Job<WebhookDeliveryJobData>;

      const result = await processor.handleWebhookDelivery(job);

      expect(dlqRepository.save).toHaveBeenCalled();
      expect(result.status).toBe(WebhookDeliveryStatus.DLQ);
    });

    it('skips delivery for inactive webhooks', async () => {
      const webhook = {
        id: 'webhook-1',
        url: 'https://example.com/hook',
        secret: 'test-secret',
        is_active: false,
        headers: {},
      };

      webhookRepository.findOne.mockResolvedValue(webhook);

      const job = {
        id: 'job-1',
        data: {
          webhookId: 'webhook-1',
          deliveryId: 'delivery-1',
          event: 'payment.confirmed',
          payload: { amount: 100 },
          attempt: 1,
        } as WebhookDeliveryJobData,
        updateData: jest.fn(),
        moveToDelayed: jest.fn(),
      } as unknown as Job<WebhookDeliveryJobData>;

      const result = await processor.handleWebhookDelivery(job);

      expect(result).toEqual({ skipped: true, reason: 'webhook_inactive' });
    });
  });
});
