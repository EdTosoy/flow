import { randomUUID } from 'node:crypto';
import { NextResponse, type NextRequest } from 'next/server';
/** Replace untrusted input; correlation identity is never a financial command identity. */
export function proxy(request: NextRequest) {
  const id = randomUUID();
  const headers = new Headers(request.headers);
  headers.set('x-flow-request-id', id);
  const response = NextResponse.next({ request: { headers } });
  response.headers.set('x-flow-request-id', id);
  return response;
}
export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
