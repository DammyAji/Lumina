import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';

@Entity('websocket_connections')
export class WebSocketConnection {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @Column()
  user_id: string;

  @Column({ nullable: true })
  merchant_id: string | null;

  @Column({ unique: true })
  connection_id: string;

  @CreateDateColumn()
  connected_at: Date;

  @Column({ type: 'timestamptz', nullable: true })
  last_ping: Date | null;

  @Column({ type: 'jsonb', default: [] })
  subscriptions: string[];

  @Column({ type: 'varchar', length: 64, nullable: true })
  ip_address: string | null;

  @Column({ type: 'text', nullable: true })
  user_agent: string | null;

  @Column({ default: true })
  is_active: boolean;

  @UpdateDateColumn()
  updated_at: Date;
}
