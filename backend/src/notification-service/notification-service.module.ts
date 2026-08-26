import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BullModule } from '@nestjs/bullmq';
import { NotificationServiceController } from './notification-service.controller';
import { NotificationServiceService } from './notification-service.service';
import { WebhookService } from './webhook/webhook.service';
import { WebhookQueueProcessor, WEBHOOK_DELIVERY_QUEUE } from './webhook/webhook-queue.processor';
import { EmailService } from './email/email.service';
import { EventFilterService } from './services/event-filter.service';
import { WebhookSignatureService } from './services/webhook-signature.service';
import { Webhook } from './entities/webhook.entity';
import { WebhookDelivery } from './entities/webhook-delivery.entity';
import { WebhookDLQ } from './entities/webhook-dlq.entity';
import { Merchant } from '../payment/entities/merchant.entity';
import { MetricsModule } from '../common/metrics/metrics.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([Webhook, WebhookDelivery, WebhookDLQ, Merchant]),
    MetricsModule,
    BullModule.forRoot({
      connection: {
        host: process.env.REDIS_HOST || 'localhost',
        port: parseInt(process.env.REDIS_PORT || '6379', 10),
      },
    }),
    BullModule.registerQueue({
      name: WEBHOOK_DELIVERY_QUEUE,
      defaultJobOptions: {
        attempts: 5,
        backoff: {
          type: 'exponential',
          delay: 1000,
        },
        removeOnComplete: {
          count: 1000,
          age: 24 * 3600,
        },
        removeOnFail: {
          count: 5000,
        },
      },
    }),
  ],
  controllers: [NotificationServiceController],
  providers: [
    NotificationServiceService,
    WebhookService,
    WebhookQueueProcessor,
    EmailService,
    EventFilterService,
    WebhookSignatureService,
  ],
  exports: [NotificationServiceService, WebhookService, EventFilterService, WebhookSignatureService],
})
export class NotificationServiceModule {}
