import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { PaymentException } from '../common/exceptions';
import { PaymentService } from './payment.service';
import { Payment, PaymentCurrency } from './entities/payment.entity';
import { Merchant } from './entities/merchant.entity';
import { ConversionEngineService } from '../conversion-engine/conversion-engine.service';
import { ConversionAsset } from '../conversion-engine/asset.enum';
import { MetricsService } from '../common/metrics/metrics.service';
import { EventPublisherService } from '../websocket/services/event-publisher.service';

describe('PaymentService', () => {
  let service: PaymentService;
  let paymentRepository: { create: jest.Mock; save: jest.Mock; findOne: jest.Mock };
  let merchantRepository: { findOne: jest.Mock };
  let conversionEngineService: { executeConversion: jest.Mock };
  let metricsService: { recordPayment: jest.Mock };
  let eventPublisher: { publish: jest.Mock };

  beforeEach(async () => {
    paymentRepository = {
      create: jest.fn((data) => data),
      save: jest.fn(async (entity) => ({ ...entity, id: 'payment-uuid' })),
      findOne: jest.fn(),
    };
    merchantRepository = { findOne: jest.fn() };
    conversionEngineService = {
      executeConversion: jest.fn().mockResolvedValue(undefined),
    };
    metricsService = { recordPayment: jest.fn() };
    eventPublisher = { publish: jest.fn().mockResolvedValue({ event_id: 'e1' }) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PaymentService,
        { provide: getRepositoryToken(Payment), useValue: paymentRepository },
        { provide: getRepositoryToken(Merchant), useValue: merchantRepository },
        { provide: ConversionEngineService, useValue: conversionEngineService },
        { provide: MetricsService, useValue: metricsService },
        { provide: EventPublisherService, useValue: eventPublisher },
      ],
    }).compile();

    service = module.get<PaymentService>(PaymentService);
  });

  it('throws PaymentException when the merchant does not exist', async () => {
    merchantRepository.findOne.mockResolvedValue(null);

    await expect(
      service.create({
        merchant_address: 'unknown',
        amount: 1,
        currency: PaymentCurrency.BTC,
      }),
    ).rejects.toThrow(PaymentException);
  });

  it('triggers a conversion for a non-USDC payment', async () => {
    merchantRepository.findOne.mockResolvedValue({ id: 'm1', stellar_address: 'merchant-1' });

    const payment = await service.create({
      merchant_address: 'merchant-1',
      amount: 0.5,
      currency: PaymentCurrency.BTC,
    });

    await new Promise((resolve) => setImmediate(resolve));

    expect(conversionEngineService.executeConversion).toHaveBeenCalledWith(
      payment.payment_id,
      PaymentCurrency.BTC,
      ConversionAsset.USDC,
    );
    expect(eventPublisher.publish).toHaveBeenCalled();
  });

  it('does not trigger a conversion for a USDC payment', async () => {
    merchantRepository.findOne.mockResolvedValue({ id: 'm1', stellar_address: 'merchant-1' });

    await service.create({
      merchant_address: 'merchant-1',
      amount: 10,
      currency: PaymentCurrency.USDC,
    });

    await new Promise((resolve) => setImmediate(resolve));

    expect(conversionEngineService.executeConversion).not.toHaveBeenCalled();
    expect(eventPublisher.publish).toHaveBeenCalled();
  });
});
