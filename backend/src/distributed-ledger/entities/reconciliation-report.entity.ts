import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, Index } from 'typeorm';

@Entity('reconciliation_reports')
export class ReconciliationReport {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @Column({ nullable: true })
  tenant_id: string;

  @Column({ type: 'timestamp' })
  startTime: Date;

  @Column({ type: 'timestamp' })
  endTime: Date;

  @Column({ default: 0 })
  conflictsDetected: number;

  @Column({ default: 0 })
  conflictsResolved: number;

  @Column({ length: 20 })
  status: string;

  @Column({ type: 'jsonb', nullable: true })
  report: Record<string, any>;

  @CreateDateColumn()
  createdAt: Date;
}
