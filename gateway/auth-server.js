/**
 * Auth service nho — xu ly login/logout/verify cho nginx auth_request
 * Dung cookie + HMAC token, khong can database
 */
const http = require('http');
const crypto = require('crypto');
const { parse: parseCookie } = require('cookie');

const PORT = 3100;
const USERNAME = process.env.AUTH_USERNAME || 'admin';
const PASSWORD = process.env.AUTH_PASSWORD || 'admin';
const SECRET = process.env.JWT_SECRET || 'orcai-dev-secret-change-me';
const TOKEN_TTL = 24 * 60 * 60 * 1000; // 24h
const COOKIE_NAME = 'orcai_token';

// Tao token don gian bang HMAC — khong can JWT library
function createToken(username) {
  const payload = JSON.stringify({ u: username, exp: Date.now() + TOKEN_TTL });
  const b64 = Buffer.from(payload).toString('base64url');
  const sig = crypto.createHmac('sha256', SECRET).update(b64).digest('base64url');
  return `${b64}.${sig}`;
}

function verifyToken(token) {
  if (!token) return null;
  const [b64, sig] = token.split('.');
  if (!b64 || !sig) return null;

  const expected = crypto.createHmac('sha256', SECRET).update(b64).digest('base64url');
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;

  try {
    const payload = JSON.parse(Buffer.from(b64, 'base64url').toString());
    if (payload.exp < Date.now()) return null;
    return payload;
  } catch { return null; }
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', c => data += c);
    req.on('end', () => resolve(data));
  });
}

function getCookieToken(req) {
  const header = req.headers.cookie || '';
  const cookies = parseCookie(header);
  return cookies[COOKIE_NAME] || null;
}

const DOMAIN = process.env.COOKIE_DOMAIN || '';

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  // --- POST /auth/login ---
  if (req.method === 'POST' && url.pathname === '/auth/login') {
    const body = await readBody(req);
    let username, password;
    try {
      const json = JSON.parse(body);
      username = json.username;
      password = json.password;
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Invalid JSON' }));
    }

    // Timing-safe compare
    const userOk = username === USERNAME;
    const passOk = crypto.timingSafeEqual(
      Buffer.from(password || ''),
      Buffer.from(PASSWORD)
    );

    if (!userOk || !passOk) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Invalid credentials' }));
    }

    const token = createToken(username);
    const cookieOpts = [
      `${COOKIE_NAME}=${token}`,
      'Path=/',
      'HttpOnly',
      'SameSite=Lax',
      `Max-Age=${TOKEN_TTL / 1000}`,
    ];
    if (DOMAIN) cookieOpts.push(`Domain=${DOMAIN}`);
    // Production: them Secure flag
    if (process.env.NODE_ENV === 'production') cookieOpts.push('Secure');

    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Set-Cookie': cookieOpts.join('; '),
    });
    return res.end(JSON.stringify({ ok: true, user: username }));
  }

  // --- POST /auth/logout ---
  if (req.method === 'POST' && url.pathname === '/auth/logout') {
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Set-Cookie': `${COOKIE_NAME}=; Path=/; HttpOnly; Max-Age=0`,
    });
    return res.end(JSON.stringify({ ok: true }));
  }

  // --- GET /auth/verify — nginx auth_request goi endpoint nay ---
  if (req.method === 'GET' && url.pathname === '/auth/verify') {
    const token = getCookieToken(req);
    const payload = verifyToken(token);
    if (payload) {
      res.writeHead(200, {
        'Content-Type': 'text/plain',
        'X-Auth-User': payload.u,
      });
      return res.end('OK');
    }
    res.writeHead(401);
    return res.end('Unauthorized');
  }

  // --- GET /auth/me ---
  if (req.method === 'GET' && url.pathname === '/auth/me') {
    const token = getCookieToken(req);
    const payload = verifyToken(token);
    if (payload) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ user: payload.u }));
    }
    res.writeHead(401, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'Not logged in' }));
  }

  res.writeHead(404);
  res.end('Not found');
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[Auth] Listening on :${PORT}`);
  console.log(`[Auth] User: ${USERNAME}`);
});
