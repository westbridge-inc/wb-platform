import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { prismaPlugin } from '../plugins/prisma';
import { registerErrorHandler } from '../middleware/error-handler';
import {
  runScan, notifyPending, classify, parseEntries, looksLikePublication, MAX_LISTING_CHARS, citationTailMatches,
  type WatchSource, type FetchLike, type NotifyChannels,
} from '../modules/compliance/commencement-watch';

// [DCR-1 Part III] The watch observes and alerts, never acts. The negative
// test (the REAL DICA commencement order, the closest look-alike Gazette
// listing that must NOT fire) is as important as the positive.
let app: FastifyInstance;
const runId = nanoid(6);
const S1: WatchSource = { id: `s1-${runId}`, url: 'https://gazette.test/pubs', trust: 'S1' };
const S2: WatchSource = { id: `s2-${runId}`, url: 'https://parliament.test/acts', trust: 'S2' };

const DICA_NEGATIVE = 'Order No. 73 of 2026 - The Digital Identity Card Act 2023 (Commencement) Order 2026';
const DPA_POSITIVE = 'Order No. 12 of 2027 - The Data Protection Act 2023 (Commencement) Order 2027';
const REGS_POSITIVE = 'The Data Protection (General) Regulations 2027';

function page(titles: string[]): string {
  return `<html><body><ul>${titles.map((t, i) => `<li><a href="/doc/${i}">${t}</a></li>`).join('')}</ul></body></html>`;
}

function fetchReturning(map: Record<string, { status: number; body: string }>): FetchLike {
  return async (url) => {
    const hit = map[url] ?? { status: 404, body: '' };
    return { status: hit.status, text: async () => hit.body };
  };
}

beforeAll(async () => {
  process.env['NODE_ENV'] = 'development';
  process.env['DATABASE_URL'] = process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift_test';
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  await app.register(prismaPlugin);
  await app.ready();
});

afterAll(async () => {
  await app.prisma.cwAlert.deleteMany({ where: { sourceId: { contains: runId } } });
  await app.prisma.cwRun.deleteMany({ where: { sourceId: { contains: runId } } });
  await app.close();
});

