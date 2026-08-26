import { IsArray, IsNumber, IsOptional, IsString, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { WebSocketEventType } from '../enums/websocket-event.enum';

export class EventFilterDto {
  @IsOptional()
  @IsString()
  paymentId?: string;

  @IsOptional()
  @IsString()
  merchantId?: string;

  @IsOptional()
  @IsNumber()
  minAmount?: number;

  @IsOptional()
  @IsNumber()
  maxAmount?: number;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  currencies?: string[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  statuses?: string[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  eventTypes?: WebSocketEventType[];
}

export class SubscribeDto {
  @IsString()
  channel: string;

  @IsOptional()
  @IsString()
  room?: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => EventFilterDto)
  filter?: EventFilterDto;
}

export class UnsubscribeDto {
  @IsString()
  channel: string;

  @IsOptional()
  @IsString()
  room?: string;
}

export class AuthenticateWsDto {
  /** Optional short-lived scope hint for the issued WS token */
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  channels?: string[];
}
