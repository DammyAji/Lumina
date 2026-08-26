import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { LessThanOrEqual, Repository } from 'typeorm';
import { Cron, CronExpression } from '@nestjs/schedule';
import * as crypto from 'crypto';
import * as http from 'http';
import * as https from 'https';
import Redis from 'ioredis';
import { Webhook } from '../entities/webhook.entity';
import { WebhookDelivery, WebhookDeliveryStatus } from '../entities/webhook-delivery.entity';
import { WebhookDLQ } from '../entities/webhook-dlq.entity';
import { RegisterWebhookDto } from './dto/register-webhook.dto';
import { UpdateWebhookDto } from './dto/update-webhook.dto';
import { TestWebhookDto } from './dto/test-webhook.dto';
import { NotificationEvent } from '../events/notification-event.enum';
import { MetricsService } from '../../common/metrics/metrics.service';
import { EventFilterService } from '../services/event-filter.service';
import { WebhookSignatureService } from '../services/webhook-signature.service';
import { WEBHOOK_DELIVERY_QUEUE, WebhookDeliveryJobData } from './webhook-queue.processor';

export interface RetryConfig {
  maxAttempts: number;
  initialDelay: number; // milliseconds
  maxDelay: number;
  backoffMultiplier: number;
  retryableErrors: number[];
}

export const defaultRetryConfig: RetryConfig = {
  maxAttempts: 5,
  initialDelay: 1000, // 1 second
  maxDelay: 300000, // 5 minutes
  backoffMultiplier: 2,
  retryableErrors: [408, 429, 500, 502, 503, 504],
};

export function calculateRetryDelay(attempt: number, config: RetryConfig = defaultRetryConfig): number {
  const delay = config.initialDelay * Math.pow(config.backoffMultiplier, attempt - 1);
  return Math.min(delay, config.maxDelay);
}

export const SIGNATURE_HEADER = 'x-lumina-signature';
export const TIMESTAMP_HEADER = 'x-lumina-timestamp';

@Injectable()
export class WebhookService {
  private readonly logger = new Logger(WebhookService.name);
  private readonly httpAgent: http.Agent;
  private readonly httpsAgent: https.Agent;
  private readonly redis: Redis;

