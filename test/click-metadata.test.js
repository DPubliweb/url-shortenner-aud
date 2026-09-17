const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { test } = require('node:test');
const express = require('express');
const { FieldValue, Timestamp } = require('firebase-admin/firestore');

const entryPath = path.join(__dirname, '..', 'index.js');
const source = fs.readFileSync(entryPath, 'utf8');
const appRequire = createRequire(entryPath);
const iphoneUA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const desktopUA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// Execute the real application with an in-memory Firestore boundary.
// No Firebase credentials, network calls or listening socket are needed.
function loadApp({ exists = true, update, blocked = false } = {}) {
  const app = express();
  app.listen = () => {};
  const updates = [];
  const errors = [];
  const urlRef = {
    async get() { return { exists, data: () => ({ url: 'https://example.com/landing' }) }; },
    async update(data) {
      updates.push(data);
      if (update) await update(data);
    },
  };
  const blockedDocs = new Map();
  const db = {
    collection(name) {
      if (name === 'urls') return { doc: () => urlRef };
      assert.equal(name, 'blockedIps');
      return {
        doc(ip) {
          return {
            ip,
            async get() {
              const data = blockedDocs.get(ip) || (blocked ? { blocked: true } : undefined);
              return { exists: Boolean(data), data: () => data };
            },
          };
        },
        where() { return { limit: () => ({ get: async () => ({ empty: true }) }) }; },
      };
    },
    async runTransaction(callback) {
      return callback({
        get: ref => ref.get(),
        set: (ref, data) => blockedDocs.set(ref.ip, data),
      });
    },
  };
  const fakeAdmin = {
    initializeApp() {},
    credential: { cert: () => ({}) },
    firestore: Object.assign(() => db, { FieldValue, Timestamp }),
  };
  const context = vm.createContext({
    require(name) {
      if (name === 'firebase-admin') return fakeAdmin;
      if (name === 'dotenv') return { config() {} };
      if (name === 'express') return Object.assign(() => app, express);
      return appRequire(name);
    },
    process: { env: { FIREBASE_PRIVATE_KEY: 'test-only' } },
    console: { log() {}, error: (...args) => errors.push(args) },
    __dirname: path.dirname(entryPath),
  });
  vm.runInContext(source, context, { filename: entryPath });
  const route = app._router.stack.find(layer => layer.route?.path === '/:id').route.stack[0].handle;
  const checkBlockedIP = app._router.stack.find(layer => layer.name === 'checkBlockedIP').handle;
  return { route, checkBlockedIP, updates, errors, blockedDocs, getClientIp: context.getClientIp };
}

function request(headers = {}, id = 'Ab123') {
  return {
    method: 'GET',
    params: { id },
    headers,
    socket: { remoteAddress: '203.0.113.9' },
    connection: { remoteAddress: '203.0.113.9' },
    get(name) { return this.headers[name.toLowerCase()]; },
  };
}

function response() {
  return {
    statusCode: 200,
    headers: {},
    headersSent: false,
    set(name, value) { this.headers[name.toLowerCase()] = value; return this; },
    status(code) { assert.equal(this.headersSent, false); this.statusCode = code; return this; },
    send(body) { assert.equal(this.headersSent, false); this.body = body; this.headersSent = true; return this; },
    redirect(code, url) {
      assert.equal(this.headersSent, false, 'Only one response should be sent');
      this.statusCode = typeof code === 'number' ? code : 302;
      this.location = url || code;
      this.headersSent = true;
      return this;
    },
  };
}

test('restores the existing mobile metadata fields and atomic click increments', async () => {
  const app = loadApp();
  const res = response();
  await app.route(request({
    'user-agent': iphoneUA,
    'referer': 'https://example.org/campaign',
    'x-forwarded-for': '198.51.100.7, 192.0.2.10',
  }), res);
  assert.equal(app.updates.length, 1);
  const metadata = app.updates[0];
  assert.equal(metadata.lastClickIP, '198.51.100.7');
  assert.equal(metadata.userAgent, iphoneUA);
  assert.equal(metadata.referer, 'https://example.org/campaign');
  assert.equal(metadata.deviceType, 'mobile');
  assert.equal(metadata.deviceVendor, 'Apple');
  assert.equal(metadata.deviceModel, 'iPhone');
  assert.equal(metadata.osName, 'iOS');
  assert.equal(metadata.osVersion, '17.0');
  assert.equal(metadata.browserName, 'Mobile Safari');
  assert.equal(metadata.browserVersion, '17.0');
  assert.ok(metadata.lastClickAt.isEqual(FieldValue.serverTimestamp()));
  assert.ok(metadata.clicks.isEqual(FieldValue.increment(1)));
  assert.ok(metadata.mobileClicks.isEqual(FieldValue.increment(1)));
  assert.equal(res.statusCode, 302);
  assert.equal(res.location, 'https://example.com/landing');
  assert.equal(res.headers['cache-control'], 'no-store');
});

