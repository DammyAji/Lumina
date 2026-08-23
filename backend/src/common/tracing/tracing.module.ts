import { Module, Global } from '@nestjs/common';
import { TracingService } from './tracing.service';
import { TracingController } from './tracing.controller';

@Global()
@Module({
  providers: [TracingService],
  controllers: [TracingController],
  exports: [TracingService],
})
export class TracingModule {}
