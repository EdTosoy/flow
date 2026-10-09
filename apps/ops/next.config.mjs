import { fileURLToPath } from 'node:url';
/** Read-only, including the protected ephemeral demo. No assurance cache. */
export default {
  output: 'standalone',
  generateBuildId: async () => process.env['FLOW_IMAGE_REVISION'] ?? null,
  outputFileTracingRoot: fileURLToPath(new URL('../../', import.meta.url)),
  poweredByHeader: false,
  serverExternalPackages: ['pg'],
  transpilePackages: [
    '@flow/operations-read-postgres',
    '@flow/integrity-postgres',
    '@flow/money',
  ],
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Referrer-Policy', value: 'no-referrer' },
          { key: 'X-Robots-Tag', value: 'noindex, nofollow' },
          {
            key: 'Content-Security-Policy',
            value:
              "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
          },
        ],
      },
    ];
  },
};
