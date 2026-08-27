import { Processor, Process, OnQueueActive, OnQueueCompleted, OnQueueFailed } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Webhook } from '../entities/webhook.entity';
import { WebhookDelivery, WebhookDeliveryStatus } from '../entities/webhook-delivery.entity';
import { WebhookDLQ } from '../entities/webhook-dlq.entity';
import { WebhookSignatureService } from '../services/webhook-signature.service';
import { MetricsService } from '../../common/metrics/metrics.service';
import { calculateRetryDelay, defaultRetryConfig, SIGNATURE_HEADER, TIMESTAMP_HEADER } from './webhook.service';
import * as http from 'http';
import * as https from 'https';

export const WEBHOOK_DELIVERY_QUEUE = 'webhook_delivery';

export interface WebhookDeliveryJobData {
  webhookId: string;
  deliveryId: string;
  event: string;
  payload: Record<string, any>;
  attempt: number;
}

@Processor(WEBHOOK_DELIVERY_QUEUE)
export class WebhookQueueProcessor {
  private readonly logger = new Logger(WebhookQueueProcessor.name);
  private readonly httpAgent: http.Agent;
  private readonly httpsAgent: https.Agent;

  constructor(
    @InjectRepository(Webhook)
    private webhookRepository: Repository<Webhook>,
    @InjectRepository(WebhookDelivery)
    private deliveryRepository: Repository<WebhookDelivery>,
    @InjectRepository(WebhookDLQ)
    private dlqRepository: Repository<WebhookDLQ>,
    private signatureService: WebhookSignatureService,
    private metricsService: MetricsService,
  ) {
    this.httpAgent = new http.Agent({ keepAlive: true, maxSockets: 100 });
    this.httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 100 });
  }

  @Process()
  async handleWebhookDelivery(job: Job<WebhookDeliveryJobData>) {
    const { webhookId, deliveryId, event, payload, attempt } = job.data;

    this.logger.log(`Processing webhook delivery job ${job.id}, attempt ${attempt}`);

    const webhook = await this.webhookRepository.findOne({ where: { id: webhookId } });
    if (!webhook) {
      throw new Error(`Webhook ${webhookId} not found`);
    }

    if (!webhook.is_active) {
      this.logger.log(`Webhook ${webhookId} is inactive, skipping delivery`);
      return { skipped: true, reason: 'webhook_inactive' };
    }

    const delivery = await this.deliveryRepository.findOne({ where: { id: deliveryId } });
    if (!delivery) {
      throw new Error(`Delivery ${deliveryId} not found`);
    }

    const { signature, timestamp } = this.signatureService.generateSignature(payload, webhook.secret);
    const body = JSON.stringify({ event, data: payload });
    const start = Date.now();

    delivery.attempts = attempt;
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
        await this.handleFailure(webhook, delivery, response.status, `Received status ${response.status}`, job);
      }
    } catch (error: any) {
      await this.handleFailure(webhook, delivery, null, error.message, job);
    }

    this.metricsService.recordQueueJob(
      WEBHOOK_DELIVERY_QUEUE,
      delivery.status === WebhookDeliveryStatus.SUCCESS ? 'success' : 'error',
      (Date.now() - start) / 1000,
    );

    await this.deliveryRepository.save(delivery);

    return {
      deliveryId: delivery.id,
      status: delivery.status,
      attempts: delivery.attempts,
    };
  }

  private async handleFailure(
    webhook: Webhook,
    delivery: WebhookDelivery,
    statusCode: number | null,
    errorMessage: string,
    job: Job<WebhookDeliveryJobData>,
  ): Promise<void> {
    delivery.error_message = errorMessage;

    const isRetryable = statusCode === null || defaultRetryConfig.retryableErrors.includes(statusCode);

    if (!isRetryable || job.data.attempt >= delivery.max_attempts) {
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

    const delay = calculateRetryDelay(job.data.attempt + 1, defaultRetryConfig);
    delivery.status = WebhookDeliveryStatus.RETRYING;
    delivery.next_retry_at = new Date(Date.now() + delay);

    // Update job with next attempt
    await job.updateData({
      ...job.data,
      attempt: job.data.attempt + 1,
    });

    // Schedule retry
    await job.moveToDelayed(Date.now() + delay);
  }

  @OnQueueActive()
  onActive(job: Job<WebhookDeliveryJobData>) {
    this.logger.debug(`Processing job ${job.id} of type ${job.name}`);
  }

  @OnQueueCompleted()
  onCompleted(job: Job<WebhookDeliveryJobData>, result: any) {
    this.logger.debug(`Completed job ${job.id} with result:`, result);
  }

  @OnQueueFailed()
  onFailed(job: Job<WebhookDeliveryJobData>, error: Error) {
    this.logger.error(`Failed job ${job.id} with error: ${error.message}`);
  }
}
