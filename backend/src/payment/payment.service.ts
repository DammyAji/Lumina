import { Injectable, Logger, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Payment, PaymentCurrency, PaymentStatus } from './entities/payment.entity';
import { Merchant } from './entities/merchant.entity';
import { CreatePaymentDto } from './dto/create-payment.dto';
import { ConversionEngineService } from '../conversion-engine/conversion-engine.service';
import { ConversionAsset } from '../conversion-engine/asset.enum';
import { PaymentException } from '../common/exceptions';
import { MetricsService } from '../common/metrics/metrics.service';
import { EventPublisherService } from '../websocket/services/event-publisher.service';
import { WebSocketEventType } from '../websocket/enums/websocket-event.enum';
import { OfflineBufferService } from '../websocket/services/offline-buffer.service';
import { ConnectionManagerService } from '../websocket/services/connection-manager.service';
import { trace, SpanStatusCode } from '@opentelemetry/api';

@Injectable()
export class PaymentService {
  private readonly logger = new Logger(PaymentService.name);
  private readonly tracer = trace.getTracer('lumina-payment-service');

  constructor(
    @InjectRepository(Payment)
    private paymentRepository: Repository<Payment>,
    @InjectRepository(Merchant)
    private merchantRepository: Repository<Merchant>,
    private conversionEngineService: ConversionEngineService,
    private metricsService: MetricsService,
    @Optional() private readonly eventPublisher?: EventPublisherService,
    @Optional() private readonly offlineBuffer?: OfflineBufferService,
    @Optional() private readonly connectionManager?: ConnectionManagerService,
  ) {}

  async create(createPaymentDto: CreatePaymentDto): Promise<Payment> {
    return this.tracer.startActiveSpan('payment.create', async (span) => {
      try {
        span.setAttribute('payment.merchant_address', createPaymentDto.merchant_address);
        span.setAttribute('payment.amount', createPaymentDto.amount);
        span.setAttribute('payment.currency', createPaymentDto.currency);

        const merchant = await this.tracer.startActiveSpan('payment.validate_merchant', async (validationSpan) => {
          const merchant = await this.merchantRepository.findOne({
            where: { stellar_address: createPaymentDto.merchant_address },
          });

          if (!merchant) {
            validationSpan.setStatus({
              code: SpanStatusCode.ERROR,
              message: 'Merchant not found',
            });
            throw PaymentException.merchantNotFound(createPaymentDto.merchant_address);
          }

          validationSpan.setAttribute('merchant.id', merchant.id);
          validationSpan.end();
          return merchant;
        });

        const payment = this.paymentRepository.create({
          ...createPaymentDto,
          status: PaymentStatus.PENDING,
          payment_id: this.generatePaymentId(),
          expires_at: new Date(Date.now() + 30 * 60 * 1000),
        });

        const savedPayment = await this.tracer.startActiveSpan('payment.save', async (saveSpan) => {
          const saved = await this.paymentRepository.save(payment);
          saveSpan.setAttribute('payment.id', saved.payment_id);
          saveSpan.end();
          return saved;
        });

        this.metricsService.recordPayment(savedPayment.currency, savedPayment.status, savedPayment.amount);

        span.setAttribute('payment.id', savedPayment.payment_id);
        span.setAttribute('payment.status', savedPayment.status);

        await this.publishPaymentEvent(WebSocketEventType.PAYMENT_CREATED, savedPayment, merchant.id);

        if (savedPayment.currency !== PaymentCurrency.USDC) {
          await this.tracer.startActiveSpan('payment.trigger_conversion', async (conversionSpan) => {
            conversionSpan.setAttribute('conversion.from', savedPayment.currency);
            conversionSpan.setAttribute('conversion.to', 'USDC');

            this.conversionEngineService
              .executeConversion(
                savedPayment.payment_id,
                savedPayment.currency as unknown as ConversionAsset,
                ConversionAsset.USDC,
              )
              .catch((error) => {
                conversionSpan.recordException(error);
                this.logger.error(
                  `Conversion failed for payment ${savedPayment.payment_id}: ${error.message}`,
                );
              });

            conversionSpan.end();
          });
        }

        return savedPayment;
      } catch (error) {
        span.recordException(error as Error);
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: (error as Error).message,
        });
        throw error;
      } finally {
        span.end();
      }
    });
  }

  async findAll(merchantAddress?: string): Promise<Payment[]> {
    if (merchantAddress) {
      return this.paymentRepository.find({
        where: { merchant_address: merchantAddress },
        order: { created_at: 'DESC' },
      });
    }
    return this.paymentRepository.find({ order: { created_at: 'DESC' } });
  }

  async findOne(paymentId: string): Promise<Payment> {
    const payment = await this.paymentRepository.findOne({
      where: { payment_id: paymentId },
    });

    if (!payment) {
      throw PaymentException.notFound(paymentId);
    }

    return payment;
  }

  async updateStatus(paymentId: string, status: PaymentStatus, transactionHash?: string): Promise<Payment> {
    const payment = await this.findOne(paymentId);

    payment.status = status;
    if (transactionHash) {
      payment.transaction_hash = transactionHash;
    }

    const updatedPayment = await this.paymentRepository.save(payment);
    this.metricsService.recordPayment(updatedPayment.currency, updatedPayment.status, updatedPayment.amount);

    const merchant = await this.merchantRepository.findOne({
      where: { stellar_address: updatedPayment.merchant_address },
    });

    const eventType = this.mapStatusToEvent(status);
    if (eventType) {
      await this.publishPaymentEvent(eventType, updatedPayment, merchant?.id);
    }

    return updatedPayment;
  }

  private mapStatusToEvent(status: PaymentStatus): WebSocketEventType | null {
    switch (status) {
      case PaymentStatus.CONFIRMED:
        return WebSocketEventType.PAYMENT_CONFIRMED;
      case PaymentStatus.FAILED:
        return WebSocketEventType.PAYMENT_FAILED;
      case PaymentStatus.EXPIRED:
        return WebSocketEventType.PAYMENT_FAILED;
      case PaymentStatus.PENDING:
        return WebSocketEventType.PAYMENT_CREATED;
      default:
        return null;
    }
  }

  private async publishPaymentEvent(
    type: WebSocketEventType,
    payment: Payment,
    merchantId?: string,
  ): Promise<void> {
    if (!this.eventPublisher) return;

    try {
      const event = await this.eventPublisher.publish(type, {
        payment_id: payment.payment_id,
        merchant_id: merchantId,
        merchant_address: payment.merchant_address,
        amount: Number(payment.amount),
        currency: payment.currency,
        status: payment.status,
        transaction_hash: payment.transaction_hash,
      });

      if (merchantId && this.offlineBuffer && this.connectionManager) {
        const live = this.connectionManager.getAll().some((c) => c.merchantId === merchantId);
        if (!live) {
          this.offlineBuffer.buffer(merchantId, event);
        }
      }
    } catch (error) {
      this.logger.warn(
        `Failed to publish WebSocket event ${type} for ${payment.payment_id}: ${(error as Error).message}`,
      );
    }
  }

  private generatePaymentId(): string {
    return `pay_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }
}
