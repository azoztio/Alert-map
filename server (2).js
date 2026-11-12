// Запуск: ALERTS_TOKEN=ваш_токен node server.js   (нужен Node 18+, зависимостей нет)
const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 3000;
const TOKEN = process.env.ALERTS_TOKEN || "";   // токен с https://alerts.in.ua/api-request
const RU_FEED = process.env.RU_FEED_URL || "";  // необязательно: ваш источник по России (формат ниже)
const TTL = 30 * 1000;                          // кэш, чтобы не превышать лимиты API

// Координаты центров областей Украины (ключ = location_oblast из alerts.in.ua)
const C = {
  "Вінницька область": [49.23, 28.47], "Волинська область": [51.0, 25.3],
  "Дніпропетровська область": [48.46, 35.05], "Донецька область": [48.0, 37.8],
  "Житомирська область": [50.25, 28.66], "Закарпатська область": [48.62, 22.29],
  "Запорізька область": [47.84, 35.14], "Івано-Франківська область": [48.92, 24.71],
  "Київська область": [50.1, 30.5], "м. Київ": [50.45, 30.52],
  "Кіровоградська область": [48.51, 32.26], "Луганська область": [48.57, 39.31],
  "Львівська область": [49.84, 24.03], "Миколаївська область": [46.97, 32.0],
  "Одеська область": [46.48, 30.72], "Полтавська область": [49.59, 34.55],
  "Рівненська область": [50.62, 26.25], "Сумська область": [50.91, 34.8],
  "Тернопільська область": [49.55, 25.59], "Харківська область": [49.99, 36.23],
  "Херсонська область": [46.64, 32.62], "Хмельницька область": [49.42, 26.98],
  "Черкаська область": [49.44, 32.06], "Чернівецька область": [48.29, 25.94],
  "Чернігівська область": [51.5, 31.3], "Автономна Республіка Крим": [45.0, 34.2],
  "м. Севастополь": [44.6, 33.5],
};

const cache = {};
async function cached(key, loader) {
  const c = cache[key];
  if (c && Date.now() - c.t < TTL) return c.v;
  try {
    const v = await loader();
    cache[key] = { t: Date.now(), v };
    return v;
  } catch (e) {
    if (c) return c.v; // при сбое отдаём последнее удачное значение
    throw e;
  }
}

async function ukraine() {
  if (!TOKEN) throw new Error("ALERTS_TOKEN не задан");
  const r = await fetch("https://api.alerts.in.ua/v1/alerts/active.json", {
    headers: { Authorization: "Bearer " + TOKEN },
  });
  if (!r.ok) throw new Error("alerts.in.ua: " + r.status);
  const { alerts = [] } = await r.json();
  const byRegion = {};
  for (const a of alerts) {
    const name = a.location_oblast;
    const pos = C[name];
    if (!pos) continue;
    const g = (byRegion[name] ||= { region: name, lat: pos[0], lon: pos[1], threats: {} });
    const th = (g.threats[a.alert_type] ||= { areas: [], start: Infinity });
    th.areas.push(a.location_title);
    const st = Date.parse(a.started_at);
    if (st) th.start = Math.min(th.start, st);
  }
  return Object.values(byRegion).map((g) => ({
    region: g.region, lat: g.lat, lon: g.lon,
    threats: Object.entries(g.threats).map(([type, t]) => ({ type, areas: t.areas, start: isFinite(t.start) ? t.start : null })),
  }));
}

// Для России официального открытого API нет. Укажите свой JSON-источник в RU_FEED_URL:
// [{ "region":"Белгородская область","lat":50.6,"lon":36.6,
//    "threats":[{"type":"uav","areas":["Белгород"]},{"type":"missile","areas":[]}] }]
// type: uav | missile | air_raid | artillery_shelling | urban_fights | chemical | radiation
async function russia() {
  if (!RU_FEED) return telegram(); // по умолчанию — публичный Telegram-канал
  const r = await fetch(RU_FEED);
  if (!r.ok) throw new Error("RU feed: " + r.status);
  return r.json();
}

