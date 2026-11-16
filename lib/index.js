// dsh-group-chat-room — host 薄壳
// 业务在 core.js / route.js。这两个文件按 mtime 热加载：
// 改完存盘，下一次请求就用新代码，不用重启 DSH。
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import fs from 'node:fs';

export const name = 'dsh-group-chat-room';
export const inject = [];

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_DIR = path.resolve(__dirname, '..');

const CORE_FILE = path.join(PLUGIN_DIR, 'lib', 'core.js');
const ROUTE_FILE = path.join(PLUGIN_DIR, 'lib', 'route.js');

let cached = null;
let loading = null;

function stamp() {
  const parts = [];
  for (const f of [CORE_FILE, ROUTE_FILE]) {
    try {
      const st = fs.statSync(f);
      parts.push(st.mtimeMs + '-' + st.size);
    } catch { parts.push('0'); }
  }
  return parts.join('|');
}

async function getHandler() {
  const key = stamp();
  if (cached && cached.key === key) return cached.handler;
  if (loading) {
    await loading;
    if (cached && cached.key === key) return cached.handler;
  }
  loading = (async () => {
    const { createCore } = await import(pathToFileURL(CORE_FILE).href + '?v=' + encodeURIComponent(key));
    const { createRouter } = await import(pathToFileURL(ROUTE_FILE).href + '?v=' + encodeURIComponent(key));
    const core = createCore({ pluginDir: PLUGIN_DIR });
    cached = { key, handler: createRouter({ core, pluginDir: PLUGIN_DIR }) };
  })();
  try {
    await loading;
  } finally {
    loading = null;
  }
  return cached.handler;
}

export function apply(ctx) {
  try {
    let registered = false;

    function tryRegister() {
      if (registered) return true;
      let ws = null;
      try { if (ctx.get) ws = ctx.get('webServer'); } catch { ws = null; }
      if (!ws) { try { ws = ctx.webServer; } catch { ws = null; } }
      if (!ws || typeof ws.register !== 'function') return false;
      try {
        const off = ws.register({
          kind: 'prefix',
          path: '/groupchat',
          handler: async (req, res) => {
            try {
              const handler = await getHandler();
              await handler(req, res);
            } catch (e) {
              try {
                if (!res.headersSent) {
                  res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
                  res.end('group-chat 内部错误: ' + String((e && e.message) || e));
                } else { try { res.end(); } catch {} }
              } catch {}
              console.error('[dsh-group-chat-room] handler error:', e);
            }
          },
        });
        registered = true;
        if (ctx.effect && typeof off === 'function') {
          try { ctx.effect(() => off, 'dsh-group-chat-room:routes'); } catch {}
        }
        return true;
      } catch (e) {
        console.error('[dsh-group-chat-room] webServer.register failed:', e);
        return false;
      }
    }

    if (tryRegister()) return;

    let tries = 0;
    const timer = setInterval(() => {
      tries++;
      if (tryRegister() || tries > 240) {
        if (tries > 240) console.warn('[dsh-group-chat-room] webServer 未出现，路由不注册（不影响启动）');
        clearInterval(timer);
      }
    }, 500);
    if (typeof timer.unref === 'function') timer.unref();
    if (ctx.effect) {
      try { ctx.effect(() => () => clearInterval(timer), 'dsh-group-chat-room:retry'); } catch {}
    }
  } catch (e) {
    console.error('[dsh-group-chat-room] apply failed (已被吞掉):', e);
  }
}

export default { name, inject, apply };
