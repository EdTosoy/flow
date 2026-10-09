import { randomUUID } from 'node:crypto';
import { NextResponse, type NextRequest } from 'next/server';
import { demoAccess } from './demo-access';
/** Replace untrusted input; correlation identity is never a financial command identity. */
export function proxy(request: NextRequest) {
  const access = demoAccess(
    request.nextUrl.pathname,
    request.headers.get('authorization'),
    process.env,
  );
  if (access !== 200)
    return new NextResponse('Demo access required', {
      status: access,
      headers: {
        'WWW-Authenticate':
          'Basic realm="Flow ephemeral demo", charset="UTF-8"',
        'Cache-Control': 'no-store',
      },
    });
  const id = randomUUID();
  const headers = new Headers(request.headers);
  headers.set('x-flow-request-id', id);
  // Credentials terminate at the access boundary, not in read-model/log headers.
  headers.delete('authorization');
  const response = NextResponse.next({ request: { headers } });
  response.headers.set('x-flow-request-id', id);
  return response;
}
export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