test('records desktop metadata without incrementing the mobile counter', async () => {
  const app = loadApp();
  await app.route(request({ 'user-agent': desktopUA }), response());
  const metadata = app.updates[0];
  assert.equal(metadata.deviceType, 'desktop');
  assert.equal(metadata.osName, 'Windows');
  assert.equal(metadata.browserName, 'Chrome');
  assert.equal(metadata.lastClickIP, '203.0.113.9');
  assert.equal(metadata.mobileClicks, undefined);
});

test('missing headers produce Firestore-safe values and clear stale metadata', async () => {
  const app = loadApp();
  await app.route(request(), response());
  const metadata = app.updates[0];
  for (const field of ['referer', 'userAgent', 'deviceVendor', 'deviceModel', 'osName', 'osVersion', 'browserName', 'browserVersion']) {
    assert.equal(metadata[field], '', field);
  }
  assert.equal(metadata.deviceType, 'desktop');
  assert.ok(Object.values(metadata).every(value => value !== undefined));
});

test('waits for the metadata write before sending the redirect', async () => {
  let finishWrite;
  let writeStarted;
  const started = new Promise(resolve => { writeStarted = resolve; });
  const app = loadApp({ update: () => {
    writeStarted();
    return new Promise(resolve => { finishWrite = resolve; });
  } });
  const res = response();
  const pending = app.route(request(), res);
  await started;
  const redirectedEarly = res.headersSent;
  finishWrite();
  await pending;
  assert.equal(redirectedEarly, false);
  assert.equal(res.statusCode, 302);
});

test('a failed metadata write is logged and still sends a single redirect', async () => {
  const app = loadApp({ update: async () => { throw new Error('Firestore unavailable'); } });
  const res = response();
  await app.route(request(), res);
  assert.equal(res.statusCode, 302);
  assert.equal(res.location, 'https://example.com/landing');
  assert.equal(app.errors.length, 1);
  assert.match(app.errors[0].join(' '), /Metadata.*Ab123.*Firestore unavailable/);
});

test('client IP extraction preserves IPv6 addresses and handles proxy ports', () => {
  const { getClientIp } = loadApp();
  const cases = [
    ['2001:db8::1234', '2001:db8::1234'],
    ['::1', '::1'],
    ['[2001:db8::1234]:443', '2001:db8::1234'],
    ['::ffff:192.0.2.8', '::ffff:192.0.2.8'],
    ['::ffff:192.0.2.8:443', '::ffff:192.0.2.8'],
    ['192.0.2.8:443, 192.0.2.10', '192.0.2.8'],
    ['invalid/ip', '203.0.113.9'],
  ];
  for (const [header, expected] of cases) {
    assert.equal(getClientIp(request({ 'x-forwarded-for': header })), expected, header);
  }
});

test('three unknown short links still block the IP without recording clicks', async () => {
  const app = loadApp({ exists: false });
  for (const expectedStatus of [404, 404, 403]) {
    const res = response();
    await app.route(request(), res);
    assert.equal(res.statusCode, expectedStatus);
  }
  assert.equal(app.updates.length, 0);
  const blocked = app.blockedDocs.get('203.0.113.9');
  assert.equal(blocked.failCount, 3);
  assert.equal(blocked.blocked, true);
});

test('the IP middleware still refuses already blocked visitors', async () => {
  const app = loadApp({ blocked: true });
  const res = response();
  let nextCalled = false;
  await app.checkBlockedIP(request(), res, () => { nextCalled = true; });
  assert.equal(res.statusCode, 403);
  assert.equal(nextCalled, false);
  assert.equal(app.updates.length, 0);
});
