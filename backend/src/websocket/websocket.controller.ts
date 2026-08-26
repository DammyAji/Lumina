import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { AuthenticatedUser } from '../auth/interfaces/jwt-payload.interface';
import { SubscriptionManagerService } from './services/subscription-manager.service';
import { WebSocketAuthService } from './services/websocket-auth.service';
import { ConnectionManagerService } from './services/connection-manager.service';
import { AuthenticateWsDto } from './dto/websocket.dto';

@Controller('ws')
export class WebSocketController {
  constructor(
    private readonly subscriptionManager: SubscriptionManagerService,
    private readonly authService: WebSocketAuthService,
    private readonly connectionManager: ConnectionManagerService,
  ) {}

  /** List available WebSocket channels and their event types. */
  @Get('channels')
  listChannels() {
    return {
      endpoint: '/ws',
      protocol: 'socket.io',
      channels: this.subscriptionManager.listChannels(),
      docs: '/docs/WEBSOCKETS.md',
    };
  }

  /** Issue a short-lived token for WebSocket handshake. */
  @UseGuards(JwtAuthGuard)
  @Post('authenticate')
  authenticate(@CurrentUser() user: AuthenticatedUser, @Body() body: AuthenticateWsDto) {
    const result = this.authService.issueWsToken(
      {
        id: user.userId,
        email: user.email,
        role: user.role,
        merchant_id: user.merchantId,
      },
      body.channels,
    );

    return {
      token: result.token,
      expires_in: result.expires_in,
      namespace: '/ws',
      url: process.env.WS_PUBLIC_URL || process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000',
    };
  }

  /** Connection health / metrics snapshot for operators. */
  @UseGuards(JwtAuthGuard)
  @Get('stats')
  stats() {
    const connections = this.connectionManager.getAll();
    return {
      active_connections: connections.length,
      by_merchant: connections.reduce<Record<string, number>>((acc, c) => {
        const key = c.merchantId || 'unknown';
        acc[key] = (acc[key] || 0) + 1;
        return acc;
      }, {}),
      subscriptions: connections.reduce((sum, c) => sum + c.subscriptions.size, 0),
    };
  }
}
