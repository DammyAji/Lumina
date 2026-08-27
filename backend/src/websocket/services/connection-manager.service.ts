import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { WebSocketConnection } from '../entities/websocket-connection.entity';
import { ConnectionMeta, EventFilter } from '../interfaces/websocket.interfaces';

const HEARTBEAT_STALE_MS = 90_000;

@Injectable()
export class ConnectionManagerService implements OnModuleDestroy {
  private readonly logger = new Logger(ConnectionManagerService.name);
  private readonly connections = new Map<string, ConnectionMeta>();
  private cleanupTimer: NodeJS.Timeout | null = null;

  constructor(
    @InjectRepository(WebSocketConnection)
    private readonly connectionRepository: Repository<WebSocketConnection>,
  ) {
    this.cleanupTimer = setInterval(() => {
      void this.cleanupStaleConnections();
    }, 60_000);
    this.cleanupTimer.unref();
  }

  onModuleDestroy(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }

  async register(meta: Omit<ConnectionMeta, 'subscriptions' | 'messageCount' | 'lastPing'>): Promise<ConnectionMeta> {
    const connection: ConnectionMeta = {
      ...meta,
      lastPing: new Date(),
      subscriptions: new Map(),
      messageCount: 0,
    };

    this.connections.set(meta.connectionId, connection);

    try {
      await this.connectionRepository.save(
        this.connectionRepository.create({
          user_id: meta.userId,
          merchant_id: meta.merchantId ?? null,
          connection_id: meta.connectionId,
          connected_at: meta.connectedAt,
          last_ping: connection.lastPing,
          subscriptions: [],
          ip_address: meta.ipAddress ?? null,
          user_agent: meta.userAgent ?? null,
          is_active: true,
        }),
      );
    } catch (error) {
      this.logger.warn(
        `Failed to persist websocket connection ${meta.connectionId}: ${(error as Error).message}`,
      );
    }

    this.logger.log(`Connection registered: ${meta.connectionId} (user=${meta.userId})`);
    return connection;
  }

  get(connectionId: string): ConnectionMeta | undefined {
    return this.connections.get(connectionId);
  }

  getAll(): ConnectionMeta[] {
    return Array.from(this.connections.values());
  }

  count(): number {
    return this.connections.size;
  }

  touch(connectionId: string): void {
    const conn = this.connections.get(connectionId);
    if (!conn) return;
    conn.lastPing = new Date();
  }

  incrementMessageCount(connectionId: string): number {
    const conn = this.connections.get(connectionId);
    if (!conn) return 0;
    conn.messageCount += 1;
    return conn.messageCount;
  }

  setRateLimitedUntil(connectionId: string, untilMs: number): void {
    const conn = this.connections.get(connectionId);
    if (!conn) return;
    conn.rateLimitedUntil = untilMs;
  }

  updateSubscriptions(connectionId: string, subscriptions: Map<string, EventFilter>): void {
    const conn = this.connections.get(connectionId);
    if (!conn) return;
    conn.subscriptions = subscriptions;

    void this.connectionRepository
      .update(
        { connection_id: connectionId },
        { subscriptions: Array.from(subscriptions.keys()), last_ping: conn.lastPing },
      )
      .catch((error) => {
        this.logger.warn(
          `Failed to update subscriptions for ${connectionId}: ${(error as Error).message}`,
        );
      });
  }

  async unregister(connectionId: string): Promise<void> {
    this.connections.delete(connectionId);

    try {
      await this.connectionRepository.update(
        { connection_id: connectionId },
        { is_active: false, last_ping: new Date() },
      );
    } catch (error) {
      this.logger.warn(
        `Failed to mark connection inactive ${connectionId}: ${(error as Error).message}`,
      );
    }

    this.logger.log(`Connection unregistered: ${connectionId}`);
  }

  private async cleanupStaleConnections(): Promise<void> {
    const now = Date.now();
    const stale: string[] = [];

    for (const [id, conn] of this.connections.entries()) {
      if (now - conn.lastPing.getTime() > HEARTBEAT_STALE_MS) {
        stale.push(id);
      }
    }

    for (const id of stale) {
      this.logger.warn(`Cleaning stale websocket connection ${id}`);
      await this.unregister(id);
    }
  }
}
