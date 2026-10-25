import fs from 'node:fs';
import { spawn } from 'node:child_process';

const TOKEN_RE = /^[A-Za-z0-9_\-=+/.]{20,}$/;

export function buildCloudflaredInvocation(rawCommand) {
  const text = String(rawCommand || '').trim();
  if (!text) throw new Error('Cloudflare Tunnel command cannot be empty.');

  const explicit = text.match(/--token[\s=]+(\S+)/i) || text.match(/\binstall\s+(\S+)/i);
  const candidates = explicit ? [explicit[1]] : text.split(/\s+/);
  const token = candidates.map(c => c.replace(/^["']|["']$/g, '')).find(c => TOKEN_RE.test(c));
  if (!token) {
    throw new Error('No valid Cloudflare tunnel token found. Paste the command containing your tunnel token.');
  }

  const first = text.match(/^"([^"]+)"|^(\S+)/);
  const candidate = first ? (first[1] || first[2]) : '';
  const file = /cloudflared(\.exe)?$/i.test(candidate) && /[\\/]/.test(candidate) && fs.existsSync(candidate)
    ? candidate
    : 'cloudflared';

  return {
    file,
    args: ['tunnel', '--no-autoupdate', 'run', '--token', token],
    redacted: 'cloudflared tunnel --no-autoupdate run --token ***'
  };
}

export function startCloudflaredSafely(rawCommand, options = {}) {
  let invocation;
  try {
    invocation = buildCloudflaredInvocation(rawCommand);
  } catch (err) {
    console.error(`[Cloudflare Tunnel] Not started: ${err.message}`);
    return null;
  }
  console.log(`   > ${invocation.redacted}`);
  const child = spawn(invocation.file, invocation.args, { shell: false, env: { ...process.env }, ...options });
  child.on('error', err => {
    console.error(`[Cloudflare Tunnel] Could not run '${invocation.file}': ${err.message}. Install cloudflared or put it on PATH.`);
  });
  return child;
}
