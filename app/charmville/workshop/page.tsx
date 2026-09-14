import {notFound} from 'next/navigation';
import Link from 'next/link';
import {charmvilleAdmissionMode} from '@/lib/charmville/admission';
import ContributionPanel from '../world/contribution-panel';
import AppBackdrop from '@/components/AppBackdrop';

export const dynamic = 'force-dynamic';
export const metadata = {title: 'Charmville · Creator workshop'};

export default function WorkshopPage() {
  if (charmvilleAdmissionMode() === 'disabled') notFound();
  return <main data-market-shell="true" className="mx-auto max-w-4xl p-4"><AppBackdrop /><Link className="mb-4 inline-flex min-h-11 items-center text-cream" href="/charmville/world?panel=play">← Return to game</Link><ContributionPanel /></main>;
}
