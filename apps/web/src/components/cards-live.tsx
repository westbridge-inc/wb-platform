'use client';

import type { ReactNode } from 'react';
import { useCardPaymentsLive } from '@/lib/use-card-payments';

/**
 * [CARDS-SWITCH-ON · review #2465-B F4] The one switch around every card claim on the site (the footer's Visa and
 * Mastercard, the refunds page's card sentence): its children only once the server says partners can pay the weekly
 * fee by card right now (lib/use-card-payments.ts), and `soon` (nothing, by default) otherwise — while the answer is
 * on its way, if it fails, and on every host but the public site. The page around it is drawn by the server.
 */
export function CardsLive({ children, soon = null }: { children: ReactNode; soon?: ReactNode }) {
  return <>{useCardPaymentsLive() ? children : soon}</>;
}
