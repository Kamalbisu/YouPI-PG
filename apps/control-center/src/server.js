import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ProcessManager } from './process-manager.js';
import { getAdminToken, safeEqual } from '@youpi/common';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const BASE_SECURITY_HEADERS = Object.freeze({
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'SAMEORIGIN',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'"
});

const PUBLIC_PATHS = new Set(['/health', '/', '/dashboard', '/fonts/dm-sans.woff2', '/fonts/sora.woff2']);

function hasAdminToken(req, url = null, pathname = '') {
  const match = /^Bearer\s+(.+)$/i.exec(req.headers?.['authorization'] || '');
  if (match) {
    return safeEqual(match[1].trim(), getAdminToken());
  }
  return false;
}

export class ControlCenterServer {
  constructor(options = {}) {
    this.processManager = options.processManager || new ProcessManager();
    this.htmlTemplatePath = path.join(__dirname, 'views', 'dashboard.html');
    this.template = fs.readFileSync(this.htmlTemplatePath, 'utf8');
    this.sseClients = new Set();

    this.processManager.on('log', (logEntry) => {
      this.broadcastSse('log', logEntry);
    });

    this.processManager.on('status_change', (change) => {
      this.broadcastSse('status_change', change);
    });
  }

  broadcastSse(event, data) {
    if (this.sseClients.size === 0) return;
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const client of this.sseClients) {
      try {
        client.write(payload);
      } catch {
        this.sseClients.delete(client);
      }
    }
  }

  createServer() {
    return http.createServer(async (req, res) => {
      const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      const pathname = url.pathname;
      const method = req.method.toUpperCase();

      if (method === 'OPTIONS') {
        res.writeHead(204, {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization'
        });
        res.end();
        return;
      }

      if (pathname === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'UP', service: 'control-center' }));
        return;
      }

      if (!PUBLIC_PATHS.has(pathname) && !hasAdminToken(req, url, pathname)) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unauthorized', code: 'AUTH_REQUIRED' }));
        return;
      }

      if (pathname === '/api/services' && method === 'GET') {
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        });
        res.end(JSON.stringify(this.processManager.getServicesStatus()));
        return;
      }

      if (pathname === '/api/services/start-all' && method === 'POST') {
        await this.processManager.startAll();
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({ success: true, message: 'All services starting' }));
        return;
      }

      if (pathname === '/api/services/stop-all' && method === 'POST') {
        await this.processManager.stopAll();
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({ success: true, message: 'All services stopping' }));
        return;
      }

      const startMatch = pathname.match(/^\/api\/services\/([a-zA-Z0-9_\-]+)\/start$/);
      if (startMatch && method === 'POST') {
        const id = startMatch[1];
        try {
          const svc = await this.processManager.startService(id);
          res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
          res.end(JSON.stringify({ success: true, service: svc.id, status: svc.status }));
        } catch (err) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        }
        return;
      }

      const stopMatch = pathname.match(/^\/api\/services\/([a-zA-Z0-9_\-]+)\/stop$/);
      if (stopMatch && method === 'POST') {
        const id = stopMatch[1];
        try {
          const svc = await this.processManager.stopService(id);
          res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
          res.end(JSON.stringify({ success: true, service: svc.id, status: svc.status }));
        } catch (err) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        }
        return;
      }

      const restartMatch = pathname.match(/^\/api\/services\/([a-zA-Z0-9_\-]+)\/restart$/);
      if (restartMatch && method === 'POST') {
        const id = restartMatch[1];
        try {
          const svc = await this.processManager.restartService(id);
          res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
          res.end(JSON.stringify({ success: true, service: svc.id, status: svc.status }));
        } catch (err) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        }
        return;
      }

      if (pathname === '/api/logs/stream') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
          'Access-Control-Allow-Origin': 'null',
          ...BASE_SECURITY_HEADERS
        });

        for (const log of this.processManager.logs.slice(-50)) {
          res.write(`event: log\ndata: ${JSON.stringify(log)}\n\n`);
        }

        this.sseClients.add(res);

        const pingTimer = setInterval(() => {
          try { res.write(': keepalive\n\n'); } catch { clearInterval(pingTimer); }
        }, 15000);
        if (pingTimer.unref) pingTimer.unref();

        res.on('close', () => {
          clearInterval(pingTimer);
          this.sseClients.delete(res);
        });
        return;
      }

      const fontMatch = /^\/fonts\/(dm-sans|sora)\.woff2$/.exec(pathname);
      if (fontMatch && method === 'GET') {
        const fontPath = path.resolve(__dirname, '../public/fonts', `${fontMatch[1]}.woff2`);
        if (fs.existsSync(fontPath)) {
          res.writeHead(200, {
            'Content-Type': 'font/woff2',
            'Cache-Control': 'public, max-age=31536000, immutable',
            'X-Content-Type-Options': 'nosniff'
          });
          fs.createReadStream(fontPath).pipe(res);
          return;
        }
      }

      if (pathname === '/' || pathname === '/dashboard') {
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-cache',
          ...BASE_SECURITY_HEADERS
        });
        res.end(this.template);
        return;
      }

      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Control Center Route Not Found');
    });
  }
}
