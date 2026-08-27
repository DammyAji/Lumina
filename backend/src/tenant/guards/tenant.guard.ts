import { Injectable, CanActivate, ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { TenantUserRole } from '../entities/tenant-user.entity';
import { TenantUser } from '../entities/tenant-user.entity';

@Injectable()
export class TenantGuard implements CanActivate {
  constructor(
    private reflector: Reflector,
    @InjectRepository(TenantUser)
    private tenantUserRepository: Repository<TenantUser>,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    
    // Check if tenant is set in request
    if (!request.tenant) {
      throw new ForbiddenException('Tenant context not found');
    }

    // Check if user is authenticated
    if (!request.user) {
      throw new ForbiddenException('User not authenticated');
    }

    // Check if user belongs to the tenant
    const tenantUser = await this.tenantUserRepository.findOne({
      where: {
        tenant_id: request.tenant.id,
        user_id: request.user.id,
        is_active: true,
      },
    });

    if (!tenantUser) {
      throw new ForbiddenException('User does not belong to this tenant');
    }

    // Attach user's tenant role to request for use in other guards
    request.user.tenantRole = tenantUser.role;
    request.user.tenantUserId = tenantUser.id;

    return true;
  }
}

@Injectable()
export class TenantRoleGuard implements CanActivate {
  constructor(
    private reflector: Reflector,
    @InjectRepository(TenantUser)
    private tenantUserRepository: Repository<TenantUser>,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const requiredRoles = this.reflector.get<TenantUserRole[]>('tenantRoles', context.getHandler());
    
    if (!requiredRoles) {
      return true;
    }

    const request = context.switchToHttp().getRequest();
    const userRole = request.user?.tenantRole;

    if (!userRole) {
      throw new ForbiddenException('User does not have a tenant role');
    }

    return requiredRoles.includes(userRole);
  }
}
