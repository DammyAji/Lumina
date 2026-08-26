import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Escrow } from './entities/escrow.entity';
import { Milestone } from './entities/milestone.entity';
import { Dispute } from './entities/dispute.entity';

@Injectable()
export class EscrowService {
  constructor(
    @InjectRepository(Escrow)
    private escrowRepository: Repository<Escrow>,
    @InjectRepository(Milestone)
    private milestoneRepository: Repository<Milestone>,
    @InjectRepository(Dispute)
    private disputeRepository: Repository<Dispute>,
  ) {}

  async createMultiPartyEscrow(createEscrowDto: {
    escrow_id: string;
    parties: string[];
    amounts: number[];
    dispute_resolvers: string[];
    voting_threshold: number;
    timeout: number;
  }): Promise<Escrow> {
    if (createEscrowDto.parties.length < 3) {
      throw new BadRequestException('Multi-party escrow requires at least 3 parties');
    }

    if (createEscrowDto.parties.length !== createEscrowDto.amounts.length) {
      throw new BadRequestException('Parties and amounts arrays must have the same length');
    }

    const escrow = this.escrowRepository.create({
      ...createEscrowDto,
      status: 'Created',
      is_multi_party: true,
      created_at: new Date(),
    });

    return this.escrowRepository.save(escrow);
  }

  async getEscrow(escrowId: string): Promise<Escrow> {
    const escrow = await this.escrowRepository.findOne({ where: { escrow_id: escrowId } });
    if (!escrow) {
      throw new NotFoundException('Escrow not found');
    }
    return escrow;
  }

  async fundEscrow(escrowId: string, funder: string): Promise<Escrow> {
    const escrow = await this.getEscrow(escrowId);
    
    if (!escrow.parties.includes(funder)) {
      throw new BadRequestException('Funder is not a party in this escrow');
    }

    if (escrow.status !== 'Created') {
      throw new BadRequestException('Escrow is not in Created status');
    }

    escrow.status = 'Funded';
    return this.escrowRepository.save(escrow);
  }

  async addMilestone(addMilestoneDto: {
    escrow_id: string;
    milestone_number: number;
    description: string;
    amount: number;
    required_approvals: number;
    deadline: Date;
    beneficiary: string;
  }): Promise<Milestone> {
    const escrow = await this.getEscrow(addMilestoneDto.escrow_id);

    if (!escrow.is_multi_party) {
      throw new BadRequestException('Milestones can only be added to multi-party escrows');
    }

    const milestone = this.milestoneRepository.create({
      ...addMilestoneDto,
      status: 'Pending',
      approvals: [],
      created_at: new Date(),
    });

    return this.milestoneRepository.save(milestone);
  }

  async approveMilestone(escrowId: string, milestoneNumber: number, approver: string): Promise<Milestone> {
    const escrow = await this.getEscrow(escrowId);
    
    if (escrow.status !== 'Funded') {
      throw new BadRequestException('Escrow is not funded');
    }

    const milestone = await this.milestoneRepository.findOne({
      where: { escrow_id: escrowId, milestone_number: milestoneNumber },
    });

    if (!milestone) {
      throw new NotFoundException('Milestone not found');
    }

    if (milestone.status !== 'Pending') {
      throw new BadRequestException('Milestone is not in Pending status');
    }

    if (!escrow.parties.includes(approver)) {
      throw new BadRequestException('Approver is not a party in this escrow');
    }

    if (milestone.approvals.includes(approver)) {
      throw new BadRequestException('Approver has already approved this milestone');
    }

    milestone.approvals.push(approver);

    if (milestone.approvals.length >= milestone.required_approvals) {
      milestone.status = 'Approved';
    }

    return this.milestoneRepository.save(milestone);
  }

  async releaseMilestone(escrowId: string, milestoneNumber: number, requester: string): Promise<Milestone> {
    const escrow = await this.getEscrow(escrowId);
    
    if (escrow.status !== 'Funded') {
      throw new BadRequestException('Escrow is not funded');
    }

    const milestone = await this.milestoneRepository.findOne({
      where: { escrow_id: escrowId, milestone_number: milestoneNumber },
    });

    if (!milestone) {
      throw new NotFoundException('Milestone not found');
    }

    if (milestone.status !== 'Approved') {
      throw new BadRequestException('Milestone is not approved');
    }

    if (milestone.beneficiary !== requester) {
      throw new BadRequestException('Requester is not the beneficiary of this milestone');
    }

    milestone.status = 'Released';
    return this.milestoneRepository.save(milestone);
  }

  async raiseDispute(raiseDisputeDto: {
    escrow_id: string;
    dispute_number: number;
    reason: string;
    raised_by: string;
    milestone_id?: number;
  }): Promise<Dispute> {
    const escrow = await this.getEscrow(raiseDisputeDto.escrow_id);

    if (escrow.status !== 'Funded') {
      throw new BadRequestException('Escrow is not funded');
    }

    if (!escrow.parties.includes(raiseDisputeDto.raised_by)) {
      throw new BadRequestException('Raiser is not a party in this escrow');
    }

    const existingDispute = await this.disputeRepository.findOne({
      where: { escrow_id: raiseDisputeDto.escrow_id, dispute_number: raiseDisputeDto.dispute_number },
    });

    if (existingDispute) {
      throw new BadRequestException('Dispute with this number already exists');
    }

    const dispute = this.disputeRepository.create({
      ...raiseDisputeDto,
      status: 'Active',
      created_at: new Date(),
    });

    escrow.status = 'Disputed';
    await this.escrowRepository.save(escrow);

    return this.disputeRepository.save(dispute);
  }

  async voteOnDispute(
    escrowId: string,
    disputeNumber: number,
    decision: any,
    voter: string,
  ): Promise<Dispute> {
    const escrow = await this.getEscrow(escrowId);

    if (!escrow.dispute_resolvers.includes(voter)) {
      throw new BadRequestException('Voter is not a dispute resolver');
    }

    const dispute = await this.disputeRepository.findOne({
      where: { escrow_id: escrowId, dispute_number: disputeNumber },
    });

    if (!dispute) {
      throw new NotFoundException('Dispute not found');
    }

    if (dispute.status !== 'Active') {
      throw new BadRequestException('Dispute is not active');
    }

    // In a real implementation, you would track votes and check thresholds
    // For now, we'll just mark it as resolved when a resolver votes
    dispute.resolution = decision;
    dispute.status = 'Resolved';

    escrow.status = 'Funded';
    await this.escrowRepository.save(escrow);

    return this.disputeRepository.save(dispute);
  }

  async getMilestone(escrowId: string, milestoneNumber: number): Promise<Milestone> {
    const milestone = await this.milestoneRepository.findOne({
      where: { escrow_id: escrowId, milestone_number: milestoneNumber },
    });

    if (!milestone) {
      throw new NotFoundException('Milestone not found');
    }

    return milestone;
  }

  async getDispute(escrowId: string, disputeNumber: number): Promise<Dispute> {
    const dispute = await this.disputeRepository.findOne({
      where: { escrow_id: escrowId, dispute_number: disputeNumber },
    });

    if (!dispute) {
      throw new NotFoundException('Dispute not found');
    }

    return dispute;
  }

  async getEscrowMilestones(escrowId: string): Promise<Milestone[]> {
    return this.milestoneRepository.find({
      where: { escrow_id: escrowId },
      order: { milestone_number: 'ASC' },
    });
  }

  async getEscrowDisputes(escrowId: string): Promise<Dispute[]> {
    return this.disputeRepository.find({
      where: { escrow_id: escrowId },
      order: { dispute_number: 'ASC' },
    });
  }
}
