import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Socket } from 'socket.io';
import { User } from '../../auth/entities/user.entity';
import { JwtPayload } from '../../auth/interfaces/jwt-payload.interface';
import { TokenService } from '../../auth/services/token.service';
import { ApiKeyService } from '../../auth/services/api-key.service';

export interface WsAuthContext {
  userId: string;
  email?: string;
  merchantId?: string;
  role?: string;
  jti?: string;
  authMethod: 'jwt' | 'ws_token' | 'api_key';
}

@Injectable()
export class WebSocketAuthService {
  private readonly logger = new Logger(WebSocketAuthService.name);

  constructor(
    private readonly jwtService: JwtService,
    private readonly tokenService: TokenService,
    private readonly apiKeyService: ApiKeyService,
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
  ) {}

  /**
   * Issues a short-lived token intended only for WebSocket handshake
   * (scope claim `ws`).
   */
  issueWsToken(
    user: {
      id: string;
      email: string;
      role: string;
      merchant_id?: string | null;
    },
    channels?: string[],
  ): { token: string; expires_in: number } {
    const expiresIn = process.env.WS_TOKEN_EXPIRY || '5m';
    const token = this.jwtService.sign(
      {
        sub: user.id,
        email: user.email,
        role: user.role,
        merchant_id: user.merchant_id ?? undefined,
        jti: `ws_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        scope: 'ws',
        channels: channels ?? [],
      },
      { expiresIn: expiresIn as any },
    );

    const decoded = this.jwtService.decode(token) as { exp: number };
    return { token, expires_in: decoded.exp };
  }

  async authenticateSocket(client: Socket): Promise<WsAuthContext> {
    const token =
      (client.handshake.auth?.token as string | undefined) ||
      this.extractBearer(client.handshake.headers.authorization) ||
      (client.handshake.query?.token as string | undefined);

    const apiKey =
      (client.handshake.auth?.apiKey as string | undefined) ||
      (client.handshake.headers['x-api-key'] as string | undefined);

    if (token) {
      return this.authenticateJwt(token);
    }

    if (apiKey) {
      return this.authenticateApiKey(apiKey);
    }

    throw new UnauthorizedException('WebSocket authentication required (JWT or API key)');
  }

  private async authenticateJwt(token: string): Promise<WsAuthContext> {
    let payload: JwtPayload & { scope?: string };
    try {
      payload = this.jwtService.verify(token, {
        secret: process.env.JWT_SECRET,
      }) as JwtPayload & { scope?: string };
    } catch (error) {
      this.logger.warn(`Invalid WS JWT: ${(error as Error).message}`);
      throw new UnauthorizedException('Invalid or expired token');
    }

    if (payload.jti && !payload.jti.startsWith('ws_')) {
      const blacklisted = await this.tokenService.isAccessTokenBlacklisted(payload.jti);
      if (blacklisted) {
        throw new UnauthorizedException('Token has been revoked');
      }
    }

    const user = await this.userRepository.findOne({ where: { id: payload.sub } });
    if (!user) {
      throw new UnauthorizedException('User not found');
    }

    return {
      userId: payload.sub,
      email: payload.email,
      merchantId: payload.merchant_id ?? user.merchant_id ?? undefined,
      role: payload.role,
      jti: payload.jti,
      authMethod: payload.scope === 'ws' ? 'ws_token' : 'jwt',
    };
  }

  private async authenticateApiKey(rawKey: string): Promise<WsAuthContext> {
    try {
      const key = await this.apiKeyService.validate(rawKey);
      return {
        userId: key.merchant_id,
        merchantId: key.merchant_id,
        role: 'api_key',
        authMethod: 'api_key',
      };
    } catch {
      throw new UnauthorizedException('Invalid API key');
    }
  }

  private extractBearer(header?: string): string | undefined {
    if (!header) return undefined;
    const [scheme, value] = header.split(' ');
    if (scheme?.toLowerCase() !== 'bearer' || !value) return undefined;
    return value;
  }
}