  constructor(
    @InjectRepository(Webhook)
    private webhookRepository: Repository<Webhook>,
    @InjectRepository(WebhookDelivery)
    private deliveryRepository: Repository<WebhookDelivery>,
    @InjectRepository(WebhookDLQ)
    private dlqRepository: Repository<WebhookDLQ>,
    @InjectQueue(WEBHOOK_DELIVERY_QUEUE)
    private webhookQueue: Queue<WebhookDeliveryJobData>,
    private metricsService: MetricsService,
    private eventFilterService: EventFilterService,
    private signatureService: WebhookSignatureService,
  ) {
    this.httpAgent = new http.Agent({ keepAlive: true, maxSockets: 100 });
    this.httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 100 });
    this.redis = new Redis({
      host: process.env.REDIS_HOST || 'localhost',
      port: parseInt(process.env.REDIS_PORT || '6379', 10),
    });
  }

  async registerWebhook(dto: RegisterWebhookDto): Promise<Webhook> {
    const webhook = this.webhookRepository.create({
      merchant_id: dto.merchant_id,
      url: dto.url,
      events: dto.events,
      filters: dto.filters,
      headers: dto.headers,
      secret: crypto.randomBytes(32).toString('hex'),
      is_active: true,
    });

    return this.webhookRepository.save(webhook);
  }

  async updateWebhook(id: string, dto: UpdateWebhookDto): Promise<Webhook> {
    const webhook = await this.webhookRepository.findOne({ where: { id } });
    if (!webhook) {
      throw new NotFoundException('Webhook not found');
    }

    if (dto.url !== undefined) webhook.url = dto.url;
    if (dto.events !== undefined) webhook.events = dto.events;
    if (dto.filters !== undefined) webhook.filters = dto.filters;
    if (dto.headers !== undefined) webhook.headers = dto.headers;
    if (dto.is_active !== undefined) webhook.is_active = dto.is_active;

    return this.webhookRepository.save(webhook);
  }

  async listWebhooks(merchantId?: string): Promise<Webhook[]> {
    if (merchantId) {
      return this.webhookRepository.find({ where: { merchant_id: merchantId } });
    }
    return this.webhookRepository.find();
  }

  async getWebhook(id: string): Promise<Webhook> {
    const webhook = await this.webhookRepository.findOne({ where: { id } });
    if (!webhook) {
      throw new NotFoundException('Webhook not found');
    }
    return webhook;
  }

  async deleteWebhook(id: string): Promise<void> {
    const webhook = await this.getWebhook(id);
    await this.webhookRepository.remove(webhook);
  }

  async pauseWebhook(id: string): Promise<Webhook> {
    const webhook = await this.getWebhook(id);
    webhook.is_active = false;
    return this.webhookRepository.save(webhook);
  }

  async resumeWebhook(id: string): Promise<Webhook> {
    const webhook = await this.getWebhook(id);
    webhook.is_active = true;
    return this.webhookRepository.save(webhook);
  }

  async sendWebhook(
    event: NotificationEvent | string,
    merchantId: string,
    data: Record<string, any>,
  ): Promise<void> {
    const webhooks = await this.webhookRepository.find({
      where: { merchant_id: merchantId, is_active: true },
    });

    const eventPayload = { type: event, event, data };

    const matchingWebhooks = webhooks.filter((webhook) =>
      this.eventFilterService.shouldDeliver(webhook, eventPayload),
    );

    for (const webhook of matchingWebhooks) {
      // Check payload size limit (1MB default)
      const payloadSize = JSON.stringify(data).length;
      const MAX_PAYLOAD_SIZE = 1024 * 1024; // 1MB
      if (payloadSize > MAX_PAYLOAD_SIZE) {
        this.logger.error(`Payload size ${payloadSize} exceeds limit ${MAX_PAYLOAD_SIZE} for webhook ${webhook.id}`);
        continue;
      }

      // Check rate limit per endpoint (100 requests per minute) using Redis
      const rateLimitKey = `webhook_rate:${webhook.id}`;
      const currentCount = await this.redis.incr(rateLimitKey);
      if (currentCount === 1) {
        await this.redis.expire(rateLimitKey, 60); // 60 second window
      }
      if (currentCount > 100) {
        this.logger.warn(`Rate limit exceeded for webhook ${webhook.id}`);
        continue;
      }

      const eventId = `evt_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
      const delivery = await this.deliveryRepository.save(
        this.deliveryRepository.create({
          webhook_id: webhook.id,
          event_id: eventId,
          event: String(event),
          payload: data,
          status: WebhookDeliveryStatus.PENDING,
        }),
      );

      // Add to BullMQ queue for processing
      await this.webhookQueue.add(
        'webhook-delivery',
        {
          webhookId: webhook.id,
          deliveryId: delivery.id,
          event: String(event),
          payload: data,
          attempt: 1,
        } as WebhookDeliveryJobData,
        {
          jobId: delivery.id,
          removeOnComplete: 1000,
          removeOnFail: 5000,
        },
      );
    }
  }

  async sendWebhookBatch(
    items: Array<{ event: NotificationEvent | string; merchantId: string; data: Record<string, any> }>,
    batchSize = 100,
  ): Promise<void> {
    for (let i = 0; i < items.length; i += batchSize) {
      const batch = items.slice(i, i + batchSize);
      await Promise.all(batch.map((item) => this.sendWebhook(item.event, item.merchantId, item.data)));
    }
  }

  async getWebhookDeliveryStatus(webhookId: string): Promise<WebhookDelivery[]> {
    await this.getWebhook(webhookId);
    return this.deliveryRepository.find({
      where: { webhook_id: webhookId },
      order: { created_at: 'DESC' },
    });
  }

  async replayFailedWebhooks(webhookId: string): Promise<WebhookDelivery[]> {
    await this.getWebhook(webhookId);
    const failedDeliveries = await this.deliveryRepository.find({
      where: [
        { webhook_id: webhookId, status: WebhookDeliveryStatus.FAILED },
        { webhook_id: webhookId, status: WebhookDeliveryStatus.DLQ },
      ],
    });

    const webhook = await this.getWebhook(webhookId);
    const replayed: WebhookDelivery[] = [];

    for (const delivery of failedDeliveries) {
      delivery.attempts = 0;
      delivery.status = WebhookDeliveryStatus.PENDING;
      delivery.next_retry_at = null;
      delivery.error_message = null;
      const saved = await this.deliveryRepository.save(delivery);
      await this.attemptDelivery(webhook, saved);
      replayed.push(saved);
    }

    return replayed;
  }

  async getDLQItems(merchantId?: string): Promise<WebhookDLQ[]> {
    if (merchantId) {
      const webhooks = await this.webhookRepository.find({ where: { merchant_id: merchantId } });
      const webhookIds = webhooks.map((w) => w.id);
      if (webhookIds.length === 0) return [];
      return this.dlqRepository.createQueryBuilder('dlq')
        .where('dlq.webhook_id IN (:...webhookIds)', { webhookIds })
        .orderBy('dlq.failed_at', 'DESC')
        .getMany();
    }
    return this.dlqRepository.find({ order: { failed_at: 'DESC' } });
  }

  async retryDLQItem(dlqId: string): Promise<WebhookDelivery> {
    const dlqItem = await this.dlqRepository.findOne({ where: { id: dlqId } });
    if (!dlqItem) {
      throw new NotFoundException('DLQ item not found');
    }

    const webhook = await this.getWebhook(dlqItem.webhook_id);
    const delivery = await this.deliveryRepository.save(
      this.deliveryRepository.create({
        webhook_id: dlqItem.webhook_id,
        event_id: dlqItem.event_id || `evt_dlq_${Date.now()}`,
        event: dlqItem.event,
        payload: dlqItem.payload,
        status: WebhookDeliveryStatus.PENDING,
        attempts: 0,
      }),
    );

    await this.attemptDelivery(webhook, delivery);
    await this.dlqRepository.remove(dlqItem);

    return delivery;
  }

  async testWebhook(dto: TestWebhookDto): Promise<{
    success: boolean;
    status: number;
    response_body: string;
    signature: string;
    timestamp: number;
    latency_ms: number;
  }> {
    let url = dto.url;
    let secret = dto.secret;
    let headers: Record<string, string> = {};

    if (dto.webhook_id) {
      const webhook = await this.getWebhook(dto.webhook_id);
      url = webhook.url;
      secret = webhook.secret;
      headers = webhook.headers || {};
    }

    if (!url || !secret) {
      throw new Error('URL and secret are required to test a webhook');
    }

    const event = dto.event || 'test.ping';
    const payload = dto.payload || { test: true, timestamp: Date.now() };
    const body = JSON.stringify({ event, data: payload });
    const { signature, timestamp } = this.signatureService.generateSignature(payload, secret);

    const start = Date.now();
    try {
      const agent = url.startsWith('https') ? this.httpsAgent : this.httpAgent;
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          [SIGNATURE_HEADER]: signature,
          [TIMESTAMP_HEADER]: String(timestamp),
          ...headers,
        },
        body,
        // @ts-ignore
        agent,
      });

      const latency_ms = Date.now() - start;
      const responseText = await response.text();

      return {
        success: response.ok,
        status: response.status,
        response_body: responseText.slice(0, 1000),
        signature,
        timestamp,
        latency_ms,
      };
    } catch (error: any) {
      return {
        success: false,
        status: 0,
        response_body: error.message,
        signature,
        timestamp,
        latency_ms: Date.now() - start,
      };
    }
  }

  async getWebhookStats(merchantId?: string): Promise<{
    total_webhooks: number;
    active_webhooks: number;
    total_deliveries: number;
    successful_deliveries: number;
    failed_deliveries: number;
    pending_retries: number;
    dlq_count: number;
    success_rate: number;
    avg_latency_ms: number;
    p95_latency_ms: number;
    p99_latency_ms: number;
    deliveries_by_event: Record<string, number>;
    deliveries_by_status: Record<string, number>;
  }> {
    let webhooks: Webhook[];
    if (merchantId) {
      webhooks = await this.webhookRepository.find({ where: { merchant_id: merchantId } });
    } else {
      webhooks = await this.webhookRepository.find();
    }

    const total_webhooks = webhooks.length;
    const active_webhooks = webhooks.filter((w) => w.is_active).length;
    const webhookIds = webhooks.map((w) => w.id);

    if (webhookIds.length === 0) {
      return {
        total_webhooks: 0,
        active_webhooks: 0,
        total_deliveries: 0,
        successful_deliveries: 0,
        failed_deliveries: 0,
        pending_retries: 0,
        dlq_count: 0,
        success_rate: 100,
        avg_latency_ms: 0,
        p95_latency_ms: 0,
        p99_latency_ms: 0,
        deliveries_by_event: {},
        deliveries_by_status: {},
      };
    }

    const deliveries = await this.deliveryRepository.createQueryBuilder('delivery')
      .where('delivery.webhook_id IN (:...webhookIds)', { webhookIds })
      .getMany();

    const dlq_count = await this.dlqRepository.createQueryBuilder('dlq')
      .where('dlq.webhook_id IN (:...webhookIds)', { webhookIds })
      .getCount();

    const total_deliveries = deliveries.length;
    const successful_deliveries = deliveries.filter((d) => d.status === WebhookDeliveryStatus.SUCCESS).length;
    const failed_deliveries = deliveries.filter((d) => d.status === WebhookDeliveryStatus.FAILED || d.status === WebhookDeliveryStatus.DLQ).length;
    const pending_retries = deliveries.filter((d) => d.status === WebhookDeliveryStatus.RETRYING || d.status === WebhookDeliveryStatus.PENDING).length;

    const success_rate = total_deliveries > 0 ? Number(((successful_deliveries / total_deliveries) * 100).toFixed(2)) : 100;

    // Calculate latency metrics
    const successfulDeliveryTimes = deliveries
      .filter((d) => d.status === WebhookDeliveryStatus.SUCCESS && d.delivered_at && d.created_at)
      .map((d) => d.delivered_at!.getTime() - d.created_at.getTime());

    const avg_latency_ms = successfulDeliveryTimes.length > 0
      ? Number((successfulDeliveryTimes.reduce((a, b) => a + b, 0) / successfulDeliveryTimes.length).toFixed(2))
      : 0;

    const sortedTimes = [...successfulDeliveryTimes].sort((a, b) => a - b);
    const p95_latency_ms = sortedTimes.length > 0
      ? Number(sortedTimes[Math.floor(sortedTimes.length * 0.95)]?.toFixed(2) || 0)
      : 0;
    const p99_latency_ms = sortedTimes.length > 0
      ? Number(sortedTimes[Math.floor(sortedTimes.length * 0.99)]?.toFixed(2) || 0)
      : 0;

    // Group by event type
    const deliveries_by_event: Record<string, number> = {};
    deliveries.forEach((d) => {
      deliveries_by_event[d.event] = (deliveries_by_event[d.event] || 0) + 1;
    });

    // Group by status
    const deliveries_by_status: Record<string, number> = {};
    deliveries.forEach((d) => {
      deliveries_by_status[d.status] = (deliveries_by_status[d.status] || 0) + 1;
    });

    return {
      total_webhooks,
      active_webhooks,
      total_deliveries,
      successful_deliveries,
      failed_deliveries,
      pending_retries,
      dlq_count,
      success_rate,
      avg_latency_ms,
      p95_latency_ms,
      p99_latency_ms,
      deliveries_by_event,
      deliveries_by_status,
    };
  }

  @Cron(CronExpression.EVERY_MINUTE)
  async monitorQueueHealth(): Promise<void> {
    const queueStats = await this.webhookQueue.getJobCounts();
    this.metricsService.setQueueDepth(WEBHOOK_DELIVERY_QUEUE, queueStats.waiting + queueStats.active);
  }

  private async attemptDelivery(webhook: Webhook, delivery: WebhookDelivery): Promise<void> {
    const { signature, timestamp } = this.signatureService.generateSignature(delivery.payload, webhook.secret);
    const body = JSON.stringify({ event: delivery.event, data: delivery.payload });
    const start = Date.now();

    delivery.attempts += 1;
    delivery.last_attempted_at = new Date();

    const customHeaders = webhook.headers || {};
    const agent = webhook.url.startsWith('https') ? this.httpsAgent : this.httpAgent;

    try {
      const response = await this.metricsService.trackExternalCall(
        'webhook_delivery',
        'deliver',
        () =>
          fetch(webhook.url, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              [SIGNATURE_HEADER]: signature,
              [TIMESTAMP_HEADER]: String(timestamp),
              ...customHeaders,
            },
            body,
            // @ts-ignore
            agent,
          }),
      );

      delivery.response_status = response.status;
      delivery.response_body = (await response.text()).slice(0, 1000);

      if (response.ok) {
        delivery.status = WebhookDeliveryStatus.SUCCESS;
        delivery.delivered_at = new Date();
        delivery.next_retry_at = null;
      } else {
        await this.handleFailure(webhook, delivery, response.status, `Received status ${response.status}`);
      }
    } catch (error: any) {
      await this.handleFailure(webhook, delivery, null, error.message);
    }

    this.metricsService.recordQueueJob(
      WEBHOOK_DELIVERY_QUEUE,
      delivery.status === WebhookDeliveryStatus.SUCCESS ? 'success' : 'error',
      (Date.now() - start) / 1000,
    );

    await this.deliveryRepository.save(delivery);
  }

  private async handleFailure(
    webhook: Webhook,
    delivery: WebhookDelivery,
    statusCode: number | null,
    errorMessage: string,
  ): Promise<void> {
    delivery.error_message = errorMessage;

    const isRetryable = statusCode === null || defaultRetryConfig.retryableErrors.includes(statusCode);

    if (!isRetryable || delivery.attempts >= delivery.max_attempts) {
      delivery.status = WebhookDeliveryStatus.FAILED;
      delivery.next_retry_at = null;

      // Move to Dead Letter Queue (DLQ)
      await this.dlqRepository.save(
        this.dlqRepository.create({
          webhook_id: webhook.id,
          delivery_id: delivery.id,
          event_id: delivery.event_id,
          event: delivery.event,
          payload: delivery.payload,
          error_message: errorMessage,
          attempts: delivery.attempts,
          last_attempt_at: delivery.last_attempted_at || new Date(),
        }),
      );

      delivery.status = WebhookDeliveryStatus.DLQ;
      this.logger.warn(`Webhook delivery ${delivery.id} moved to DLQ: ${errorMessage}`);
      return;
    }

    const delay = calculateRetryDelay(delivery.attempts, defaultRetryConfig);
    delivery.status = WebhookDeliveryStatus.RETRYING;
    delivery.next_retry_at = new Date(Date.now() + delay);
  }

  static verifySignature(
    body: string,
    timestamp: string,
    signature: string,
    secret: string,
  ): boolean {
    const service = new WebhookSignatureService();
    try {
      const payload = JSON.parse(body);
      return service.verifySignature(payload, signature, secret, parseInt(timestamp, 10));
    } catch {
      const expected = crypto
        .createHmac('sha256', secret)
        .update(`${timestamp}.${body}`)
        .digest('hex');

      const expectedBuffer = Buffer.from(expected, 'hex');
      const providedBuffer = Buffer.from(signature, 'hex');

      if (expectedBuffer.length !== providedBuffer.length) {
        return false;
      }

      return crypto.timingSafeEqual(expectedBuffer, providedBuffer);
    }
  }
}
