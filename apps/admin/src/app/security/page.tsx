'use client';

import { useRouter } from 'next/navigation';
import { AdminMfaSteps } from '@/components/mc/AdminMfaSteps';

// [AUDIT-20261113 FABLE-03 #2] Security: set up the authenticator app that becomes the second step of every admin
// sign-in once ADMIN_TOTP_REQUIRED is switched on. The owner sets it up here first, then the switch goes on.
export default function SecurityPage() {
  const router = useRouter();
  return (
    <div className="mc-page">
      <h1 className="mc-numbers mb-2 text-2xl font-semibold">Security</h1>
      <div className="mc-card max-w-md p-6">
        <h2 className="mb-3 text-base font-semibold">Authenticator app</h2>
        <AdminMfaSteps mode="settings" onDone={() => router.replace('/dashboard')} />
      </div>
    </div>
  );
}
