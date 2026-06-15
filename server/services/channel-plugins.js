// Drop this file into claudecodeui at: server/services/channel-plugins.js
//
// It fans out every notification event to enabled plugins whose manifest.json
// declares  "capabilities": ["notificationChannel"]  (e.g. claude-notify).
// Each such plugin receives  POST /notify  { userId, event }  on its RPC server.
//
// Decoupled by design: core knows nothing about Telegram — it just forwards events
// to any installed channel plugin. Errors are swallowed so notifications never break a run.

import http from 'http';
import fs from 'fs';
import path from 'path';
import { scanPlugins, getPluginsConfig, getPluginDir } from '../utils/plugin-loader.js';
import { getPluginPort, startPluginServer } from '../utils/plugin-process-manager.js';

function hasNotificationCapability(name) {
  // Re-read manifest from disk in case the loader strips unknown fields.
  try {
    const dir = getPluginDir(name);
    if (!dir) return false;
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
    return Array.isArray(manifest.capabilities) && manifest.capabilities.includes('notificationChannel');
  } catch {
    return false;
  }
}

function postNotify(port, payload) {
  return new Promise((resolve) => {
    const data = JSON.stringify(payload);
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: '/notify',
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
        timeout: 8000,
      },
      (res) => {
        res.resume();
        res.on('end', resolve);
      }
    );
    req.on('error', () => resolve());
    req.on('timeout', () => {
      req.destroy();
      resolve();
    });
    req.write(data);
    req.end();
  });
}

export async function dispatchToChannelPlugins({ userId, event }) {
  let plugins;
  let config;
  try {
    plugins = scanPlugins();
    config = getPluginsConfig();
  } catch {
    return;
  }

  for (const plugin of plugins) {
    if (!plugin.server) continue;
    if (config[plugin.name]?.enabled === false) continue;
    if (!hasNotificationCapability(plugin.name)) continue;

    let port = getPluginPort(plugin.name);
    if (!port) {
      const dir = getPluginDir(plugin.name);
      if (!dir) continue;
      try {
        port = await startPluginServer(plugin.name, dir, plugin.server);
      } catch {
        continue;
      }
    }
    if (!port) continue;
    await postNotify(port, { userId, event });
  }
}
