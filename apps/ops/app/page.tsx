import { OpsPage } from '../server/page';
import type { Search } from '../server/read';
export const dynamic = 'force-dynamic';
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<Search>;
}) {
  return <OpsPage section="overview" search={await searchParams} />;
}
