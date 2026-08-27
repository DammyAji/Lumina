import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { JwtModule } from '@nestjs/jwt';
import type { SignOptions } from 'jsonwebtoken';
import { WebSocketConnection } from './entities/websocket-connection.entity';
import { User } from '../auth/entities/user.entity';
import { AuthModule } from '../auth/auth.module';
import { MetricsModule } from '../common/metrics/metrics.module';
import { PaymentEventsGateway } from './payment-events.gateway';
import { WebSocketController } from './websocket.controller';
import { ConnectionManagerService } from './services/connection-manager.service';
import { SubscriptionManagerService } from './services/subscription-manager.service';
import { EventPublisherService } from './services/event-publisher.service';
import { WebSocketAuthService } from './services/websocket-auth.service';
import { WebSocketRateLimitService } from './services/websocket-rate-limit.service';
import { OfflineBufferService } from './services/offline-buffer.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([WebSocketConnection, User]),
    JwtModule.register({
      secret: process.env.JWT_SECRET,
      signOptions: {
        expiresIn: (process.env.JWT_ACCESS_EXPIRY || '15m') as SignOptions['expiresIn'],
      },
    }),
    AuthModule,
    MetricsModule,
  ],
  controllers: [WebSocketController],
  providers: [
    PaymentEventsGateway,
    ConnectionManagerService,
    SubscriptionManagerService,
    EventPublisherService,
    WebSocketAuthService,
    WebSocketRateLimitService,
    OfflineBufferService,
  ],
  exports: [EventPublisherService, ConnectionManagerService, SubscriptionManagerService],
})
export class WebsocketModule {}
