import { Injectable, NestInterceptor, ExecutionContext, CallHandler } from '@nestjs/common';
import { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';
import { trace, SpanStatusCode } from '@opentelemetry/api';

@Injectable()
export class TracingInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    const request = context.switchToHttp().getRequest();
    const tracer = trace.getTracer('lumina-backend');
    
    const spanName = `${request.method} ${request.route?.path || request.url}`;
    const span = tracer.startSpan(spanName);

    // Add span attributes
    span.setAttribute('http.method', request.method);
    span.setAttribute('http.url', request.url);
    span.setAttribute('http.route', request.route?.path || 'unknown');
    span.setAttribute('http.host', request.headers.host);
    span.setAttribute('http.user_agent', request.headers['user-agent']);
    span.setAttribute('http.scheme', request.protocol);
    
    // Add correlation ID if available
    if (request.headers['x-correlation-id']) {
      span.setAttribute('correlation.id', request.headers['x-correlation-id']);
    }

    // Add user ID if available (from auth middleware)
    if (request.user?.id) {
      span.setAttribute('user.id', request.user.id);
    }

    return next.handle().pipe(
      tap({
        next: () => {
          span.setStatus({ code: SpanStatusCode.OK });
          span.end();
        },
        error: (error) => {
          span.recordException(error);
          span.setStatus({
            code: SpanStatusCode.ERROR,
            message: error.message,
          });
          span.setAttribute('error.type', error.name);
          span.setAttribute('error.message', error.message);
          span.end();
        },
      }),
    );
  }
}
