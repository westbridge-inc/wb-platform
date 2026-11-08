import type React from 'react';
import { useCallParty } from '../hooks/useCallParty';
import { useBackupCallShown } from '../hooks/useInAppCall';
import type { CallTarget } from '../lib/callBridge';

type Control = ReturnType<typeof useCallParty>;

/**
 * [O-1] The Call control for one person on an order, as a render prop so each screen keeps its own
 * look. Renders nothing when there is neither a Swift call nor a number to dial (chat and support stay).
 * Bridge off: exactly today's dialler button. Bridge on: "Call via Swift".
 * [CALLS-UX · owner 8 Nov 2026] In-app first: while "Call in app" is offered for this person it is the only
 * control; this one is the backup and shows only when in-app cannot work (switch off, build 12, the parcel
 * recipient, or the server said they cannot be rung in the app). See useBackupCallShown. While the in-app switch
 * is still being read it waits (a short grace), so it never flashes up and away.
 */
export function CallParty(props: {
  orderId?: string | null;
  target: CallTarget;
  phone?: string | null;
  dialFailText: string;
  children: (call: Control) => React.ReactElement | null;
}): React.ReactElement | null {
  const call = useCallParty(props);
  // [CALLS-UX review S2] Tell the in-app control which backup this is, so its words name the button that appears.
  const backup = useBackupCallShown(props.orderId, props.target, call.visible ? (call.viaSwift ? 'bridge' : 'dial') : 'none');
  return call.visible && backup ? props.children(call) : null;
}
