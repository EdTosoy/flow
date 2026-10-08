import type { Metadata } from 'next';
import './global.css';
export const metadata: Metadata = {
  title: 'Flow · Financial operations',
  description: 'Local internal reconciliation investigation',
  robots: { index: false, follow: false },
};
export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <a className="skip" href="#main">
          Skip to content
        </a>
        {children}
      </body>
    </html>
  );
}
