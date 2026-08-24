# Distributed Tracing Best Practices

## Overview
This document outlines the best practices for using distributed tracing in the Lumina platform.

## Span Naming Conventions

### General Guidelines
- Use lowercase with dots as separators (e.g., `payment.create`, `auth.validate_user`)
- Be descriptive but concise
- Include the service name as a prefix
- Use verb-noun format for operations

### Recommended Patterns
```
{service}.{operation}          // payment.create
{service}.{sub-operation}      // payment.validate_merchant
{service}.{operation}.{detail} // auth.hash_password
```

## Span Attributes

### Required Attributes
Always include these attributes in your spans:
- `service.name` - Service identifier
- `service.version` - Service version
- `deployment.environment` - Environment (development/staging/production)

### Recommended Attributes
Add these attributes when relevant:
- `user.id` - User identifier (when available)
- `payment.id` - Payment identifier
- `merchant.id` - Merchant identifier
- `http.method` - HTTP method
- `http.url` - Request URL
- `http.status_code` - Response status
- `db.system` - Database system (postgresql, redis)
- `db.name` - Database name
- `db.operation` - Database operation (select, insert, update)

### Sensitive Data
Never include sensitive data in span attributes:
- Passwords
- API keys
- Personal identification information
- Credit card numbers
- Authentication tokens

## Span Hierarchy

### Creating Sub-spans
Use sub-spans to break down complex operations:
```typescript
await this.tracer.startActiveSpan('payment.create', async (span) => {
  // Main operation
  await this.tracer.startActiveSpan('payment.validate_merchant', async (validationSpan) => {
    // Validation logic
    validationSpan.end();
  });
  
  await this.tracer.startActiveSpan('payment.save', async (saveSpan) => {
    // Database save
    saveSpan.end();
  });
  
  span.end();
});
```

### Span Depth
- Keep span depth reasonable (max 5-6 levels)
- Too deep spans can be hard to visualize
- Consider flattening very deep hierarchies

## Error Handling

### Recording Exceptions
Always record exceptions in spans:
```typescript
try {
  // operation
} catch (error) {
  span.recordException(error as Error);
  span.setStatus({
    code: SpanStatusCode.ERROR,
    message: error.message,
  });
  throw error;
}
```

### Error Attributes
Add context to errors:
```typescript
span.setAttribute('error.type', error.name);
span.setAttribute('error.message', error.message);
```

## Sampling Strategy

### Default Sampling
- Development: 100% sampling
- Staging: 50% sampling
- Production: 10% sampling

### High-Value Operations
Always sample critical operations regardless of sampling rate:
```typescript
class HighValueSampler implements Sampler {
  shouldSample(context: SamplingContext): SamplingResult {
    const amount = context.attributes?.['payment.amount'];
    if (amount && amount > 10000) {
      return { decision: SamplingDecision.RECORD_AND_SAMPLE };
    }
    return { decision: SamplingDecision.NOT_RECORD };
  }
}
```

## Performance Considerations

### Overhead
- Tracing overhead should be <5% of operation time
- Use batch span processors
- Configure appropriate sampling rates
- Avoid excessive span attributes

### Async Operations
- Always end spans in finally blocks
- Be careful with async/await in span contexts
- Use `startActiveSpan` for automatic context propagation

## Context Propagation

### HTTP Headers
Trace context is automatically propagated via HTTP headers:
- `traceparent` - W3C trace context format
- `tracestate` - Additional vendor-specific data

### Manual Propagation
For custom protocols, manually propagate context:
```typescript
const traceContext = trace.getSpanContext(context.active());
// Send traceContext with your request
```

## Integration with Logging

### Correlation IDs
Include trace IDs in log entries:
```typescript
const traceId = span.spanContext().traceId;
this.logger.log(`Trace ID: ${traceId} - Operation completed`);
```

### Structured Logging
Add trace context to structured logs:
```typescript
this.logger.log({
  traceId: span.spanContext().traceId,
  spanId: span.spanContext().spanId,
  message: 'Payment processed',
  paymentId: payment.id,
});
```

## Monitoring and Alerting

### Key Metrics
Monitor these tracing metrics:
- Span throughput
- Span error rate
- Span latency (p50, p95, p99)
- Sampling rate effectiveness

### Alerting
Set up alerts for:
- High error rates in critical spans
- Unusual latency patterns
- Missing trace data
- Sampling rate deviations

## Testing

### Unit Tests
Test span creation and attributes:
```typescript
it('should create payment span with correct attributes', () => {
  const mockTracer = createMockTracer();
  // Test span creation
  expect(mockTracer.startActiveSpan).toHaveBeenCalledWith('payment.create');
});
```

### Integration Tests
Test trace propagation across services:
```typescript
it('should propagate trace context across services', async () => {
  // Make request and verify trace context
  const traceId = extractTraceId(response);
  expect(traceId).toBeDefined();
});
```

## Troubleshooting

### Missing Traces
1. Check sampling configuration
2. Verify exporter connectivity
3. Check service registration
4. Review logs for initialization errors

### Broken Trace Chains
1. Verify context propagation
2. Check middleware configuration
3. Ensure proper span ending
4. Review async operation handling

### High Overhead
1. Reduce sampling rate
2. Remove unnecessary attributes
3. Optimize span hierarchy
4. Check batch processor configuration

## Tools and Resources

### Jaeger UI
Access Jaeger at: http://localhost:16686

### OpenTelemetry Documentation
- https://opentelemetry.io/docs/
- https://opentelemetry.io/docs/instrumentation/js/

### W3C Trace Context
- https://www.w3.org/TR/trace-context/
