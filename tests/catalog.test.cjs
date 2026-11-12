const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const html = fs.readFileSync('index.html', 'utf8');
const script = html.match(/<script>\s*(\(function \(\) \{[\s\S]*?\}\)\(\);)\s*<\/script>/)[1];
const seed = JSON.parse(fs.readFileSync('glautube-banco-inicial.json', 'utf8'));
const storageKey = 'glautube_library_v1';

function startApp(storage, fetchImpl) {
  const elements = new Map();
  function element() {
    return {
      classList: { add() {}, remove() {}, toggle() {} },
      style: {}, appendChild() {}, setAttribute() {}, addEventListener() {},
      parentNode: { insertBefore() {} }
    };
  }
  const document = {
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, element());
      return elements.get(id);
    },
    createElement: element,
    getElementsByTagName: () => [element()],
    addEventListener() {}
  };
  const context = {
    document, window: { addEventListener() {} }, URL,
    localStorage: {
      getItem: (key) => storage.get(key) || null,
      setItem: (key, value) => storage.set(key, value)
    },
    fetch: fetchImpl,
    console: { warn() {}, error() {} },
    setTimeout() {}, setInterval() {}, clearInterval() {}
  };
  vm.runInNewContext(script, context);
  return elements;
}

const success = async () => ({ ok: true, json: async () => seed });
const flush = () => new Promise((resolve) => setImmediate(resolve));
const saved = (storage) => JSON.parse(storage.get(storageKey));

test('carrega o banco do repositório e renderiza a biblioteca na primeira execução', async () => {
  const storage = new Map();
  const urls = [];
  const elements = startApp(storage, async (url) => {
    urls.push(url);
    return success();
  });
  await flush();
  assert.deepEqual(urls, ['glautube-banco-inicial.json']);
  assert.equal(saved(storage).videos.length, seed.videos.length);
  assert.equal(Object.keys(saved(storage).playlists).length, Object.keys(seed.playlists).length);
  assert.equal(saved(storage).seedInitialized, true);
  assert.equal(elements.get('sidebar-playlists-total').textContent, 9);
});

test('migra biblioteca existente preservando progresso e não restaura exclusões após sucesso', async () => {
  const video = { ...seed.videos[3], currentTime: 123, completed: true };
  const storage = new Map([[storageKey, JSON.stringify({ videos: [video], playlists: {} })]]);
  startApp(storage, success);
  await flush();
  const state = saved(storage);
  assert.equal(state.videos.length, seed.videos.length);
  assert.equal(state.videos.find((item) => item.id === video.id).currentTime, 123);
  assert.equal(state.videos.find((item) => item.id === video.id).completed, true);
  state.videos = state.videos.filter((item) => item.id !== video.id);
  storage.set(storageKey, JSON.stringify(state));
  let fetched = false;
  startApp(storage, async () => { fetched = true; return success(); });
  await flush();
  assert.equal(fetched, false);
  assert.equal(saved(storage).videos.some((item) => item.id === video.id), false);
});

test('tenta o GitHub se o arquivo local falhar e repete após falha total', async () => {
  const storage = new Map();
  const urls = [];
  startApp(storage, async (url) => {
    urls.push(url);
    throw new Error('offline');
  });
  await flush();
  assert.equal(urls.length, 2);
  assert.equal(saved(storage).seedInitialized, false);
  assert.equal(saved(storage).videos.length, 2);
  const retries = [];
  startApp(storage, async (url) => {
    retries.push(url);
    if (retries.length === 1) return { ok: false, status: 404 };
    return success();
  });
  await flush();
  assert.equal(retries.length, 2);
  assert.match(retries[1], /^https:\/\/raw\.githubusercontent\.com\//);
  assert.equal(saved(storage).videos.length, seed.videos.length);
  assert.equal(saved(storage).seedInitialized, true);
});
