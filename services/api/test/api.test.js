import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { startHarness } from './helpers.js';

describe('incident API', () => {
  let h; let viewer; let engineer; let admin;
  const incident = { title: 'Checkout 5xx spike', severity: 'sev2', service: 'checkout' };

  before(async () => {
    h = await startHarness();
    viewer = await h.login('v@test.io', ['viewer']);
    engineer = await h.login('e@test.io', ['engineer']);
    admin = await h.login('a@test.io', ['admin']);
  });
  after(() => h.close());

  describe('authentication', () => {
    it('registers with 201 and never returns the hash', async () => {
      const r = await h.call('POST', '/auth/register', { body: { email: 'New@Test.io', password: h.password } });
      assert.equal(r.status, 201);
      assert.equal(r.body.email, 'new@test.io');
      assert.deepEqual(r.body.roles, ['viewer']);
      assert.equal(r.body.passwordHash, undefined);
    });
    it('rejects duplicate email with 409', async () => {
      const r = await h.call('POST', '/auth/register', { body: { email: 'new@test.io', password: h.password } });
      assert.equal(r.status, 409);
      assert.equal(r.body.error.code, 'EMAIL_TAKEN');
    });
    it('rejects weak passwords with 400 and field details', async () => {
      const r = await h.call('POST', '/auth/register', { body: { email: 'x@test.io', password: 'short' } });
      assert.equal(r.status, 400);
      assert.equal(r.body.error.details[0].field, 'password');
    });
    it('gives the same 401 for unknown user and wrong password', async () => {
      const a = await h.call('POST', '/auth/login', { body: { email: 'ghost@test.io', password: h.password } });
      const b = await h.call('POST', '/auth/login', { body: { email: 'e@test.io', password: 'WrongPassword!123' } });
      assert.equal(a.status, 401);
      assert.deepEqual(a.body.error.message, b.body.error.message);
    });
    it('401 without token, with garbage token', async () => {
      assert.equal((await h.call('GET', '/incidents')).status, 401);
      assert.equal((await h.call('GET', '/incidents', { token: 'nope' })).status, 401);
    });
  });

  describe('RBAC', () => {
    it('viewer can read but not create (403)', async () => {
      assert.equal((await h.call('GET', '/incidents', { token: viewer })).status, 200);
      const r = await h.call('POST', '/incidents', { token: viewer, body: incident });
      assert.equal(r.status, 403);
      assert.equal(r.body.error.code, 'FORBIDDEN');
    });
    it('engineer cannot delete, admin can', async () => {
      const created = (await h.call('POST', '/incidents', { token: engineer, body: incident })).body;
      assert.equal((await h.call('DELETE', `/incidents/${created.id}`, { token: engineer })).status, 403);
      assert.equal((await h.call('DELETE', `/incidents/${created.id}`, { token: admin })).status, 204);
      assert.equal((await h.call('GET', `/incidents/${created.id}`, { token: admin })).status, 404);
    });
  });

  describe('CRUD and validation', () => {
    it('creates with 201 + Location and a trace id header', async () => {
      const r = await h.call('POST', '/incidents', { token: engineer, body: incident });
      assert.equal(r.status, 201);
      assert.match(r.headers.get('location'), /^\/incidents\/[0-9a-f]{24}$/);
      assert.match(r.headers.get('x-trace-id'), /^[0-9a-f]{32}$/);
      assert.equal(r.body.status, 'open');
      assert.equal(r.body.timeline.length, 1);
    });
    it('rejects invalid body with 400', async () => {
      const r = await h.call('POST', '/incidents', { token: engineer, body: { title: 'x', severity: 'sev9' } });
      assert.equal(r.status, 400);
      assert.equal(r.body.error.code, 'VALIDATION_ERROR');
      assert.ok(r.body.error.details.length >= 2);
    });
    it('400 for malformed JSON and malformed id, 404 for unknown route', async () => {
      assert.equal((await h.call('POST', '/incidents', { token: engineer, body: '{bad', headers: { 'content-type': 'application/json' } })).status, 400);
      assert.equal((await h.call('GET', '/incidents/not-an-id', { token: engineer })).status, 400);
      assert.equal((await h.call('GET', '/nope', { token: engineer })).status, 404);
    });
    it('filters and paginates', async () => {
      for (let i = 0; i < 3; i++) await h.call('POST', '/incidents', { token: engineer, body: { ...incident, title: `Pagination case ${i}`, service: 'search' } });
      const r = await h.call('GET', '/incidents?service=search&limit=2&page=2', { token: viewer });
      assert.equal(r.body.total, 3);
      assert.equal(r.body.data.length, 1);
      assert.equal((await h.call('GET', '/incidents?limit=1000', { token: viewer })).status, 400);
    });
    it('treats the search term as text, not a regex', async () => {
      const r = await h.call('GET', '/incidents?q=' + encodeURIComponent('(.*)+'), { token: viewer });
      assert.equal(r.status, 200);
      assert.equal(r.body.total, 0);
    });
  });

  describe('incident lifecycle', () => {
    it('enforces transitions and requires a root cause to resolve', async () => {
      const { id } = (await h.call('POST', '/incidents', { token: engineer, body: incident })).body;
      const patch = (body) => h.call('PATCH', `/incidents/${id}`, { token: engineer, body });

      const skip = await patch({ status: 'resolved' });
      assert.equal(skip.status, 409);
      assert.equal(skip.body.error.code, 'INVALID_TRANSITION');

      assert.equal((await patch({ status: 'investigating' })).status, 200);
      const noRca = await patch({ status: 'resolved' });
      assert.equal(noRca.status, 422);
      assert.equal(noRca.body.error.code, 'ROOT_CAUSE_REQUIRED');

      const done = await patch({ status: 'resolved', rootCause: 'Connection pool exhausted after deploy 42' });
      assert.equal(done.status, 200);
      assert.ok(done.body.resolvedAt);
      assert.ok(done.body.timeline.length >= 3);

      const note = await h.call('POST', `/incidents/${id}/notes`, { token: engineer, body: { text: 'Pool size raised to 50' } });
      assert.equal(note.status, 201);
    });
    it('reports stats including MTTR', async () => {
      const r = await h.call('GET', '/stats', { token: viewer });
      assert.equal(r.status, 200);
      assert.ok(r.body.byStatus.open >= 1);
      assert.ok(r.body.resolved >= 1);
      assert.equal(typeof r.body.mttrMinutes, 'number');
    });
  });

  describe('observability', () => {
    it('continues an incoming W3C trace and logs it on the access line', async () => {
      const traceId = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
      const r = await h.call('GET', '/incidents', { token: viewer, headers: { traceparent: `00-${traceId}-bbbbbbbbbbbbbbbb-01` } });
      assert.equal(r.headers.get('x-trace-id'), traceId);
      const line = h.lines.findLast((l) => l.event === 'http_request' && l.traceId === traceId);
      assert.equal(line.status, 200);
      assert.equal(line.service, 'api-test');
    });
    it('chaos switch injects 504s and is admin-only', async () => {
      assert.equal((await h.call('PUT', '/admin/chaos', { token: engineer, body: { errorRate: 1 } })).status, 403);
      assert.equal((await h.call('PUT', '/admin/chaos', { token: admin, body: { errorRate: 1 } })).status, 200);
      const r = await h.call('GET', '/incidents', { token: viewer });
      assert.equal(r.status, 504);
      assert.equal(r.body.error.code, 'DB_TIMEOUT');
      await h.call('PUT', '/admin/chaos', { token: admin, body: { errorRate: 0 } });
      assert.equal((await h.call('GET', '/incidents', { token: viewer })).status, 200);
    });
    it('labels the same endpoint identically whether it succeeds or fails', async () => {
      await h.call('PUT', '/admin/chaos', { token: admin, body: { errorRate: 1 } });
      const failed = await h.call('GET', '/incidents', { token: viewer });
      await h.call('PUT', '/admin/chaos', { token: admin, body: { errorRate: 0 } });
      const ok = await h.call('GET', '/incidents', { token: viewer });
      const route = (res) => h.lines.findLast((l) => l.event === 'http_request' && l.traceId === res.headers.get('x-trace-id')).route;
      assert.equal(route(failed), '/incidents');
      assert.equal(route(ok), '/incidents');
      const byId = await h.call('GET', '/incidents/aaaaaaaaaaaaaaaaaaaaaaaa', { token: viewer });
      assert.equal(route(byId), '/incidents/:id');
    });
  });
});

