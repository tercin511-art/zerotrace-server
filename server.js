/**
 * ZeroTrace — мини-сервер выдачи LiveKit access-токенов.
 *
 * Зачем: телефон не должен носить в себе готовый токен (он живёт минуты и один на всех —
 * второй участник выбивает первого из комнаты, т.к. у обоих одинаковый identity).
 * Приложение спрашивает токен здесь, сервер подписывает его API-секретом, который
 * никогда не покидает сервер.
 *
 * Переменные окружения (на Render задаются в дашборде, локально — в файле .env):
 *   LIVEKIT_URL        wss://<проект>.livekit.cloud
 *   LIVEKIT_API_KEY    API-ключ LiveKit
 *   LIVEKIT_API_SECRET секрет API-ключа (никому не показывать!)
 *   PORT               порт (Render задаёт сам; локально по умолчанию 3000)
 *   TOKEN_TTL          время жизни токена: '30m', '1h', '2 days' (по умолчанию '1h')
 *
 * Эндпоинты:
 *   GET  /health                                       — для health-check Render
 *   GET  /token?room=<комната>&identity=<id>&name=<имя>
 *   POST /token   { "room": "...", "identity": "...", "name": "..." }
 *
 * Ответ: { "url": "wss://...", "token": "<JWT>", "room": "...", "identity": "...", "ttl": "1h" }
 */

import express from 'express';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AccessToken } from 'livekit-server-sdk';

const here = dirname(fileURLToPath(import.meta.url));

// Локальная разработка: подхватываем .env рядом с server.js.
// На Render этот файл не нужен — там переменные приходят из дашборда.
// Отдельная зависимость dotenv для этого не требуется.
const envFile = join(here, '.env');
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (match && !process.env[match[1]]) {
      process.env[match[1]] = match[2].trim().replace(/^["']|["']$/g, '');
    }
  }
}

const LIVEKIT_URL = process.env.LIVEKIT_URL ?? '';
const API_KEY = process.env.LIVEKIT_API_KEY ?? '';
const API_SECRET = process.env.LIVEKIT_API_SECRET ?? '';
const PORT = Number(process.env.PORT ?? 3000);
const TOKEN_TTL = process.env.TOKEN_TTL ?? '1h';
// Render требует слушать 0.0.0.0, а не только localhost.
const HOST = process.env.HOST ?? '0.0.0.0';

if (!LIVEKIT_URL || !API_KEY || !API_SECRET) {
  console.error(
    'Не заданы LIVEKIT_URL / LIVEKIT_API_KEY / LIVEKIT_API_SECRET.\n' +
      'Локально: создайте .env рядом с server.js.\n' +
      'На Render: Settings → Environment Variables.',
  );
  process.exit(1);
}

// ---------------------------------------------------------------- утилиты

// Identity и имя комнаты попадают в логи LiveKit — держим только «безопасные» символы
// и не кладём туда телефоны/ФИО (используем непрозрачный id).
const SAFE_NAME = /^[A-Za-z0-9_.:@+-]{1,64}$/;

function firstDefined(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim() !== '') {
      return value.trim();
    }
  }
  return undefined;
}

/** Создаёт JWT: уникальный identity + право входа в конкретную комнату. */
async function createToken({ room, identity, name }) {
  const accessToken = new AccessToken(API_KEY, API_SECRET, {
    identity,
    name,
    ttl: TOKEN_TTL,
  });

  accessToken.addGrant({
    roomJoin: true,
    room,
    canPublish: true,
    canSubscribe: true,
    canPublishData: true,
  });

  // В серверном SDK v2 toJwt() асинхронный.
  return accessToken.toJwt();
}

// ---------------------------------------------------------------- сервер

const app = express();
app.disable('x-powered-by');
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// CORS — удобно для отладки из браузера. В продакшене ограничьте источники.
app.use((req, res, next) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Headers', 'Content-Type');
  res.set('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  if (req.method === 'OPTIONS') {
    res.sendStatus(204);
    return;
  }
  next();
});

// Health-check: Render опрашивает этот путь, чтобы понять, что сервис поднялся.
app.get('/health', (req, res) => {
  res.json({ status: 'ok', url: LIVEKIT_URL, ttl: TOKEN_TTL });
});

async function issueToken(req, res) {
  const body = req.body ?? {};

  const room = firstDefined(req.query.room, body.room, req.query.roomName, body.roomName);
  const identity = firstDefined(
    req.query.identity,
    body.identity,
    req.query.username,
    body.username,
    req.query.user,
    body.user,
  );
  const name = firstDefined(req.query.name, body.name) ?? identity;

  if (!room) {
    res.status(400).json({ error: 'Не указана комната: параметр "room" обязателен.' });
    return;
  }
  if (!SAFE_NAME.test(room)) {
    res.status(400).json({
      error: 'Комната может содержать только буквы, цифры и символы _ . : @ + - (до 64 знаков).',
    });
    return;
  }

  // Без identity тоже работаем — выдаём уникальный, чтобы участники не выбивали друг друга.
  const participantIdentity = identity ?? `user-${randomBytes(4).toString('hex')}`;
  if (!SAFE_NAME.test(participantIdentity)) {
    res.status(400).json({
      error: 'identity может содержать только буквы, цифры и символы _ . : @ + - (до 64 знаков).',
    });
    return;
  }

  try {
    const token = await createToken({
      room,
      identity: participantIdentity,
      name: name ?? participantIdentity,
    });

    console.log(
      `[token] room=${room} identity=${participantIdentity} name=${name ?? participantIdentity}`,
    );

    res.json({
      url: LIVEKIT_URL,
      token,
      room,
      identity: participantIdentity,
      ttl: TOKEN_TTL,
    });
  } catch (error) {
    console.error('[token] не удалось создать токен:', error);
    res.status(500).json({ error: 'Не удалось создать токен' });
  }
}

app.get('/token', issueToken);
app.post('/token', issueToken);

app.get('/', (req, res) => {
  res.type('text/plain').send(
    'ZeroTrace token server\n\n' +
      'GET  /health\n' +
      'GET  /token?room=test&identity=zerotrace-ab12cd\n' +
      'POST /token  {"room":"test","identity":"zerotrace-ab12cd","name":"Pixel 7"}\n',
  );
});

app.listen(PORT, HOST, () => {
  const publicUrl = process.env.RENDER_EXTERNAL_URL;
  console.log(`ZeroTrace token server слушает ${HOST}:${PORT}`);
  console.log(`LiveKit URL: ${LIVEKIT_URL}, TTL: ${TOKEN_TTL}`);
  if (publicUrl) {
    console.log(`Публичный адрес для приложения: ${publicUrl}/token`);
  }
});
