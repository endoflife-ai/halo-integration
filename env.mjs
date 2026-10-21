// Reads the Halo credentials and the endoflife.ai API key. Values never go
// through arguments or logs: callers get an object, and describeConfig()
// prints only whether each value is set.
//
// Order: the env file (default ./halo.env next to these scripts, or the path
// in HALO_ENV_FILE, or --env <path>), then process environment variables.
//
//   HALO_BASE           https://<your tenant>.halopsa.com
//   HALO_TENANT         tenant id from Configuration > Integrations > Halo API (hosted instances)
//   HALO_CLIENT_ID      client id of the Client Credentials application
//   HALO_CLIENT_SECRET  its client secret
//   HALO_SCOPE          optional, default "all" (Halo trims the token to the application's permissions)
//   EOL_API_KEY         endoflife.ai API key (required from 2026-11-16)
//   EOL_API_BASE        optional, default https://api.endoflife.ai
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.dirname(fileURLToPath(import.meta.url));

export function parseEnv(text) {
  const out = {};
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const i = line.indexOf('=');
    if (i < 1) continue;
    out[line.slice(0, i).trim()] = line.slice(i + 1).trim().replace(/^"(.*)"$/, '$1');
  }
  return out;
}

function readIfExists(p) {
  try { return fs.readFileSync(p, 'utf8'); } catch { return ''; }
}

export function loadConfig(envFile = process.env.HALO_ENV_FILE || path.join(ROOT, 'halo.env')) {
  const f = parseEnv(readIfExists(envFile));
  const get = (k) => f[k] || process.env[k] || '';
  const cfg = {
    base: get('HALO_BASE').replace(/\/+$/, ''),
    tenant: get('HALO_TENANT'),
    clientId: get('HALO_CLIENT_ID'),
    clientSecret: get('HALO_CLIENT_SECRET'),
    scope: get('HALO_SCOPE') || 'all',
    eolApiKey: get('EOL_API_KEY'),
    eolBase: get('EOL_API_BASE') || 'https://api.endoflife.ai',
    envFile,
  };
  cfg.haloReady = !!(cfg.base && cfg.clientId && cfg.clientSecret);
  return cfg;
}

// Safe to print: names and presence only, never secret values.
export function describeConfig(cfg) {
  return `env file ${cfg.envFile}: base ${cfg.base || '(unset)'}, tenant ${cfg.tenant || '(none)'}, client id ${cfg.clientId ? 'set' : 'MISSING'}, client secret ${cfg.clientSecret ? 'set' : 'MISSING'}, scope ${cfg.scope}, endoflife.ai key ${cfg.eolApiKey ? 'set' : 'not set (required from 2026-11-16; free key at https://endoflife.ai/api#free-key)'}`;
}
