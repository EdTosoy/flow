import { OpsPage } from '../../server/page';
import type { Search } from '../../server/read';
export const dynamic = 'force-dynamic';
export default async function Page({
  params,
  searchParams,
}: {
  params: Promise<{ section: string }>;
  searchParams: Promise<Search>;
}) {
  return (
    <OpsPage section={(await params).section} search={await searchParams} />
  );
}
