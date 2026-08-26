import { Controller, Get, Post, Body, Param, NotFoundException } from '@nestjs/common';
import { EscrowService } from './escrow.service';
import { Escrow } from './entities/escrow.entity';
import { Milestone } from './entities/milestone.entity';
import { Dispute } from './entities/dispute.entity';

@Controller('escrow')
export class EscrowController {
  constructor(private readonly escrowService: EscrowService) {}

  @Post('multi-party')
  async createMultiPartyEscrow(@Body() createEscrowDto: {
    escrow_id: string;
    parties: string[];
    amounts: number[];
    dispute_resolvers: string[];
    voting_threshold: number;
    timeout: number;
  }): Promise<Escrow> {
    return this.escrowService.createMultiPartyEscrow(createEscrowDto);
  }

  @Get(':id')
  async getEscrow(@Param('id') id: string): Promise<Escrow> {
    return this.escrowService.getEscrow(id);
  }

  @Post(':id/fund')
  async fundEscrow(
    @Param('id') id: string,
    @Body() body: { funder: string }
  ): Promise<Escrow> {
    return this.escrowService.fundEscrow(id, body.funder);
  }

  @Post(':id/milestones')
  async addMilestone(@Body() addMilestoneDto: {
    escrow_id: string;
    milestone_number: number;
    description: string;
    amount: number;
    required_approvals: number;
    deadline: Date;
    beneficiary: string;
  }): Promise<Milestone> {
    return this.escrowService.addMilestone(addMilestoneDto);
  }

  @Post(':id/milestones/:mid/approve')
  async approveMilestone(
    @Param('id') id: string,
    @Param('mid') mid: string,
    @Body() body: { approver: string }
  ): Promise<Milestone> {
    return this.escrowService.approveMilestone(id, parseInt(mid), body.approver);
  }

  @Post(':id/milestones/:mid/release')
  async releaseMilestone(
    @Param('id') id: string,
    @Param('mid') mid: string,
    @Body() body: { requester: string }
  ): Promise<Milestone> {
    return this.escrowService.releaseMilestone(id, parseInt(mid), body.requester);
  }

  @Post(':id/disputes')
  async raiseDispute(@Body() raiseDisputeDto: {
    escrow_id: string;
    dispute_number: number;
    reason: string;
    raised_by: string;
    milestone_id?: number;
  }): Promise<Dispute> {
    return this.escrowService.raiseDispute(raiseDisputeDto);
  }

  @Post(':id/disputes/:did/vote')
  async voteOnDispute(
    @Param('id') id: string,
    @Param('did') did: string,
    @Body() body: { decision: any; voter: string }
  ): Promise<Dispute> {
    return this.escrowService.voteOnDispute(id, parseInt(did), body.decision, body.voter);
  }

  @Get(':id/milestones')
  async getEscrowMilestones(@Param('id') id: string): Promise<Milestone[]> {
    return this.escrowService.getEscrowMilestones(id);
  }

  @Get(':id/disputes')
  async getEscrowDisputes(@Param('id') id: string): Promise<Dispute[]> {
    return this.escrowService.getEscrowDisputes(id);
  }

  @Get(':id/milestones/:mid')
  async getMilestone(
    @Param('id') id: string,
    @Param('mid') mid: string
  ): Promise<Milestone> {
    return this.escrowService.getMilestone(id, parseInt(mid));
  }

  @Get(':id/disputes/:did')
  async getDispute(
    @Param('id') id: string,
    @Param('did') did: string
  ): Promise<Dispute> {
    return this.escrowService.getDispute(id, parseInt(did));
  }
}
