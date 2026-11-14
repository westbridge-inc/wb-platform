import { MMKV } from 'react-native-mmkv';
import { closedNoticeIds, rememberClosedNotice, type NoticeMemory } from './homeNotice';

// [HOME-NOTICE] Which notices this phone closed: no account and nothing personal, so it rides the same guarded
// plain-MMKV pattern as the market-depth memory (lib/marketDepthMemory.ts) — the encrypted store is for auth. One
// slot for the device, not per account: the notice is the same for everyone, and signing out keeps it closed.
let store: NoticeMemory | null = null;
try {
  store = new MMKV({ id: 'swift-home-notice' });
} catch {
  store = null;
}

export function closedHomeNoticeIds(): string[] {
  return closedNoticeIds(store);
}

export function rememberHomeNoticeClosed(id: string): void {
  rememberClosedNotice(store, id);
}
