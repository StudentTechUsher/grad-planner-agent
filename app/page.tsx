import { redirect } from 'next/navigation';
import GradPlannerClient from './GradPlannerClient';
import { getAgentSessionFromCookieStore, getAgentRelaunchUrl } from '@/lib/agentAuth';

export const dynamic = 'force-dynamic';

export default async function HomePage() {
  const session = await getAgentSessionFromCookieStore();

  if (!session) {
    redirect(getAgentRelaunchUrl('missing_session'));
  }

  return <GradPlannerClient />;
}
