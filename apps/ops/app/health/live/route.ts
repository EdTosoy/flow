import { request } from '../../../server/telemetry';
export const dynamic = 'force-dynamic';
export async function GET() {
  return request('liveness', async () => {
    return Response.json(
      {
        status: 'LIVE',
        meaning:
          'Process can respond; no dependency or financial assurance claim.',
      },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  });
}
