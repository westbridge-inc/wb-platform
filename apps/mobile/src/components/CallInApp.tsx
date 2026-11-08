import type React from 'react';
import { useInAppCall } from '../hooks/useInAppCall';
import type { CallTarget } from '../lib/callBridge';

type Control = ReturnType<typeof useInAppCall>;

/**
 * [INAPP-CALLS] "Call in app" for one person on an order, as a render prop so each screen keeps its own look.
 * Renders nothing unless the server switch is on, this build has the calling module (build 13+), and the person
 * is not the parcel recipient. Never a number.
 * [CALLS-UX · owner 8 Nov 2026] In-app first: when it shows, it is the only call control; the dial / "Call via
 * Swift" control (CallParty) comes back as the backup only if the in-app call cannot happen.
 */
export function CallInApp(props: {
  orderId?: string | null;
  target: CallTarget;
  children: (call: Control) => React.ReactElement | null;
}): React.ReactElement | null {
  const call = useInAppCall(props);
  return call.visible ? props.children(call) : null;
}
