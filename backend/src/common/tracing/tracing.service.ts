import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { Resource } from '@opentelemetry/resources';
import { SemanticResourceAttributes } from '@opentelemetry/semantic-conventions';
import { JaegerExporter } from '@opentelemetry/exporter-jaeger';
import { BatchSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { Instrumentation } from '@opentelemetry/instrumentation';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { ExpressInstrumentation } from '@opentelemetry/instrumentation-express';
import { PgInstrumentation } from '@opentelemetry/instrumentation-pg';
import { GrpcInstrumentation } from '@opentelemetry/instrumentation-grpc';
import { trace, context } from '@opentelemetry/api';
import { ParentBasedSampler, TraceIdRatioBasedSampler, AlwaysOnSampler, AlwaysOffSampler } from '@opentelemetry/sdk-trace-base';

@Injectable()
export class TracingService implements OnModuleInit, OnModuleDestroy {
  private provider: NodeTracerProvider;
  private instrumentations: Instrumentation[] = [];

  async onModuleInit() {
    await this.initializeOpenTelemetry();
  }

  async onModuleDestroy() {
    await this.shutdown();
  }

  private async initializeOpenTelemetry() {
    const serviceName = process.env.OTEL_SERVICE_NAME || 'lumina-backend';
    const serviceVersion = process.env.OTEL_SERVICE_VERSION || '1.0.0';
    const environment = process.env.NODE_ENV || 'development';
    const jaegerEndpoint = process.env.JAEGER_ENDPOINT || 'http://localhost:14268/api/traces';
    const samplingRatio = parseFloat(process.env.OTEL_SAMPLING_RATIO || '0.1');

    // Create resource with service metadata
    const resource = Resource.default().merge(
      new Resource({
        [SemanticResourceAttributes.SERVICE_NAME]: serviceName,
        [SemanticResourceAttributes.SERVICE_VERSION]: serviceVersion,
        [SemanticResourceAttributes.DEPLOYMENT_ENVIRONMENT]: environment,
      }),
    );

    // Create tracer provider
    this.provider = new NodeTracerProvider({
      resource,
      // Adaptive sampling strategy
      sampler: new ParentBasedSampler({
        root: new TraceIdRatioBasedSampler(samplingRatio),
        localParentNotSampled: new AlwaysOffSampler(),
        localParentSampled: new AlwaysOnSampler(),
        remoteParentSampled: new AlwaysOnSampler(),
        remoteParentNotSampled: new AlwaysOffSampler(),
      }),
    });

    // Configure Jaeger exporter
    const jaegerExporter = new JaegerExporter({
      endpoint: jaegerEndpoint,
    });

    // Add batch span processor
    this.provider.addSpanProcessor(new BatchSpanProcessor(jaegerExporter));

    // Register automatic instrumentations
    this.instrumentations = [
      new HttpInstrumentation(),
      new ExpressInstrumentation(),
      new PgInstrumentation(),
      new GrpcInstrumentation(),
    ];

    this.instrumentations.forEach(instrumentation => {
      instrumentation.setTracerProvider(this.provider);
    });

    // Register the provider globally
    this.provider.register();

    console.log(`OpenTelemetry initialized for ${serviceName} in ${environment} mode`);
  }

  private async shutdown() {
    if (this.provider) {
      await this.provider.shutdown();
    }
    this.instrumentations.forEach(instrumentation => {
      instrumentation.enable();
    });
  }

  getTracer(name: string, version?: string) {
    return trace.getTracer(name, version);
  }

  static startActiveSpan<T>(name: string, fn: (span: any) => T): T {
    const tracer = trace.getTracer('lumina-backend');
    return tracer.startActiveSpan(name, fn);
  }

  static setAttribute(key: string, value: any) {
    const activeSpan = trace.getActiveSpan();
    if (activeSpan) {
      activeSpan.setAttribute(key, value);
    }
  }

  static recordException(error: Error) {
    const activeSpan = trace.getActiveSpan();
    if (activeSpan) {
      activeSpan.recordException(error);
    }
  }

  static setStatus(status: { code: number; message?: string }) {
    const activeSpan = trace.getActiveSpan();
    if (activeSpan) {
      activeSpan.setStatus(status);
    }
  }
}
