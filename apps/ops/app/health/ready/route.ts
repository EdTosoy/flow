import { ready } from '../../../server/read';
import { request, unavailable } from '../../../server/telemetry';
export const dynamic = 'force-dynamic';
export async function GET() {
  return request('readiness', async () => {
    try {
      await ready();
      return Response.json(
        { status: 'READY', financialAssurance: 'SEPARATE' },
        { headers: { 'Cache-Control': 'no-store' } },
      );
    } catch (error) {
      unavailable(error);
      return Response.json(
        { status: 'UNAVAILABLE', financialAssurance: 'SEPARATE' },
        { status: 503, headers: { 'Cache-Control': 'no-store' } },
      );
    }
  });
}
