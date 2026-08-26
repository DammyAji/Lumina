import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn } from 'typeorm';

@Entity()
export class Dispute {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  escrow_id: string;

  @Column()
  dispute_number: number;

  @Column('text')
  reason: string;

  @Column()
  raised_by: string;

  @Column({
    type: 'enum',
    enum: ['Active', 'Resolved', 'Rejected'],
    default: 'Active'
  })
  status: string;

  @Column('jsonb', { nullable: true })
  resolution: any;

  @Column({ nullable: true })
  milestone_id: number;

  @CreateDateColumn()
  created_at: Date;
}