describe('gateway auth mode', () => {
  let h;
  before(async () => { h = await startHarness({ AUTH_MODE: 'gateway', INTERNAL_KEY: 'k'.repeat(24) }); });
  after(() => h.close());

  it('refuses direct calls and wrong keys', async () => {
    assert.equal((await h.call('GET', '/incidents')).status, 401);
    assert.equal((await h.call('GET', '/incidents', { headers: { 'x-internal-key': 'x'.repeat(24), 'x-user-id': 'u1', 'x-user-roles': 'admin' } })).status, 401);
  });
  it('trusts identity headers that carry the internal key and applies roles', async () => {
    const headers = { 'x-internal-key': 'k'.repeat(24), 'x-user-id': 'u1' };
    assert.equal((await h.call('GET', '/incidents', { headers: { ...headers, 'x-user-roles': 'viewer' } })).status, 200);
    assert.equal((await h.call('POST', '/incidents', { headers: { ...headers, 'x-user-roles': 'viewer' }, body: { title: 'abc', severity: 'sev3', service: 'svc' } })).status, 403);
    assert.equal((await h.call('POST', '/incidents', { headers: { ...headers, 'x-user-roles': 'engineer' }, body: { title: 'abc', severity: 'sev3', service: 'svc' } })).status, 201);
  });
  it('does not expose local auth routes', async () => {
    assert.equal((await h.call('POST', '/auth/login', { body: { email: 'a@b.io', password: 'x'.repeat(12) } })).status, 404);
  });
});
