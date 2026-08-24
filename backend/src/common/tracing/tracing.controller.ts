import { Controller, Get, Put, Post, Body } from '@nestjs/common';
import { TracingService } from './tracing.service';

@Controller('tracing')
export class TracingController {
  constructor(private readonly tracingService: TracingService) {}

  @Get('config')
  getConfig() {
    return {
      serviceName: process.env.OTEL_SERVICE_NAME || 'lumina-backend',
      serviceVersion: process.env.OTEL_SERVICE_VERSION || '1.0.0',
      environment: process.env.OTEL_ENVIRONMENT || 'development',
      samplingRatio: process.env.OTEL_SAMPLING_RATIO || '0.1',
      jaegerEndpoint: process.env.JAEGER_ENDPOINT || 'http://localhost:14268/api/traces',
    };
  }

  @Put('config')
  updateConfig(@Body() config: any) {
    // Note: This would require dynamic reconfiguration support
    // For now, this is a placeholder for future implementation
    return { message: 'Config update requires service restart', config };
  }

  @Post('spans')
  createManualSpan(@Body() body: { name: string; attributes?: Record<string, any> }) {
    const { name, attributes } = body;
    const tracer = this.tracingService.getTracer('manual-tracing');
    
    return tracer.startActiveSpan(name, (span) => {
      if (attributes) {
        Object.entries(attributes).forEach(([key, value]) => {
          span.setAttribute(key, value);
        });
      }
      span.end();
      return { success: true, spanId: span.spanContext().spanId };
    });
  }

  @Get('dependencies')
  getDependencies() {
    // This would query the tracing backend for service dependencies
    // For now, return known service dependencies
    return {
      services: [
        {
          name: 'lumina-backend',
          dependencies: ['postgres', 'redis', 'stellar-network'],
        },
        {
          name: 'lumina-frontend',
          dependencies: ['lumina-backend'],
        },
      ],
    };
  }

  @Get('stats')
  getStats() {
    // This would query the tracing backend for statistics
    // For now, return placeholder data
    return {
      totalSpans: 0,
      errorRate: 0,
      avgLatency: 0,
      samplingRate: parseFloat(process.env.OTEL_SAMPLING_RATIO || '0.1'),
    };
  }
}
