import { OpsPage } from '../../../server/page';
import type { Search } from '../../../server/read';
export const dynamic = 'force-dynamic';
export default async function Page({
  params,
  searchParams,
}: {
  params: Promise<{ section: string; id: string }>;
  searchParams: Promise<Search>;
}) {
  const p = await params;
  return <OpsPage section={p.section} id={p.id} search={await searchParams} />;
}
