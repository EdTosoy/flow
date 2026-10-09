import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { randomUUID } from 'node:crypto';
import {
  StripeBoundaryError,
  stripeMetrics,
  verifyWebhook,
  type EventEnvelope,
} from '@flow/stripe-integration';
export interface IngressStore {
  ready(): Promise<boolean>;
  accept(
    event: EventEnvelope,
    raw: Buffer,
    origin: 'webhook',
  ): Promise<{ id: string; replayed: boolean }>;
}
export interface IngressConfig {
  accountId: string;
  secrets: readonly string[];
  bodyLimit?: number;
  log?: (entry: Readonly<Record<string, string | number>>) => void;
}
export function ingressServer(store: IngressStore, config: IngressConfig) {
  if (
    !/^acct_[A-Za-z0-9_]+$/.test(config.accountId) ||
    config.secrets.length < 1 ||
    config.secrets.length > 2 ||
    config.secrets.some((s) => !/^whsec_[A-Za-z0-9_]+$/.test(s))
  )
    throw new Error('Invalid sandbox ingress configuration');
  const bound = config.bodyLimit ?? 1048576;
  if (!Number.isInteger(bound) || bound < 1 || bound > 1048576)
    throw new Error('Invalid webhook body limit');
  const counters: Record<string, number> = {
    received: 0,
    verified: 0,
    rejected: 0,
    duplicate: 0,
    ingestion_failure: 0,
    accepted: 0,
    unsupported: 0,
  };
  const server = createServer((request, response) => {
    void handle(request, response).catch(() => {
      if (!response.headersSent) reply(response, 500, 'unavailable');
      else response.destroy();
    });
  });
  server.requestTimeout = 5000;
  server.headersTimeout = 5000;
  server.keepAliveTimeout = 5000;
  server.maxHeadersCount = 64;
  const reply = (
    response: ServerResponse,
    status: number,
    message: string,
  ): void => {
    response.writeHead(status, {
      'content-type': 'application/json',
      'cache-control': 'no-store',
    });
    response.end(JSON.stringify({ status: message }));
  };
  const handle = async (
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> => {
    const requestId = randomUUID(),
      start = performance.now();
    const provenance: Record<string, string> = {};
    response.setHeader('x-request-id', requestId);
    const log = (outcome: string): void => {
      try {
        config.log?.({
          timestamp: new Date().toISOString(),
          level:
            outcome === 'accepted' || outcome === 'duplicate' ? 'info' : 'warn',
          subsystem: 'stripe-ingress',
          operation: 'webhook',
          requestId,
          durationMs: Math.round(performance.now() - start),
          outcome,
          ...provenance,
        });
      } catch {
        /* Observers cannot change durable acknowledgement. */
      }
    };
    if (request.url === '/health/live' && request.method === 'GET') {
      reply(response, 200, 'live');
      return;
    }
    if (request.url === '/health/ready' && request.method === 'GET') {
      try {
        const ready = await store.ready();
        reply(response, ready ? 200 : 503, ready ? 'ready' : 'unavailable');
      } catch {
        reply(response, 503, 'unavailable');
      }
      return;
    }
    if (request.url === '/metrics' && request.method === 'GET') {
      response.writeHead(200, {
        'content-type': 'text/plain; version=0.0.4',
        'cache-control': 'no-store',
      });
      response.end(
        stripeMetrics() +
          Object.entries(counters)
            .map(
              ([name, value]) =>
                'stripe_webhook_' + name + '_total ' + value + '\n',
            )
            .join(''),
      );
      return;
    }
    if (request.url !== '/webhooks/stripe') {
      reply(response, 404, 'not_found');
      return;
    }
    if (request.method !== 'POST') {
      response.setHeader('allow', 'POST');
      reply(response, 405, 'method_not_allowed');
      return;
    }
    counters['received']!++;
    if (Number(request.headers['content-length']) > bound) {
      counters['rejected']!++;
      response.setHeader('connection', 'close');
      reply(response, 413, 'body_too_large');
      request.resume();
      return;
    }
    let raw: Buffer;
    try {
      raw = await new Promise<Buffer>((resolve, reject) => {
        const chunks: Buffer[] = [];
        let size = 0,
          done = false;
        const timer = setTimeout(() => {
          if (!done) {
            done = true;
            reject(new Error('body_timeout'));
            request.destroy();
          }
        }, 5000);
        timer.unref();
        request.on('data', (chunk: Buffer) => {
          if (done) return;
          size += chunk.length;
          if (size > bound) {
            done = true;
            clearTimeout(timer);
            reject(new RangeError());
            chunks.length = 0;
            request.resume();
          } else chunks.push(chunk);
        });
        request.once('end', () => {
          clearTimeout(timer);
          if (!done) {
            done = true;
            resolve(Buffer.concat(chunks, size));
          }
        });
        request.once('error', () => {
          clearTimeout(timer);
          done = true;
          reject(new Error('body_unavailable'));
        });
        request.once('aborted', () => {
          clearTimeout(timer);
          done = true;
          reject(new Error('body_unavailable'));
        });
      });
    } catch (error) {
      counters['rejected']!++;
      reply(response, error instanceof RangeError ? 413 : 400, 'invalid_body');
      log('invalid_body');
      return;
    }
    let event: EventEnvelope;
    try {
      const signature = request.headers['stripe-signature'];
      event = verifyWebhook(
        raw,
        typeof signature === 'string' ? signature : undefined,
        config.secrets,
        config.accountId,
      );
      counters['verified']!++;
      provenance['eventId'] = event.id;
      provenance['eventType'] = event.type;
    } catch (error) {
      counters['rejected']!++;
      if (
        error instanceof StripeBoundaryError &&
        error.code === 'EVENT_NOT_ALLOWLISTED'
      ) {
        counters['unsupported']!++;
        reply(response, 400, 'unsupported_event');
      } else reply(response, 400, 'rejected');
      log('rejected');
      return;
    }
    try {
      const result = await store.accept(event, raw, 'webhook');
      provenance['sourceRecordId'] = result.id;
      if (result.replayed) counters['duplicate']!++;
      else counters['accepted']!++;
      reply(response, 200, result.replayed ? 'duplicate' : 'accepted');
      log(result.replayed ? 'duplicate' : 'accepted');
    } catch (error) {
      counters['ingestion_failure']!++;
      const conflict =
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 'P1401';
      reply(
        response,
        conflict ? 409 : 503,
        conflict ? 'evidence_conflict' : 'durable_acceptance_unavailable',
      );
      log(conflict ? 'evidence_conflict' : 'durable_acceptance_unavailable');
    }
  };
  return server;
}
