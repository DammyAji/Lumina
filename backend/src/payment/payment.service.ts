import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Payment, PaymentCurrency, PaymentStatus } from './entities/payment.entity';
import { Merchant } from './entities/merchant.entity';
import { CreatePaymentDto } from './dto/create-payment.dto';
import { ConversionEngineService } from '../conversion-engine/conversion-engine.service';
import { ConversionAsset } from '../conversion-engine/asset.enum';
import { PaymentException } from '../common/exceptions';
import { MetricsService } from '../common/metrics/metrics.service';
import { TracingService } from '../common/tracing/tracing.service';
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
    private tracingService: TracingService,
  ) {}

  async create(createPaymentDto: CreatePaymentDto): Promise<Payment> {
    return this.tracer.startActiveSpan('payment.create', async (span) => {
      try {
        span.setAttribute('payment.merchant_address', createPaymentDto.merchant_address);
        span.setAttribute('payment.amount', createPaymentDto.amount);
        span.setAttribute('payment.currency', createPaymentDto.currency);

        // Merchant validation sub-span
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
          expires_at: new Date(Date.now() + 30 * 60 * 1000), // 30 minutes
        });

        // Database save sub-span
        const savedPayment = await this.tracer.startActiveSpan('payment.save', async (saveSpan) => {
          const saved = await this.paymentRepository.save(payment);
          saveSpan.setAttribute('payment.id', saved.payment_id);
          saveSpan.end();
          return saved;
        });

        this.metricsService.recordPayment(savedPayment.currency, savedPayment.status, savedPayment.amount);

        span.setAttribute('payment.id', savedPayment.payment_id);
        span.setAttribute('payment.status', savedPayment.status);

        if (savedPayment.currency !== PaymentCurrency.USDC) {
          // Conversion sub-span
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
    return updatedPayment;
  }

  private generatePaymentId(): string {
    return `pay_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }
}
