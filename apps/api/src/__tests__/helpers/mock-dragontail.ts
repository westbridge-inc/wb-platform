import http from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * [KITCHEN-INTEGRATION] A mock Dragontail POS API, implementing the endpoints Swift uses exactly as the public spec
 * (v1.1.0) describes them:
 *
 *   POST /login                  { userName, password, userLevel } → 200 { time, status: "Ok", token } | 400
 *   POST /PosInsertOrders        token header; → 200 { time, updateStamp, rowCount, status: "ok", orders: [{ storeNo,
 *                                orderId, trackUrl, promiseTimeSeconds }] }; 403 on an expired token
 *   GET  /GetPosNotification     ?storeNo= → 200 { time, status: "ok", rowCount, orders: Notification[] } (drains)
 *   POST /GetOrderUpdatesForPos  { storeNo, updateStamp } → 200 { time, updateStamp, orders: [...] }
 *
 * Test controls: failNext(path, statuses) answers the next requests to a path with those statuses (500s to drive the
 * retry policy, 403 to force a re-login), expireTokens(), refuse(path, status-body) and a request log.
 */
export interface MockRequest {
  method: string;
  path: string;
  headers: http.IncomingHttpHeaders;
  body: unknown;
}

export class MockDragontail {
  readonly requests: MockRequest[] = [];
  readonly users = new Map<string, string>();
  private readonly tokens = new Set<string>();
  private readonly failures = new Map<string, number[]>();
  private refusal: { path: string; status: number; body: unknown } | null = null;
  readonly inserted: Array<Record<string, unknown>> = [];
  pending: Array<Record<string, unknown>> = [];
  updates: Array<Record<string, unknown>> = [];
  updateStamp = 0;
  promiseTimeSeconds = 1500;
  /** Delay (ms) before answering, to drive timeouts. */
  delayMs = 0;
  private server: http.Server | null = null;
  private seq = 0;
  url = '';

  async start(): Promise<string> {
    this.server = http.createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    return this.url;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
  }

  failNext(path: string, statuses: number[]): void {
    this.failures.set(path, [...(this.failures.get(path) ?? []), ...statuses]);
  }

  refuse(path: string, status: number, body: unknown): void {
    this.refusal = { path, status, body };
  }

  expireTokens(): void {
    this.tokens.clear();
  }

  reset(): void {
    this.requests.length = 0;
    this.inserted.length = 0;
    this.pending = [];
    this.updates = [];
    this.failures.clear();
    this.refusal = null;
    this.delayMs = 0;
  }

  count(path: string): number {
    return this.requests.filter((r) => r.path === path).length;
  }

  private now(): string {
    return new Date().toISOString().slice(0, 19).replace('T', ' ');
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const raw = Buffer.concat(chunks).toString('utf8');
    let body: unknown = null;
    try { body = raw ? JSON.parse(raw) : null; } catch { body = raw; }
    const url = new URL(req.url ?? '/', 'http://x');
    const path = url.pathname;
    this.requests.push({ method: req.method ?? '', path, headers: req.headers, body });
    if (this.delayMs > 0) await new Promise((r) => setTimeout(r, this.delayMs));
    const send = (status: number, json: unknown) => {
      if (res.writableEnded || res.destroyed) return;
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(json));
    };
    const queued = this.failures.get(path);
    if (queued && queued.length > 0) {
      const status = queued.shift()!;
      send(status, { time: this.now(), status: 'error', rowCount: 0, errDescription: 'injected' });
      return;
    }
    if (this.refusal && this.refusal.path === path) {
      send(this.refusal.status, this.refusal.body);
      return;
    }
    if (path === '/login' && req.method === 'POST') {
      const b = body as { userName?: string; password?: string; userLevel?: number } | null;
      if (!b || typeof b.userLevel !== 'number' || !b.userName || this.users.get(b.userName) !== b.password) {
        send(400, { time: this.now(), status: 'Failed', info: 'Wrong username or password' });
        return;
      }
      this.seq += 1;
      const token = `AE${String(this.seq).padStart(10, '0')}`;
      this.tokens.add(token);
      send(200, { time: this.now(), status: 'Ok', token });
      return;
    }
    const token = req.headers['token'];
    if (typeof token !== 'string' || !this.tokens.has(token)) {
      send(403, { time: this.now(), status: 'Forbidden' });
      return;
    }
    if (path === '/PosInsertOrders' && req.method === 'POST') {
      const b = body as { storeNo?: number; orders?: Array<Record<string, unknown>> } | null;
      if (!b || typeof b.storeNo !== 'number' || !Array.isArray(b.orders)) {
        send(500, { time: this.now(), rowCount: 0, status: 'parseError' });
        return;
      }
      this.inserted.push(b as Record<string, unknown>);
      this.updateStamp += 1;
      send(200, {
        time: this.now(), updateStamp: this.updateStamp, rowCount: b.orders.length, status: 'ok',
        orders: b.orders.map((o) => ({ storeNo: o['storeNo'], orderId: o['orderId'], trackUrl: 'https://tracker.example/?t=x', promiseTimeSeconds: this.promiseTimeSeconds })),
      });
      return;
    }
    if (path === '/GetPosNotification' && req.method === 'GET') {
      const storeNo = Number(url.searchParams.get('storeNo'));
      if (!Number.isInteger(storeNo)) {
        send(400, { time: this.now(), status: 'faild', errDescription: 'storeNo must be numeric' });
        return;
      }
      const mine = this.pending.filter((n) => n['storeNo'] === storeNo);
      this.pending = this.pending.filter((n) => n['storeNo'] !== storeNo);
      send(200, { time: this.now(), status: 'ok', rowCount: mine.length, orders: mine });
      return;
    }
    if (path === '/GetOrderUpdatesForPos' && req.method === 'POST') {
      const b = body as { storeNo?: number; updateStamp?: number } | null;
      const since = b?.updateStamp ?? 0;
      const rows = this.updates.filter((u) => u['storeNo'] === b?.storeNo && Number(u['stamp']) > since)
        .map(({ stamp: _stamp, ...rest }) => rest);
      const top = Math.max(since, ...this.updates.map((u) => Number(u['stamp'])));
      send(200, { time: this.now(), updateStamp: top, loggedOut: false, orders: rows, status: null });
      return;
    }
    send(404, { time: this.now(), status: 'faild', errDescription: 'not found' });
  }
}
