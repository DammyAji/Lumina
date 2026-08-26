import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { Logger, OnModuleInit, UsePipes, ValidationPipe } from '@nestjs/common';
import { Server, Socket } from 'socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import Redis from 'ioredis';
import { ConnectionManagerService } from './services/connection-manager.service';
import { SubscriptionManagerService } from './services/subscription-manager.service';
import { EventPublisherService } from './services/event-publisher.service';
import { WebSocketAuthService } from './services/websocket-auth.service';
import { WebSocketRateLimitService } from './services/websocket-rate-limit.service';
import { OfflineBufferService } from './services/offline-buffer.service';
import { SubscribeDto, UnsubscribeDto } from './dto/websocket.dto';
import { PaymentEventPayload } from './interfaces/websocket.interfaces';
import { MetricsService } from '../common/metrics/metrics.service';

@WebSocketGateway({
  namespace: '/ws',
  cors: { origin: true, credentials: true },
  pingInterval: 25_000,
  pingTimeout: 20_000,
  transports: ['websocket', 'polling'],
  perMessageDeflate: true,
})
@UsePipes(new ValidationPipe({ whitelist: true, transform: true }))
export class PaymentEventsGateway
  implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect, OnModuleInit
{
  private readonly logger = new Logger(PaymentEventsGateway.name);

  @WebSocketServer()
  server: Server;

  constructor(
    private readonly connectionManager: ConnectionManagerService,
    private readonly subscriptionManager: SubscriptionManagerService,
    private readonly eventPublisher: EventPublisherService,
    private readonly authService: WebSocketAuthService,
    private readonly rateLimitService: WebSocketRateLimitService,
    private readonly offlineBuffer: OfflineBufferService,
    private readonly metricsService: MetricsService,
  ) {}

  onModuleInit(): void {
    this.eventPublisher.setEmitHandler((event, rooms) => this.emitEvent(event, rooms));
  }

  afterInit(server: Server): void {
    this.server = server;
    void this.attachRedisAdapter(server);
    this.logger.log('Payment WebSocket gateway initialized on namespace /ws');
  }

