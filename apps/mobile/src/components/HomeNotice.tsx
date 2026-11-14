/** @jsxImportSource react */
import React, { useEffect, useRef, useState } from 'react';
import { Pressable, View } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { useQuery } from '@tanstack/react-query';
import { color, radius, space } from '@swift/ui';
import { api } from '../services/api';
import { T } from '../kit';
import { touchTarget } from '../kit/touch-target';
import { homeNoticeOf, noticeToShow } from '../lib/homeNotice';
import { closedHomeNoticeIds, rememberHomeNoticeClosed } from '../lib/homeNoticeMemory';

/** A stopped notice leaves a Home kept in front within this long (plus up to a minute of the phone's own cache). */
export const NOTICE_RECHECK_MS = 5 * 60_000;
/** An answer counts as fresh for a minute: coming back to Home (or to the app) after that re-reads it. */
const NOTICE_FRESH_MS = 60_000;

/**
 * [HOME-NOTICE · owner 13 Nov 2026] The owner's notice at the top of Home, for
 * everyone, closed with an X (lib/homeNotice.ts). Nothing is drawn until the
 * answer arrives, and a failed read draws nothing. The closed ids are read
 * before the first draw, so a closed notice never flashes on reopen.
 */
export function HomeNotice({ gutter, live = true }: { gutter: number; live?: boolean }) {
  // [ROUND 2 · REVIEW-B S3-1 · REVIEW-A S4-4] `live` = Home is the screen in front and Swift is in the foreground
  // (HomeScreen's useScreenLive). The 5-minute re-check runs only then (Home stays mounted behind every tab), and
  // coming back to Home or back to the app re-reads the notice once the answer is a minute old, so a notice the owner
  // turned off is gone when the person next looks.
  const query = useQuery({
    queryKey: ['public', 'home-notice'],
    queryFn: async () => homeNoticeOf((await api.get('/public/home-notice')).data),
    staleTime: NOTICE_FRESH_MS,
    refetchInterval: live ? NOTICE_RECHECK_MS : false,
    retry: 1,
  });
  const { refetch, isStale } = query;
  const wasLive = useRef(live);
  useEffect(() => {
    if (live && !wasLive.current && isStale) void refetch();
    wasLive.current = live;
  }, [live, isStale, refetch]);
  const [closed, setClosed] = useState<string[]>(() => closedHomeNoticeIds());
  const notice = noticeToShow(query.data ?? null, closed);
  if (!notice) return null;

  return (
    <View
      accessibilityRole="summary"
      style={{
        marginHorizontal: gutter,
        marginTop: space.lg,
        flexDirection: 'row',
        alignItems: 'flex-start',
        gap: space.sm,
        paddingVertical: space.md,
        paddingLeft: space.md,
        paddingRight: space.xs,
        borderRadius: radius.lg,
        backgroundColor: color.surface.sunken,
      }}
    >
      <Feather name="info" size={16} color={color.brand[500]} style={{ marginTop: 2 }} />
      <View style={{ flex: 1 }}>
        {notice.title ? <T variant="bodyStrong">{notice.title}</T> : null}
        <T variant="caption" tone={notice.title ? 'muted' : undefined} style={notice.title ? { marginTop: 2 } : undefined}>
          {notice.body}
        </T>
      </View>
      <Pressable
        onPress={() => {
          rememberHomeNoticeClosed(notice.id);
          setClosed((ids) => [...ids, notice.id]);
        }}
        accessibilityRole="button"
        accessibilityLabel="Close notice"
        style={({ pressed }) => [touchTarget(24), { opacity: pressed ? 0.6 : 1 }]}
      >
        <Feather name="x" size={18} color={color.text.muted} />
      </Pressable>
    </View>
  );
}
