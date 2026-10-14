'use client';

import { useTransition } from 'react';
import { useRouter } from 'next/navigation';

export function Refresh() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  return (
    <div className="refresh-control">
      <button
        className="secondary"
        disabled={pending}
        onClick={() => startTransition(() => router.refresh())}
      >
        Refresh data ↻
      </button>
      <span className="updating" role="status">
        {pending ? 'Updating snapshot…' : ''}
      </span>
    </div>
  );
}