// ---------- Telegram-канал (публичная веб-версия t.me/s/<канал>) ----------
const CH = process.env.RU_TG_CHANNEL || "lpr1_treugolnik";
let tgEnded = {}; // "регион|тип" → время отбоя из канала
let tgMovesOut = []; // направления движения из сообщений канала
const WINDOW = 45 * 60 * 1000; // тревога считается активной, если в канале было сообщение за последние 45 мин

// [подстрока в нижнем регистре, название на карте, широта, долгота]
// Названия ДНР/ЛНР/Крым/Запорожье/Херсон совпадают с украинскими ключами, чтобы метки объединялись.
const REG = [
  ["белгород", "Белгородская область", 50.6, 36.6], ["брянск", "Брянская область", 53.25, 34.4],
  ["курск", "Курская область", 51.7, 36.2], ["воронеж", "Воронежская область", 51.67, 39.2],
  ["ростов", "Ростовская область", 47.2, 39.7], ["краснодар", "Краснодарский край", 45.0, 39.0],
  ["адыге", "Республика Адыгея", 44.6, 40.1], ["ставропол", "Ставропольский край", 45.0, 41.97],
  ["волгоград", "Волгоградская область", 48.7, 44.5], ["липецк", "Липецкая область", 52.6, 39.6],
  ["орлов", "Орловская область", 52.97, 36.07], ["тульск", "Тульская область", 54.2, 37.6],
  ["калужск", "Калужская область", 54.5, 36.3], ["смоленск", "Смоленская область", 54.8, 32.05],
  ["тамбов", "Тамбовская область", 52.7, 41.4], ["рязан", "Рязанская область", 54.6, 39.7],
  ["саратов", "Саратовская область", 51.5, 46.0], ["астрахан", "Астраханская область", 46.35, 48.04],
  ["москв", "Москва", 55.75, 37.6], ["московск", "Московская область", 55.5, 38.0],
  ["санкт-петербург", "Санкт-Петербург", 59.94, 30.3], ["ленинградск", "Ленинградская область", 60.0, 30.3],
  ["псков", "Псковская область", 57.8, 28.35],
  ["крым", "Автономна Республіка Крим", 45.0, 34.2], ["севастопол", "м. Севастополь", 44.6, 33.5],
  ["днр", "Донецька область", 48.0, 37.8], ["лнр", "Луганська область", 48.57, 39.31],
  ["запорож", "Запорізька область", 47.84, 35.14], ["херсон", "Херсонська область", 46.64, 32.62],
];
const TYPE = [["ракетн", "missile"], ["бпла", "uav"], ["беспилот", "uav"], ["авиацион", "air_raid"],
  ["воздушн", "air_raid"], ["артобстрел", "artillery_shelling"]];

// Направления: [сдвиг по широте, сдвиг по долготе, азимут]
const DIRS = { "север": [1, 0, 0], "северо-восток": [1, 1, 45], "восток": [0, 1, 90], "юго-восток": [-1, 1, 135],
  "юг": [-1, 0, 180], "юго-запад": [-1, -1, 225], "запад": [0, -1, 270], "северо-запад": [1, -1, 315] };
// «От Кантемировки на восток», «Славяносербск и далее на юго-восток»
const DIR_RE = /(?:(от|из)\s+)?([А-ЯЁ][А-Яа-яё-]+(?:\s[А-ЯЁ][А-Яа-яё-]+)?)\s+(?:и далее\s+)?(?:на|в)\s+(северо-восток|северо-запад|юго-восток|юго-запад|север|юг|запад|восток)/i;

const clean = (h) => h.replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, "")
  .replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

