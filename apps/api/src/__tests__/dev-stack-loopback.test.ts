import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// [SEC-AUDIT 13 Nov 2026 · F8/F16/F17] The LOCAL development stack (infrastructure/docker/docker-compose.yml) runs
// Postgres with a well-known superuser password, Redis with no password and Meilisearch with no master key. Docker
// publishes ports past the host firewall, so on 0.0.0.0 anyone on the same Wi-Fi reached them. Every published port
// is bound to 127.0.0.1: only this machine can connect. (Production is deploy/docker-compose.yml, not this file.)
const REPO = join(__dirname, '..', '..', '..', '..');
const compose = readFileSync(join(REPO, 'infrastructure', 'docker', 'docker-compose.yml'), 'utf8');

describe('the local dev stack is reachable from this machine only', () => {
  const ports = [...compose.matchAll(/^\s+ports:\n((?:\s+- .+\n)+)/gm)].flatMap((m) => m[1]!.trim().split('\n').map((l) => l.trim().replace(/^- /, '').replace(/['"]/g, '')));

  it('publishes the three services, each on 127.0.0.1 and nothing wider', () => {
    expect(ports.sort()).toEqual(['127.0.0.1:5434:5432', '127.0.0.1:6382:6379', '127.0.0.1:7700:7700']);
  });

  it('has no other way to publish a port (long syntax, host networking)', () => {
    expect(compose).not.toMatch(/published:|network_mode:\s*host|host_ip:/);
  });
});
