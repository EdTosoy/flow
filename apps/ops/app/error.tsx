'use client';
export default function Error({ reset }: { reset: () => void }) {
  return (
    <main className="loading">
      <h1>Operations view unavailable</h1>
      <p role="alert">
        The request could not complete. This is not a healthy empty state.
      </p>
      <button onClick={reset}>Retry view</button>
    </main>
  );
}