async function tgPosts() {
  const posts = [];
  let before = "";
  for (let i = 0; i < 4; i++) { // до 4 страниц назад, чтобы покрыть окно в 45 минут
    const r = await fetch(`https://t.me/s/${CH}${before}`, { headers: { "User-Agent": "Mozilla/5.0" } });
    if (!r.ok) throw new Error("Telegram: " + r.status);
    const html = await r.text();
    let minId = Infinity, oldest = Infinity;
    for (const c of html.split("tgme_widget_message_wrap").slice(1)) {
      const id = +(c.match(/data-post="[^"\/]+\/(\d+)"/) || [])[1];
      const t = Date.parse((c.match(/<time[^>]*datetime="([^"]+)"/) || [])[1]);
      const m = c.match(/<div class="tgme_widget_message_text[^"]*"[^>]*>([\s\S]*?)<\/div>/);
      if (!id || !t) continue;
      minId = Math.min(minId, id);
      oldest = Math.min(oldest, t);
      if (m) posts.push({ id, t, text: clean(m[1]) });
    }
    if (!isFinite(minId) || oldest < Date.now() - WINDOW) break;
    before = "?before=" + minId;
  }
  return posts.sort((a, b) => a.id - b.id);
}

// Геокодинг населённых пунктов через Nominatim (OpenStreetMap): не чаще 1 запроса/сек, результаты кэшируются
const geoCache = {}, geoQueue = [];
let geoBusy = false, geoDown = 0;
function geo(name, region, lat, lon) {
  const k = (name + "|" + region).toLowerCase();
  if (k in geoCache) return geoCache[k]; // null = не найдено
  if (Date.now() > geoDown && !geoQueue.some((q) => q.k === k)) { geoQueue.push({ k, name, lat, lon }); pump(); }
  return undefined;
}
async function pump() {
  if (geoBusy) return;
  geoBusy = true;
  while (geoQueue.length) {
    const q = geoQueue.shift();
    try {
      const u = new URL("https://nominatim.openstreetmap.org/search");
      u.search = new URLSearchParams({ q: q.name, format: "json", limit: "1", "accept-language": "ru",
        viewbox: [q.lon - 3.5, q.lat + 3, q.lon + 3.5, q.lat - 3].join(","), bounded: "1" });
      const r = await fetch(u, { headers: { "User-Agent": "alert-map/1.0" } });
      if (!r.ok) throw new Error(r.status);
      const j = await r.json();
      geoCache[q.k] = j[0] ? { lat: +j[0].lat, lon: +j[0].lon } : null;
    } catch { geoDown = Date.now() + 5 * 60 * 1000; geoQueue.length = 0; } // сервис недоступен — пауза 5 минут
    await new Promise((s) => setTimeout(s, 1100));
  }
  geoBusy = false;
}

async function telegram() {
  const now = Date.now(), state = {}, ended = {}, dirs = {};
  for (const p of await tgPosts()) {
    if (now - p.t > WINDOW) continue;
    const low = p.text.toLowerCase();
    const types = [...new Set(TYPE.filter(([s]) => low.includes(s)).map((x) => x[1]))];
    const regs = REG.filter(([s]) => low.includes(s));
    if (low.includes("отбой")) { // отбой: снимаем угрозу (нужного типа или все) в указанных регионах
      for (const k of regs.length ? regs.map((r) => r[1]) : Object.keys(state))
        if (state[k]) (types.length ? types : Object.keys(state[k].threats)).forEach((t) => { if (state[k].threats[t]) ended[k + "|" + t] = p.t; delete state[k].threats[t]; });
      continue;
    }
    if (!types.length || !regs.length) continue;
    const dm = p.text.match(DIR_RE);
    if (dm) dirs[(dm[2] + "|" + dm[3]).toLowerCase()] = { name: dm[2], from: !!dm[1], dir: dm[3].toLowerCase(), type: types[0], region: regs[0], t: p.t };
    // Названия населённых пунктов из текста поста (для точек на карте)
    const areas = p.text.split(/\n|,/)
      .map((s) => s.replace(/\s+(днр|лнр)(?=\s|$)/gi, "").replace(/\s*и (близлежащие|далее.*)/i, "").trim())
      .filter((s) => s && s.length < 40 && /^[А-ЯЁ]/.test(s)
        && !/бпла|беспилот|тревог|опасност|повторно|множествен|ракет|област|край|республик|район|все |северн|южн|с моря|^севастополь$|^днр$|^лнр$/i.test(s));
    for (const r of regs) {
      const s = (state[r[1]] ||= { region: r[1], lat: r[2], lon: r[3], threats: {} });
      for (const t of types) {
        const th = (s.threats[t] ||= { type: t, areas: [], start: p.t });
        areas.forEach((a) => th.areas.includes(a) || th.areas.push(a));
      }
    }
  }
  tgEnded = ended;
  tgMovesOut = Object.values(dirs).filter((d) => now - d.t < 20 * 60 * 1000).map((d) => {
    const q = d.from ? d.name.replace(/(и|ы|а|я|у|ю|е)$/i, "") : d.name; // «от Кантемировки» → «Кантемировк»
    const g = geo(q, d.region[1], d.region[2], d.region[3]), v = DIRS[d.dir];
    if (!g || !v) return null;
    const k = v[0] && v[1] ? 0.75 : 1;
    return { type: d.type, name: d.name, dir: d.dir, bearing: v[2], t: d.t,
      from: [g.lat, g.lon], to: [g.lat + v[0] * 0.45 * k, g.lon + v[1] * 0.7 * k] };
  }).filter(Boolean);
  return Object.values(state)
    .map((s) => ({ region: s.region, lat: s.lat, lon: s.lon,
      threats: Object.values(s.threats).map((t) => ({ type: t.type, areas: t.areas.slice(0, 12), start: t.start,
        places: t.areas.slice(0, 8).map((n) => { const g = geo(n, s.region, s.lat, s.lon); return g && { name: n, lat: g.lat, lon: g.lon }; }).filter(Boolean) })) }))
    .filter((s) => s.threats.length);
}

// Объединяет угрозы из разных источников по одному региону
function merge(list) {
  const m = {};
  for (const g of list) {
    const x = (m[g.region] ||= { region: g.region, lat: g.lat, lon: g.lon, threats: [] });
    for (const t of g.threats) {
      const e = x.threats.find((y) => y.type === t.type);
      if (e) { e.areas.push(...(t.areas || [])); e.places.push(...(t.places || [])); if (t.start && (!e.start || t.start < e.start)) e.start = t.start; }
      else x.threats.push({ type: t.type, areas: [...(t.areas || [])], places: [...(t.places || [])], start: t.start || null });
    }
  }
  return Object.values(m);
}

// Запоминаем, когда угроза началась и закончилась (хранится в памяти сервера, при перезапуске обнуляется)
const live = {};      // "регион|тип" → активная угроза
const finished = [];  // закончившиеся за последние 3 часа
const KEEP = 3 * 3600 * 1000;
function track(list) {
  const now = Date.now(), seen = new Set();
  for (const g of list) for (const t of g.threats) {
    const k = g.region + "|" + t.type;
    seen.add(k);
    const starts = [t.start, live[k] && live[k].start].filter(Boolean);
    t.start = starts.length ? Math.min(...starts) : now;
    live[k] = { region: g.region, lat: g.lat, lon: g.lon, type: t.type, areas: t.areas, start: t.start };
  }
  for (const k of Object.keys(live)) {
    if (seen.has(k)) continue;
    finished.unshift({ ...live[k], end: tgEnded[k] || now });
    delete live[k];
  }
  while (finished.length && (finished.length > 50 || now - finished[finished.length - 1].end > KEEP)) finished.pop();
  return finished;
}

http.createServer(async (req, res) => {
  const url = req.url.split("?")[0];
  if (url === "/api/alerts") {
    const out = { updated: new Date().toISOString(), ukraine: [], russia: [], errors: [] };
    await Promise.all([
      cached("ua", ukraine).then((v) => (out.ukraine = v)).catch((e) => out.errors.push(e.message)),
      cached("ru", russia).then((v) => (out.russia = v)).catch((e) => out.errors.push(e.message)),
    ]);
    out.ukraine = merge([...out.ukraine, ...out.russia]);
    out.russia = [];
    out.finished = track(out.ukraine).slice(0, 20);
    out.moves = tgMovesOut;
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    return res.end(JSON.stringify(out));
  }
  // Файлы подтверждения сайта для Google и Яндекса (google....html, yandex_....html)
  if (/^\/(google|yandex_)[\w-]+\.html$/.test(url)) {
    const f = path.join(__dirname, url.slice(1));
    if (fs.existsSync(f)) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return res.end(fs.readFileSync(f));
    }
  }
  fs.readFile(path.join(__dirname, "index.html"), (err, data) => {
    if (err) { res.writeHead(500); return res.end("index.html не найден"); }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(data);
  });
}).listen(PORT, () => console.log("http://localhost:" + PORT));
