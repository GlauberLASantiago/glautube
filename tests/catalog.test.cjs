const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const html = fs.readFileSync('index.html', 'utf8');
const script = html.match(/<script>\s*(\(function \(\) \{[\s\S]*?\}\)\(\);)\s*<\/script>/)[1];
const seed = JSON.parse(fs.readFileSync('glautube-banco-inicial.json', 'utf8'));
const storageKey = 'glautube_library_v1';

function startApp(storage, fetchImpl, yt) {
  const elements = new Map();
  function element() {
    return {
      classList: { add() {}, remove() {}, toggle() {} },
      style: {}, children: [], listeners: {},
      appendChild(child) { this.children.push(child); },
      setAttribute() {},
      addEventListener(name, callback) { this.listeners[name] = callback; },
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
    document, window: { YT: yt, addEventListener() {} }, URL,
    localStorage: {
      getItem: (key) => storage.get(key) || null,
      setItem: (key, value) => storage.set(key, value)
    },
    fetch: fetchImpl,
    console: { warn() {}, error() {} },
    setTimeout() {}, clearTimeout() {}, setInterval() {}, clearInterval() {}
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

function fakeYouTube(ids, fail = false) {
  const instances = [];
  function Player(mount, options) {
    const player = this;
    player.cuePlaylist = (request) => {
      player.request = request;
      setImmediate(() => fail
        ? options.events.onError({ target: player })
        : options.events.onStateChange({ data: 5, target: player }));
    };
    player.getPlaylist = () => ids;
    player.destroy = () => { player.destroyed = true; };
    instances.push(player);
    setImmediate(() => options.events.onReady({ target: player }));
  }
  return { Player, PlayerState: { CUED: 5 }, instances };
}

function submitPlaylist(elements, id, name) {
  elements.get('youtube-url-input').value = `https://www.youtube.com/playlist?list=${id}`;
  elements.get('playlist-custom-name').value = name;
  elements.get('import-form').listeners.submit({ preventDefault() {} });
}

test('importa playlist pelo player e preserva progresso de vídeos existentes', async () => {
  const video = { ...seed.videos[0], playlistId: null, currentTime: 123 };
  const storage = new Map([[storageKey, JSON.stringify({
    videos: [video], playlists: {}, seedInitialized: true
  })]]);
  const yt = fakeYouTube([video.id, 'tl80gaCiglo']);
  const elements = startApp(storage, success, yt);
  submitPlaylist(elements, 'PLtest123', 'Minha coleção');
  await flush();
  await flush();
  await flush();
  const result = saved(storage);
  assert.equal(yt.instances[0].request.list, 'PLtest123');
  assert.equal(yt.instances[0].destroyed, true);
  assert.equal(result.playlists.PLtest123.name, 'Minha coleção');
  assert.equal(result.videos.length, 2);
  assert.equal(result.videos[0].currentTime, 123);
  assert.equal(result.videos[0].playlistId, 'PLtest123');
  assert.equal(result.videos[1].playlistOrder, 1);
  assert.equal(elements.get('btn-submit-import').disabled, false);
});

test('falha de playlist não altera biblioteca e libera nova tentativa', async () => {
  const storage = new Map([[storageKey, JSON.stringify({
    videos: [], playlists: {}, seedInitialized: true
  })]]);
  const yt = fakeYouTube([], true);
  const elements = startApp(storage, success, yt);
  submitPlaylist(elements, 'PLprivada', 'Privada');
  await flush();
  await flush();
  await flush();
  assert.equal(saved(storage).videos.length, 0);
  assert.deepEqual(saved(storage).playlists, {});
  assert.equal(elements.get('btn-submit-import').disabled, false);
  assert.equal(yt.instances[0].destroyed, true);
  assert.match(elements.get('toast-container').children.at(-1).children[0].textContent, /Não foi possível acessar/);
});

test('não altera vídeos de outra playlist e informa os itens ignorados', async () => {
  const video = { ...seed.videos[3], currentTime: 50 };
  const storage = new Map([[storageKey, JSON.stringify({
    videos: [video], playlists: seed.playlists, seedInitialized: true
  })]]);
  const yt = fakeYouTube([video.id, '12345678901']);
  const elements = startApp(storage, success, yt);
  submitPlaylist(elements, 'PLnova', 'Nova');
  await flush();
  await flush();
  await flush();
  const result = saved(storage);
  assert.equal(result.videos[0].playlistId, video.playlistId);
  assert.equal(result.videos[0].currentTime, 50);
  assert.equal(result.videos[1].playlistId, 'PLnova');
  assert.match(elements.get('toast-container').children.at(-1).children[0].textContent, /1 vídeo\(s\).*outra playlist/);
});

test('não cria playlist quando o YouTube não fornece IDs válidos', async () => {
  const storage = new Map([[storageKey, JSON.stringify({
    videos: [], playlists: {}, seedInitialized: true
  })]]);
  const yt = fakeYouTube(['inválido']);
  const elements = startApp(storage, success, yt);
  submitPlaylist(elements, 'PLvazia', 'Vazia');
  await flush();
  await flush();
  await flush();
  assert.deepEqual(saved(storage).playlists, {});
  assert.equal(elements.get('btn-submit-import').disabled, false);
  assert.match(elements.get('toast-container').children.at(-1).children[0].textContent, /não contém vídeos válidos/);
});
