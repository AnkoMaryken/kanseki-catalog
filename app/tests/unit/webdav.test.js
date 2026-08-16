// ================================================
// unit/webdav.test.js — WebDAV Provider（mock 200/404/412/401）
// ================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  WebDavProvider, ConflictError, ProviderError,
  createFetchTransport, normalizeBundle, DEFAULT_WEBDAV_BASE
} from '../../src/js/core/sync/provider-webdav.js';

// 构造一个可控的 mock transport
function mockTransport(handler) {
  return {
    request: async (method, url, opts) => handler(method, url, opts)
  };
}

const emptyBundle = { settings: [], search_history: [], quick_links: [] };

test('默认 URL 指向坚果云', () => {
  const p = new WebDavProvider({ transport: mockTransport(async () => { throw new Error('no'); }) });
  assert.equal(p.url, 'https://dav.jianguoyun.com/dav/kanseki-sync/sync.json');
});

test('pull：404 = 首次同步（空 bundle + 空 revision）', async () => {
  const p = new WebDavProvider({ transport: mockTransport(async () => ({ status: 404, headers: {}, bodyText: '' })) });
  const r = await p.pull();
  assert.equal(r.revision, '');
  assert.deepEqual(r.bundle.settings, []);
  assert.deepEqual(r.bundle.quick_links, []);
});

test('pull：200 返回 ETag 与 bundle', async () => {
  const p = new WebDavProvider({ transport: mockTransport(async () => ({
    status: 200,
    headers: { etag: '"abc123"' },
    bodyText: JSON.stringify({ settings: [{ key: 'theme', value: 'dark', updatedAt: 1, deviceId: 'A' }] })
  })) });
  const r = await p.pull();
  assert.equal(r.revision, '"abc123"');
  assert.equal(r.bundle.settings[0].key, 'theme');
});

test('pull：401 抛 ProviderError 认证失败', async () => {
  const p = new WebDavProvider({ transport: mockTransport(async () => ({ status: 401, headers: {}, bodyText: '' })) });
  await assert.rejects(() => p.pull(), (e) => {
    assert.ok(e instanceof ProviderError);
    assert.match(e.message, /认证/);
    return true;
  });
});

test('pull：JSON 损坏抛 ProviderError', async () => {
  const p = new WebDavProvider({ transport: mockTransport(async () => ({ status: 200, headers: {}, bodyText: '{bad json' })) });
  await assert.rejects(() => p.pull(), (e) => {
    assert.ok(e instanceof ProviderError);
    assert.match(e.message, /解析失败/);
    return true;
  });
});

test('push：带 If-Match 条件头 + 返回新 revision', async () => {
  let captured = null;
  const p = new WebDavProvider({ transport: mockTransport(async (method, url, opts) => {
    captured = { method, url, headers: opts.headers };
    return { status: 200, headers: { etag: '"rev2"' }, bodyText: '' };
  }) });
  const r = await p.push({ settings: [] }, '"rev1"');
  assert.equal(r.revision, '"rev2"');
  assert.equal(captured.headers['If-Match'], '"rev1"');
  assert.equal(captured.method, 'PUT');
});

test('push：首次同步（无 revision）用 If-None-Match: *', async () => {
  let captured = null;
  const p = new WebDavProvider({ transport: mockTransport(async (method, url, opts) => {
    captured = { method, headers: opts.headers };
    return { status: 201, headers: {}, bodyText: '' };
  }) });
  await p.push(emptyBundle, '');
  assert.equal(captured.headers['If-None-Match'], '*');
  assert.ok(!captured.headers['If-Match']);
});

test('push：412 抛 ConflictError（携带远端 revision）', async () => {
  const p = new WebDavProvider({ transport: mockTransport(async () => ({
    status: 412, headers: { etag: '"remote-new"' }, bodyText: ''
  })) });
  await assert.rejects(() => p.push({}, '"local-old"'), (e) => {
    assert.ok(e instanceof ConflictError);
    assert.equal(e.remoteRevision, '"remote-new"');
    return true;
  });
});

test('push：404 提示创建目录', async () => {
  const p = new WebDavProvider({ transport: mockTransport(async () => ({ status: 404, headers: {}, bodyText: '' })) });
  await assert.rejects(() => p.push({}, ''), (e) => {
    assert.ok(e instanceof ProviderError);
    assert.match(e.message, /创建 kanseki-sync 文件夹/);
    return true;
  });
});

test('check：207 = 连接正常', async () => {
  const p = new WebDavProvider({ transport: mockTransport(async () => ({ status: 207, headers: {}, bodyText: '' })) });
  const r = await p.check();
  assert.equal(r.ok, true);
});

test('check：401 = 认证失败', async () => {
  const p = new WebDavProvider({ transport: mockTransport(async () => ({ status: 401, headers: {}, bodyText: '' })) });
  const r = await p.check();
  assert.equal(r.ok, false);
  assert.match(r.message, /认证/);
});

test('createFetchTransport：透传 headers/body 并解析响应', async () => {
  const calls = [];
  const p = new WebDavProvider({
    fetch: async (url, init) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ ok: 1 }), {
        status: 200,
        headers: { ETag: '"etag-x"' }
      });
    }
  });
  const r = await p.pull();
  assert.equal(r.revision, '"etag-x"');
  assert.deepEqual(r.bundle, { settings: [], search_history: [], quick_links: [], catalog_records: [] });
  // 注入 Basic 头
  assert.match(calls[0].init.headers['Authorization'], /^Basic /);
});

test('normalizeBundle：结构容错', () => {
  const n = normalizeBundle(null);
  assert.deepEqual(n.settings, []);
  assert.deepEqual(n.quick_links, []);
  const n2 = normalizeBundle({ settings: [{ key: 'a', value: 'b', updatedAt: 1, deviceId: 'x' }] });
  assert.equal(n2.settings.length, 1);
  assert.ok(Array.isArray(n2.catalog_records));
});