  async handleConnection(client: Socket): Promise<void> {
    try {
      const auth = await this.authService.authenticateSocket(client);
      const userConnections = this.connectionManager
        .getAll()
        .filter((c) => c.userId === auth.userId).length;

      if (!this.rateLimitService.allowNewConnection(auth.userId, userConnections)) {
        client.emit('error', {
          code: 'CONNECTION_LIMIT',
          message: 'Maximum concurrent WebSocket connections exceeded',
        });
        client.disconnect(true);
        this.metricsService.recordWebSocketConnectionError('connection_limit');
        return;
      }

      const ip =
        (client.handshake.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() ||
        client.handshake.address;
      const userAgent = client.handshake.headers['user-agent'];

      await this.connectionManager.register({
        connectionId: client.id,
        userId: auth.userId,
        merchantId: auth.merchantId,
        role: auth.role,
        ipAddress: ip,
        userAgent,
        connectedAt: new Date(),
      });

      (client.data as any).auth = auth;

      if (auth.merchantId) {
        await client.join(`merchant.${auth.merchantId}`);
      }
      await client.join(`user.${auth.userId}`);

      const buffered = this.offlineBuffer.flush(auth.userId);
      for (const event of buffered) {
        client.emit('event', event);
      }

      client.emit('connected', {
        connection_id: client.id,
        user_id: auth.userId,
        merchant_id: auth.merchantId,
        auth_method: auth.authMethod,
        replayed_events: buffered.length,
        server_time: new Date().toISOString(),
      });

      this.metricsService.setWebSocketConnections(this.connectionManager.count());
      this.logger.log(`Client connected: ${client.id} (user=${auth.userId})`);
    } catch (error) {
      this.logger.warn(`WS auth failed for ${client.id}: ${(error as Error).message}`);
      client.emit('error', {
        code: 'AUTH_FAILED',
        message: (error as Error).message || 'Authentication failed',
      });
      this.metricsService.recordWebSocketConnectionError('auth_failed');
      client.disconnect(true);
    }
  }

  async handleDisconnect(client: Socket): Promise<void> {
    this.rateLimitService.clear(client.id);
    await this.connectionManager.unregister(client.id);
    this.metricsService.setWebSocketConnections(this.connectionManager.count());
    this.logger.log(`Client disconnected: ${client.id}`);
  }

  @SubscribeMessage('ping')
  handlePing(@ConnectedSocket() client: Socket): { event: string; data: { pong: boolean; ts: string } } {
    this.connectionManager.touch(client.id);
    return { event: 'pong', data: { pong: true, ts: new Date().toISOString() } };
  }

  @SubscribeMessage('subscribe')
  handleSubscribe(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: SubscribeDto,
  ): { event: string; data: Record<string, unknown> } {
    const limited = this.enforceRateLimit(client);
    if (limited) return limited;

    try {
      const { key, room } = this.subscriptionManager.subscribe(client.id, body);
      void client.join(room);
      return {
        event: 'subscribed',
        data: { key, room, channel: body.channel, filter: body.filter ?? null },
      };
    } catch (error) {
      return {
        event: 'error',
        data: { code: 'SUBSCRIBE_FAILED', message: (error as Error).message },
      };
    }
  }

  @SubscribeMessage('unsubscribe')
  handleUnsubscribe(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: UnsubscribeDto,
  ): { event: string; data: Record<string, unknown> } {
    const limited = this.enforceRateLimit(client);
    if (limited) return limited;

    try {
      const room = this.subscriptionManager.unsubscribe(client.id, body.channel, body.room);
      void client.leave(room);
      return {
        event: 'unsubscribed',
        data: { channel: body.channel, room },
      };
    } catch (error) {
      return {
        event: 'error',
        data: { code: 'UNSUBSCRIBE_FAILED', message: (error as Error).message },
      };
    }
  }

  /**
   * Emit to Socket.IO rooms and apply per-connection filters.
   */
  emitEvent(event: PaymentEventPayload, rooms: string[]): void {
    if (!this.server) return;

    const targetRooms = new Set(rooms);
    targetRooms.add(`channel:${event.channel}`);

    const deliveredTo = new Set<string>();

    for (const room of targetRooms) {
      const sockets = this.server.sockets.adapter.rooms.get(room);
      if (!sockets) continue;

      for (const socketId of sockets) {
        if (deliveredTo.has(socketId)) continue;

        const conn = this.connectionManager.get(socketId);
        if (!conn) {
          // Socket may exist on another node via Redis adapter — emit to room once later
          continue;
        }

        if (conn.subscriptions.size > 0) {
          let allowed = false;
          for (const filter of conn.subscriptions.values()) {
            if (this.subscriptionManager.matchesFilter(event, filter)) {
              allowed = true;
              break;
            }
          }
          if (!allowed) continue;
        } else if (conn.merchantId) {
          const merchantMatch =
            event.data.merchant_id === conn.merchantId ||
            event.data.merchant_address === conn.merchantId;
          if (!merchantMatch) continue;
        }

        this.server.to(socketId).emit('event', event);
        deliveredTo.add(socketId);
      }
    }

    // Cross-node fan-out: emit to rooms so sockets on other instances receive events
    if (deliveredTo.size === 0) {
      for (const room of targetRooms) {
        this.server.to(room).emit('event', event);
      }
    }

    this.metricsService.recordWebSocketEventDelivered(event.type, Math.max(deliveredTo.size, 1));
  }

  private enforceRateLimit(client: Socket): { event: string; data: Record<string, unknown> } | null {
    const result = this.rateLimitService.allowMessage(client.id);
    if (!result.allowed) {
      this.connectionManager.setRateLimitedUntil(
        client.id,
        Date.now() + (result.retryAfterMs || 60_000),
      );
      this.metricsService.recordWebSocketConnectionError('rate_limited');
      return {
        event: 'error',
        data: {
          code: 'RATE_LIMITED',
          message: 'Too many WebSocket messages',
          retry_after_ms: result.retryAfterMs,
        },
      };
    }
    this.connectionManager.incrementMessageCount(client.id);
    this.connectionManager.touch(client.id);
    return null;
  }

  private async attachRedisAdapter(server: Server): Promise<void> {
    const host = process.env.REDIS_HOST || 'localhost';
    const port = parseInt(process.env.REDIS_PORT || '6379', 10);

    try {
      const pubClient = new Redis({ host, port, maxRetriesPerRequest: 1, lazyConnect: true });
      const subClient = pubClient.duplicate();
      await Promise.all([pubClient.connect(), subClient.connect()]);
      server.adapter(createAdapter(pubClient, subClient));
      this.logger.log(`Socket.IO Redis adapter attached (${host}:${port})`);
    } catch (error) {
      this.logger.warn(
        `Socket.IO Redis adapter unavailable; single-instance mode: ${(error as Error).message}`,
      );
    }
  }
}
