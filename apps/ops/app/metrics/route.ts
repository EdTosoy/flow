import { telemetry, request } from '../../server/telemetry';
export const dynamic = 'force-dynamic';
/** Local/internal process observations only. Performs no database query. */
export function GET() {
  return request(
    'metrics',
    async () =>
      new Response(telemetry.text(), {
        headers: {
          'Content-Type': 'text/plain; version=0.0.4; charset=utf-8',
          'Cache-Control': 'no-store',
        },
      }),
  );
}