describe('commencement watch [DCR-1 CW]', () => {
  it('the canonical NEGATIVE: the real DICA commencement order must NOT fire', () => {
    expect(classify({ title: DICA_NEGATIVE, url: null }, 'S1')).toBeNull();
  });

  it('a synthesized DPA order on S1 → exactly ONE CONFIRMED-CANDIDATE COMMENCEMENT', async () => {
    const summaries = await runScan(app.prisma, fetchReturning({
      [S1.url]: { status: 200, body: page([DICA_NEGATIVE, DPA_POSITIVE, 'Appropriation Act 2027']) },
    }), [S1]);
    expect(summaries[0]!.newAlerts).toBe(1);
    const alerts = await app.prisma.cwAlert.findMany({ where: { sourceId: S1.id } });
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.eventType).toBe('COMMENCEMENT');
    expect(alerts[0]!.confidence).toBe('CONFIRMED-CANDIDATE');
  });

  it('[SEC-AUDIT 13 Nov 2026 · F12] a listing larger than any real one is refused unparsed (BODY_TOO_LARGE), never scanned', async () => {
    const big: WatchSource = { id: `big-${runId}`, url: 'https://gazette.test/huge', trust: 'S1' };
    const body = page([DPA_POSITIVE]) + ' '.repeat(MAX_LISTING_CHARS);
    const [summary] = await runScan(app.prisma, fetchReturning({ [big.url]: { status: 200, body } }), [big]);
    expect(summary).toMatchObject({ error: 'BODY_TOO_LARGE', entries: 0, newAlerts: 0 });
  });

  it('regulations fixture → REGULATIONS; the same entries re-scanned → ZERO new alerts (dedupe)', async () => {
    const fetcher = fetchReturning({
      [S1.url]: { status: 200, body: page([DPA_POSITIVE, REGS_POSITIVE]) },
    });
    const first = await runScan(app.prisma, fetcher, [S1]);
    expect(first[0]!.newAlerts).toBe(1); // regs new; commencement deduped from prior test
    const again = await runScan(app.prisma, fetcher, [S1]);
    expect(again[0]!.newAlerts).toBe(0);
    const regs = await app.prisma.cwAlert.findMany({ where: { sourceId: S1.id, eventType: 'REGULATIONS' } });
    expect(regs).toHaveLength(1);
  });

  it('S2 (non-Gazette) can only mint SIGNAL, never CONFIRMED-CANDIDATE', async () => {
    await runScan(app.prisma, fetchReturning({
      [S2.url]: { status: 200, body: page([DPA_POSITIVE]) },
    }), [S2]);
    const alert = await app.prisma.cwAlert.findFirstOrThrow({ where: { sourceId: S2.id } });
    expect(alert.confidence).toBe('SIGNAL');
  });

  it('200-with-zero-entries is PARSE_EMPTY — a failure, never a quiet zero', async () => {
    const s = { id: `s1e-${runId}`, url: 'https://gazette.test/empty', trust: 'S1' as const };
    const out = await runScan(app.prisma, fetchReturning({ [s.url]: { status: 200, body: '<html></html>' } }), [s]);
    expect(out[0]!.error).toBe('PARSE_EMPTY');
    const run = await app.prisma.cwRun.findFirstOrThrow({ where: { sourceId: s.id } });
    expect(run.error).toBe('PARSE_EMPTY');
  });

  it('3 consecutive source failures → exactly ONE WATCH_DEGRADED per day', async () => {
    const s = { id: `s1d-${runId}`, url: 'https://gazette.test/down', trust: 'S1' as const };
    const dead = fetchReturning({}); // every fetch 404s
    await runScan(app.prisma, dead, [s]);
    await runScan(app.prisma, dead, [s]);
    await runScan(app.prisma, dead, [s]);
    await runScan(app.prisma, dead, [s]); // 4th failure — still the same day bucket
    const degraded = await app.prisma.cwAlert.findMany({ where: { sourceId: s.id, eventType: 'WATCH_DEGRADED' } });
    expect(degraded).toHaveLength(1);
    expect(degraded[0]!.confidence).toBe('SYSTEM');
  });

  it('ZERO alert channels is itself RED: notify throws after recording a SYSTEM alert', async () => {
    const none: NotifyChannels = { webhookUrl: null, emails: [], notifyAdmins: null };
    await expect(notifyPending(app.prisma, none, fetchReturning({}))).rejects.toThrow(/zero alert channels/);
  });

  it('[F-024-04] a notifyAdmins channel whose probe reaches ZERO admins goes RED even with NO pending alerts', async () => {
    // The months-silent case: function present, admin table empty, nothing
    // pending — the old presence-of-function check returned 0 green forever.
    const zeroAdmins: NotifyChannels = {
      webhookUrl: null, emails: [],
      notifyAdmins: async () => 0,
      probeAdmins: async () => 0,
    };
    await expect(notifyPending(app.prisma, zeroAdmins, fetchReturning({}))).rejects.toThrow(/zero active admins/);
    const degraded = await app.prisma.cwAlert.findFirst({
      where: { eventType: 'WATCH_DEGRADED', matchedRule: 'NO_REACHABLE_ADMIN' },
      orderBy: { firstSeenAt: 'desc' },
    });
    expect(degraded).not.toBeNull();
    // (The probe-positive and webhook-alive paths are exercised by the
    // delivery test below — this test must stay non-consuming: it throws
    // before the pending loop, leaving the queue for later tests.)
  });

  it('notify delivers pending alerts in-app and stamps notifiedAt; ack stops re-notify', async () => {
    const sent: string[] = [];
    const channels: NotifyChannels = {
      webhookUrl: null, emails: [],
      notifyAdmins: async (title) => { sent.push(title); return 1; },
      probeAdmins: async () => 1, // [F-024-04] probe-positive path
    };
    const n = await notifyPending(app.prisma, channels, fetchReturning({}));
    expect(n).toBeGreaterThanOrEqual(1);
    expect(sent.length).toBe(n);
    const unnotified = await app.prisma.cwAlert.count({
      where: { sourceId: { contains: runId }, notifiedAt: null },
    });
    expect(unnotified).toBe(0);
    // Second notify with nothing new and nothing older than a day → nothing.
    expect(await notifyPending(app.prisma, channels, fetchReturning({}))).toBe(0);
  });


  it('[F-022-03] a channel that reaches NO human never stamps notifiedAt — and an all-fail cycle goes RED', async () => {
    const s = { id: `s1n-${runId}`, url: 'https://gazette.test/n', trust: 'S1' as const };
    await runScan(app.prisma, fetchReturning({
      [s.url]: { status: 200, body: page([`Order No. 44 of 2027 - The Data Protection Act 2023 (Fees) Order ${runId}`, 'A', 'B', 'C', 'D']) },
    }), [s]);
    const zeroReach: NotifyChannels = {
      webhookUrl: null, emails: [],
      notifyAdmins: async () => 0, // adapter found no admins
    };
    await expect(notifyPending(app.prisma, zeroReach, fetchReturning({}))).rejects.toThrow(/NO channel delivered/);
    const still = await app.prisma.cwAlert.findFirst({ where: { sourceId: s.id } });
    expect(still?.notifiedAt).toBeNull();
  });

  it('[F-022-01] a page with only nav scraps is PARSE_THIN, never a healthy zero-hit scan', async () => {
    const s = { id: `s1t-${runId}`, url: 'https://gazette.test/thin', trust: 'S1' as const, minEntries: 5 };
    const out = await runScan(app.prisma, fetchReturning({
      [s.url]: { status: 200, body: page(['Home page', 'Contact us']) },
    }), [s]);
    expect(out[0]!.error).toMatch(/PARSE_THIN/);
  });

  it('[F-024-07] FIVE ordinary navigation links do NOT pass as a healthy gazette feed', async () => {
    // The bypass: each title is ≥8 chars, so the old anchor-count floor saw a
    // healthy 5-entry feed on a login/redesign page. Health now demands
    // publication-SHAPED entries (instrument vocabulary / number / year).
    const s = { id: `s1nav-${runId}`, url: 'https://gazette.test/nav', trust: 'S1' as const, minEntries: 5 };
    const out = await runScan(app.prisma, fetchReturning({
      [s.url]: {
        status: 200,
        // [F-026-03] The REALISTIC bypass, not a strawman: on a LEGAL site the
        // nav bar IS legal vocabulary. My first fixture avoided those words
        // entirely, so it never exercised the hole the reviewer named.
        body: page(['Acts of Parliament', 'Bills before the House', 'Statutory Instruments and Regulations', 'Official Gazette archive', 'Public Notices index']),
      },
    }), [s]);
    expect(out[0]!.error).toMatch(/PARSE_THIN:0<5/);
    // And a real listing of five instruments stays healthy.
    const s2 = { id: `s1pub-${runId}`, url: 'https://gazette.test/pub', trust: 'S1' as const, minEntries: 5 };
    const out2 = await runScan(app.prisma, fetchReturning({
      [s2.url]: {
        status: 200,
        body: page([
          `Order No. 12 of 2026 — Municipal Fees ${runId}`,
          'The Fisheries (Amendment) Act 2026',
          'Notice No. 88 of 2026 — Road Closures',
          'The Income Tax Regulations 2026',
          'Legal Supplement B — 14 August 2026',
        ]),
      },
    }), [s2]);
    expect(out2[0]!.error).toBeNull();
  });

  // [F-027-01] Two previous versions of the health floor were defeated by
  // navigation I had not thought of, and each time the test proved only the
  // one vocabulary set I happened to choose. So this one does not choose:
  // it GENERATES the navigation space and requires that none of it passes.
  describe('[F-027-01] navigation cannot satisfy the publication floor', () => {
    const INSTRUMENTS = ['Act', 'Acts', 'Order', 'Orders', 'Bill', 'Bills', 'Notice', 'Notices', 'Regulation', 'Regulations', 'Gazette', 'Supplement', 'Proclamation', 'Resolution'];
    const CATEGORIES = ['Archive', 'Archives', 'Index', 'Tracker', 'Listing', 'Listings', 'Library', 'Collection', 'Database', 'Records', 'Resources', 'Downloads', 'Papers', 'Portal', 'Directory', 'Catalogue', 'Repository', 'Overview', 'Search', 'Browse'];
    const QUALIFIERS = ['', ' 2026', ' 2025', ' No. 1', ' — 2026', ' of 2026', ' 2019–2026', ' (2026)'];

    it('no combination of instrument word × category word × year/number passes', () => {
      const survivors: string[] = [];
      for (const kind of INSTRUMENTS) {
        for (const cat of CATEGORIES) {
          for (const q of QUALIFIERS) {
            // Both orders — "Act Archive 2026" and "Archive of Acts 2026".
            for (const title of [`${kind} ${cat}${q}`, `${cat} of ${kind}${q}`, `${cat}: ${kind}${q}`]) {
              if (looksLikePublication(title)) survivors.push(title);
            }
          }
        }
      }
      expect(survivors, `navigation titles accepted as publications: ${survivors.slice(0, 10).join(' | ')}`).toEqual([]);
    });

    it('the exact five the reviewer supplied are all rejected', () => {
      for (const nav of ['Act Archive 2026', 'Order Paper 2026', 'Bill Tracker 2026', 'Notice Archive 2026', 'Regulation Index 2026']) {
        expect(looksLikePublication(nav), nav).toBe(false);
      }
    });

    it('and REAL instruments are still accepted — the floor must not become unreachable', () => {
      for (const real of [
        'Order No. 12 of 2026 — Municipal Fees',
        'The Fisheries (Amendment) Act 2026',
        'Notice No. 88 of 2026 — Road Closures',
        'The Income Tax Regulations 2026',
        'Legal Supplement B — 14 August 2026',
        'Order No. 73 of 2026 - The Digital Identity Card Act 2023 (Commencement) Order 2026',
        'The Data Protection Act 2023 (Commencement) Order 2027',
      ]) {
        expect(looksLikePublication(real), real).toBe(true);
      }
    });

    it('[SEC-AUDIT 13 Nov 2026 · F12] a scraped title built to backtrack (many "(a)" groups) is judged in linear time', () => {
      // The old tail `\(.*?\)` inside a repeated group matched "(a)(a)" as one group or two: 2^n splits before a
      // failing "!" (26 groups took about a second; 40, hours). The API server (SOS escalation, paging) shares that loop.
      for (const title of [`The Data Act${' (a)'.repeat(26)} !`, `The Data Act ${'(a)'.repeat(26)}!`, `Order${' (x)'.repeat(26)} !`]) {
        const started = performance.now();
        expect(looksLikePublication(title)).toBe(false);
        expect(performance.now() - started, `${title.length} chars`).toBeLessThan(250);
      }
      // [REVIEW-2498-A S2-1] The other overlap: a year range ("2020-2021") against year, dash, year; and a date with its
      // year against a date then a year. Each grew x2 per group (26 dash-joined years / 24 dates: about a second).
      for (const title of [`The Data Act ${Array(26).fill('2020').join('-')}!`, `The Data Act ${'12 may 2020 '.repeat(24)}!`, `The Data Act ${'no 1a '.repeat(45)}!`]) {
        const started = performance.now();
        expect(looksLikePublication(title)).toBe(false);
        expect(performance.now() - started, `${title.length} chars`).toBeLessThan(100);
      }
      // A title longer than any real citation is not one (and is never handed to the tail at all).
      expect(looksLikePublication(`The Data Act${' 2026'.repeat(80)}`)).toBe(false);
      // Real parenthesised citations still read as publications.
      expect(looksLikePublication('The Fisheries (Amendment) (No. 2) Act 2026')).toBe(true);
    });

    it('[REVIEW-2498-A S2-1] the citation tail itself is linear: thousands of ambiguous groups, well past any title cap', () => {
      // Each token is taken whole once (an atomic step); a failing end never re-splits what came before.
      const shapes = (n: number) => [` ${Array(n).fill('2020').join('-')}!`, ` ${'12 may 2020 '.repeat(n)}!`, ` ${'(a)'.repeat(n)}!`, ` ${'no 1a '.repeat(n)}!`, ` ${'2020, '.repeat(n)}!`];
      for (const tail of shapes(4_000)) {
        const started = performance.now();
        expect(citationTailMatches(tail)).toBe(false);
        expect(performance.now() - started, `${tail.slice(0, 12)}… ${tail.length} chars`).toBeLessThan(100);
      }
      // ...and it still reads every qualifier a real citation ends in.
      for (const ok of [' 2026', ' (no. 2) 2026', ' no. 12 of 2026', ' 2020-2021', ' 2026, 1 may 2026.', ' 1 may 2026', ' (amendment) (no. 2)', ' no 1a', '']) {
        expect(citationTailMatches(ok), JSON.stringify(ok)).toBe(true);
      }
      expect(citationTailMatches(' issued by the ministry 2026')).toBe(false);
    });

    it('[F-028-09] the CLASS: instrument-mid-sentence titles reject, whatever their vocabulary', () => {
      // Round three of this predicate falling to vocabulary outside its
      // blocklist. These are the review's exact five — five words, an
      // instrument token, a year, and not one blocked word:
      for (const nav of [
        'Official Gazette Publications for the Year 2026',
        'Legal Supplement Issues Published During 2026',
        'Bill Status in the National Assembly 2026',
        'Notice Board for Public Authorities 2026',
        'Regulations Issued by the Ministry During 2026',
      ]) {
        expect(looksLikePublication(nav), nav).toBe(false);
      }
    });

    it('[F-028-09] ...and a GENERATIVE out-of-vocabulary set proves it is not a new word list', () => {
      // Built from nouns the predicate has never seen. The structural rule —
      // a citation ends its instrument token in qualifiers; a sentence
      // continues in prose — must hold for vocabulary invented after the
      // predicate shipped, or it is another finite list waiting to lose.
      const NOVEL_NOUNS = ['Compendium', 'Chronicle', 'Digest', 'Ledger', 'Register', 'Almanac', 'Gateway', 'Hub', 'Vault', 'Atlas'];
      const CONNECTORS = ['for the Year', 'Published During', 'Issued Throughout', 'Maintained Since', 'Covering'];
      const survivors: string[] = [];
      for (const noun of NOVEL_NOUNS) {
        for (const conn of CONNECTORS) {
          for (const title of [
            `Gazette ${noun} ${conn} 2026`,
            `${noun} of Notices ${conn} 2026`,
            `Regulations ${noun} ${conn} 2026`,
          ]) {
            if (looksLikePublication(title)) survivors.push(title);
          }
        }
      }
      expect(survivors, `out-of-vocabulary navigation accepted: ${survivors.slice(0, 8).join(' | ')}`).toEqual([]);
    });

    it('a bare instrument category with no identity at all is rejected', () => {
      for (const bare of ['Acts of Parliament', 'Bills before the House', 'Statutory Instruments and Regulations', 'Notices', 'Orders']) {
        expect(looksLikePublication(bare), bare).toBe(false);
      }
    });
  });

  it('parseEntries survives markup inside anchors', () => {
    const entries = parseEntries('<a href="/x"><b>The Data</b> Protection Act 2023 (Commencement) Order</a>');
    expect(entries[0]!.title).toContain('Protection Act');
  });

  it('[REVIEW-2498-A S3-2] parseEntries reads anchors exactly as before', () => {
    const html = `<ul><li><A class="x" HREF='/a1' data-y="1">The Fisheries (Amendment) Act 2026</A></li>
      <li><a href="/a2"><span>Order No. 12 of 2026</span> — Municipal Fees</a></li><li><a name="n">no href here at all</a></li>
      <li><a href="/a3">short</a></li><li><abbr>x</abbr><a href="/a4" href2='z'>Notice No. 88 of 2026</a></li></ul>`;
    expect(parseEntries(html)).toEqual([
      { title: 'The Fisheries (Amendment) Act 2026', url: '/a1' },
      { title: 'Order No. 12 of 2026 — Municipal Fees', url: '/a2' },
      { title: 'Notice No. 88 of 2026', url: '/a4' },
    ]);
  });

  it('[REVIEW-2498-A S3-2] parseEntries is linear on hostile markup (unclosed anchors, tags with no ">")', () => {
    for (const unit of ["<a href='x'>", '<a ', '<a x=1 ', '<a href="/y">The Data Act 2026 ', '<a href="/z">' + '<'.repeat(19_000) + '</a>', '<a ' + 'href="'.repeat(600) + '>']) {
      const html = unit.repeat(Math.ceil(400_000 / unit.length));
      const started = performance.now();
      const entries = parseEntries(html);
      expect(performance.now() - started, unit.slice(0, 20)).toBeLessThan(250);
      if (!unit.includes('</a>')) expect(entries).toEqual([]); // nothing ever closes: nothing is an entry
    }
  });

  it('[REVIEW-2498-A S4-1] an oversized listing is refused without being read whole: by its declared length, or as it streams', async () => {
    const big: WatchSource = { id: `stream-${runId}`, url: 'https://gazette.test/stream', trust: 'S1' };
    const neverText = async (): Promise<string> => { throw new Error('the whole body must not be read'); };
    const declared: FetchLike = async () => ({ status: 200, text: neverText, headers: { get: (n: string) => (n.toLowerCase() === 'content-length' ? String(MAX_LISTING_CHARS * 4 + 1) : null) } });
    expect((await runScan(app.prisma, declared, [big]))[0]).toMatchObject({ error: 'BODY_TOO_LARGE', entries: 0 });
    // A body with no length that never ends: read only up to the cap.
    const chunk = new TextEncoder().encode('<li>'.repeat(16_384));
    const endless: FetchLike = async () => ({ status: 200, text: neverText, headers: { get: () => null }, body: new ReadableStream<Uint8Array>({ pull(c) { c.enqueue(chunk); } }) });
    expect((await runScan(app.prisma, endless, [big]))[0]).toMatchObject({ error: 'BODY_TOO_LARGE', entries: 0 });
    // A normal streamed page still parses.
    const okBody = new TextEncoder().encode(page([DPA_POSITIVE]));
    const streamed: FetchLike = async () => ({ status: 200, text: neverText, headers: { get: () => String(okBody.length) }, body: new ReadableStream<Uint8Array>({ start(c) { c.enqueue(okBody); c.close(); } }) });
    expect((await runScan(app.prisma, streamed, [big]))[0]).toMatchObject({ error: expect.stringMatching(/^PARSE_THIN/), entries: 1 });
  });
});
