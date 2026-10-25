import http from 'node:http';
import { URL } from 'node:url';

const BASE_SECURITY_HEADERS = Object.freeze({
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'X-Frame-Options': 'SAMEORIGIN'
});

export class HttpServer {
  constructor() {
    this.routes = [];
    this.guards = [];
    this.sseClients = new Map();
  }

  register(method, pattern, handler) {
    const paramNames = [];
    const regexPattern = pattern.replace(/:([a-zA-Z0-9_]+)/g, (_, name) => {
      paramNames.push(name);
      return '([^/]+)';
    });

    this.routes.push({
      method: method.toUpperCase(),
      regex: new RegExp(`^${regexPattern}$`),
      paramNames,
      handler
    });
  }

  use(guard) {
    this.guards.push(guard);
  }

  get(pattern, handler) {
    this.register('GET', pattern, handler);
  }

  post(pattern, handler) {
    this.register('POST', pattern, handler);
  }

  delete(pattern, handler) {
    this.register('DELETE', pattern, handler);
  }

  broadcastSse(topic, event, data) {
    const clients = this.sseClients.get(topic);
    if (!clients || clients.size === 0) return;

    const safeJson = (obj) => JSON.stringify(obj, (k, v) => typeof v === 'bigint' ? v.toString() : v);
    const namedPayload = `event: ${event}\ndata: ${safeJson(data)}\n\n`;
    const defaultPayload = `data: ${safeJson({ type: event, ...data, event })}\n\n`;
    const combinedPayload = namedPayload + defaultPayload;
    for (const res of clients) {
      try {
        res.write(combinedPayload);
      } catch {
        clients.delete(res);
      }
    }
  }

  initSse(topic, res) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
      ...BASE_SECURITY_HEADERS
    });

    res.write('event: connected\ndata: {"status":"connected"}\n\n');

    if (!this.sseClients.has(topic)) {
      this.sseClients.set(topic, new Set());
    }
    const set = this.sseClients.get(topic);
    set.add(res);

    const pingInterval = setInterval(() => {
      try {
        res.write(': keepalive\n\n');
      } catch {
        clearInterval(pingInterval);
      }
    }, 15000);
    if (pingInterval.unref) pingInterval.unref();

    res.on('close', () => {
      clearInterval(pingInterval);
      set.delete(res);
      if (set.size === 0) {
        this.sseClients.delete(topic);
      }
    });
  }

  static json(res, statusCode, data) {
    const jsonStr = JSON.stringify(data, (key, value) =>
      typeof value === 'bigint' ? value.toString() : value
    );
    res.writeHead(statusCode, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, Idempotency-Key, X-Device-Id, X-Timestamp, X-Signature, X-Merchant-Key, X-Customer-Token, X-Device-Token',
      ...BASE_SECURITY_HEADERS
    });
    res.end(jsonStr);
  }

  static async parseBody(req) {
    return new Promise((resolve, reject) => {
      let body = '';
      let tooLarge = false;
      req.on('data', chunk => {
        if (tooLarge) return;
        body += chunk;
        if (body.length > 2 * 1024 * 1024) {
          tooLarge = true;
          body = '';
          reject(new Error('Payload Too Large'));
        }
      });
      req.on('end', () => {
        if (tooLarge) return;
        if (!body.trim()) {
          resolve({});
          return;
        }
        try {
          resolve(JSON.parse(body));
        } catch {
          reject(new Error('Malformed JSON body'));
        }
      });
      req.on('error', reject);
    });
  }

  createServer() {
    return http.createServer(async (req, res) => {
      if (req.method === 'OPTIONS') {
        res.writeHead(204, {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization, Idempotency-Key, X-Device-Id, X-Timestamp, X-Signature, X-Merchant-Key, X-Customer-Token, X-Device-Token',
          ...BASE_SECURITY_HEADERS
        });
        res.end();
        return;
      }

      let parsedUrl;
      try {
        parsedUrl = new URL(req.url, 'http://localhost');
      } catch {
        HttpServer.json(res, 400, { error: 'Malformed request URL' });
        return;
      }
      const pathname = parsedUrl.pathname;
      const method = req.method.toUpperCase();

      try {
        for (const guard of this.guards) {
          if (await guard(req, res, pathname, parsedUrl)) return;
        }
      } catch (err) {
        console.error(`Guard Error [${method} ${pathname}]:`, err);
        HttpServer.json(res, 500, { error: 'Internal Server Error' });
        return;
      }

      for (const route of this.routes) {
        if (route.method === method) {
          const match = pathname.match(route.regex);
          if (match) {
            const params = {};
            route.paramNames.forEach((name, index) => {
              params[name] = match[index + 1];
            });

            req.query = Object.fromEntries(parsedUrl.searchParams.entries());

            try {
              await route.handler(req, res, params);
            } catch (err) {
              console.error(`Route Error [${method} ${pathname}]:`, err);
              HttpServer.json(res, 500, { error: 'Internal Server Error' });
            }
            return;
          }
        }
      }

      HttpServer.json(res, 404, { error: 'Route not found' });
    });
  }
}
