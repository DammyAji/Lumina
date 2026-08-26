import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn } from 'typeorm';

@Entity()
export class Escrow {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  escrow_id: string;

  @Column('simple-array')
  parties: string[];

  @Column('simple-array')
  amounts: number[];

  @Column({
    type: 'enum',
    enum: ['Created', 'Funded', 'Released', 'Refunded', 'Cancelled', 'Disputed'],
    default: 'Created'
  })
  status: string;

  @CreateDateColumn()
  created_at: Date;

  @Column()
  timeout: number;

  @Column('simple-array')
  dispute_resolvers: string[];

  @Column()
  voting_threshold: number;

  @Column({ default: false })
  is_multi_party: boolean;
}
