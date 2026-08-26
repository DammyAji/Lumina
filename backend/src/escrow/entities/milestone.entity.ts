import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn } from 'typeorm';

@Entity()
export class Milestone {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  escrow_id: string;

  @Column()
  milestone_number: number;

  @Column('text')
  description: string;

  @Column('decimal', { precision: 36, scale: 18 })
  amount: number;

  @Column()
  required_approvals: number;

  @Column('simple-array')
  approvals: string[];

  @Column({
    type: 'enum',
    enum: ['Pending', 'Approved', 'Released', 'Rejected', 'Expired'],
    default: 'Pending'
  })
  status: string;

  @Column()
  deadline: Date;

  @Column()
  beneficiary: string;

  @CreateDateColumn()
  created_at: Date;
}
