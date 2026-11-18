#!/usr/bin/env node
/**
 * Génère le README du profil + les cartes SVG (assets/) à partir de l'API GitHub,
 * dépôts privés compris.
 *
 *   En local : GH_TOKEN=$(gh auth token) node scripts/generate.mjs
 *   En CI    : .github/workflows/update-readme.yml (secret STATS_TOKEN)
 *
 * Aucune dépendance : Node >= 20 (fetch natif). Réglages : readme.config.json.
 * Couleur : "palette" = green | blue | purple | mono, ou n'importe quelle couleur hex ("#e8590c").
 * Seul le bloc entre <!-- STATS:START --> et <!-- STATS:END --> du README est réécrit.
 */
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG = JSON.parse(await readFile(path.join(ROOT, 'readme.config.json'), 'utf8'));
const OWNER = CONFIG.owner;
const TZ = CONFIG.timezone ?? 'Europe/Paris';
const TOKEN = process.env.STATS_TOKEN || process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
const DAY = 86_400_000;
const NOW = new Date();

// Couleur d'accent (graphiques, calendrier, sparklines) : "palette" dans readme.config.json
const PALETTES = {
  green: {
    light: { accent: '#1a7f37', heat: ['#ebedf0', '#9be9a8', '#40c463', '#30a14e', '#216e39'] },
    dark: { accent: '#3fb950', heat: ['#151b23', '#0e4429', '#006d32', '#26a641', '#39d353'] },
  },
  blue: {
    light: { accent: '#0969da', heat: ['#eff2f5', '#b6e3ff', '#54aeff', '#0969da', '#0a3069'] },
    dark: { accent: '#4493f8', heat: ['#151b23', '#0c2d6b', '#1158c7', '#388bfd', '#a5d6ff'] },
  },
  purple: {
    light: { accent: '#8250df', heat: ['#eff2f5', '#e0ccff', '#b88cfa', '#8250df', '#512a97'] },
    dark: { accent: '#a371f7', heat: ['#151b23', '#3c1e70', '#6e40c9', '#a371f7', '#e2c5ff'] },
  },
  mono: {
    light: { accent: '#59636e', heat: ['#eff2f5', '#d1d9e0', '#9198a1', '#59636e', '#1f2328'] },
    dark: { accent: '#9198a1', heat: ['#151b23', '#2f3742', '#59636e', '#9198a1', '#f0f6fc'] },
  },
};
/** Mélange deux couleurs hex : k = 0 → a, k = 1 → b */
function mix(a, b, k) {
  const [na, nb] = [parseInt(a.slice(1), 16), parseInt(b.slice(1), 16)];
  return `#${[16, 8, 0]
    .map((s) => Math.round(((na >> s) & 255) + (((nb >> s) & 255) - ((na >> s) & 255)) * k).toString(16).padStart(2, '0'))
    .join('')}`;
}
/** Palette complète (thèmes clair + sombre) dérivée d'une seule couleur, ex. "#e8590c" */
function paletteFromHex(hex) {
  const onDark = mix(hex, '#ffffff', 0.2);
  return {
    light: { accent: hex, heat: ['#eff2f5', mix(hex, '#ffffff', 0.75), mix(hex, '#ffffff', 0.45), hex, mix(hex, '#000000', 0.35)] },
    dark: { accent: onDark, heat: ['#151b23', mix(hex, '#151b23', 0.7), mix(hex, '#151b23', 0.4), onDark, mix(hex, '#ffffff', 0.55)] },
  };
}
// "palette" : un nom (green, blue, purple, mono) ou une couleur hex (#rrggbb)
const PALETTE_NAME = String(process.env.README_PALETTE ?? CONFIG.palette ?? 'purple').trim();
const PALETTE = /^#[0-9a-f]{6}$/i.test(PALETTE_NAME) ? paletteFromHex(PALETTE_NAME.toLowerCase()) : PALETTES[PALETTE_NAME];
if (!PALETTE) {
  throw new Error(`Palette inconnue « ${PALETTE_NAME} » : utiliser ${Object.keys(PALETTES).join(', ')} ou une couleur hex comme "#e8590c".`);
}

if (!TOKEN) {
  console.error('Aucun token : définir STATS_TOKEN ou GH_TOKEN (ex. GH_TOKEN=$(gh auth token)).');
  process.exit(1);
}

// ─────────────────────────────── API GitHub ───────────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SKIP = new Set([204, 404, 409]); // 409 = dépôt vide

async function request(url, accept = 'application/vnd.github+json') {
  const full = url.startsWith('http') ? url : `https://api.github.com${url}`;
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(full, {
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        Accept: accept,
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'profile-readme-stats',
      },
    });
    if ([202, 429, 500, 502, 503, 504].includes(res.status) && attempt < 5) {
      await sleep(1500 * attempt);
      continue;
    }
    if (res.status === 403 && res.headers.get('x-ratelimit-remaining') === '0') {
      throw new Error('Quota de l’API GitHub épuisé, réessayer plus tard.');
    }
    return res;
  }
}

async function api(url) {
  const res = await request(url);
  if (SKIP.has(res.status)) return null;
  if (!res.ok) throw new Error(`${res.status} ${url} — ${await res.text()}`);
  return res.json();
}

async function raw(url) {
  const res = await request(url, 'application/vnd.github.raw+json');
  return res.ok ? res.text() : null;
}

async function paginate(url) {
  const out = [];
  for (let next = url; next; ) {
    const res = await request(next);
    if (SKIP.has(res.status)) break;
    if (!res.ok) throw new Error(`${res.status} ${next} — ${await res.text()}`);
    out.push(...(await res.json()));
    next = res.headers.get('link')?.match(/<([^>]+)>;\s*rel="next"/)?.[1];
  }
  return out;
}

async function countCommits(url) {
  const res = await request(url);
  if (!res.ok) return 0;
  const last = res.headers.get('link')?.match(/[?&]page=(\d+)>;\s*rel="last"/)?.[1];
  return last ? Number(last) : (await res.json()).length;
}

async function pool(items, size, fn) {
  const out = new Array(items.length);
  let i = 0;
  const worker = async () => {
    while (i < items.length) {
      const k = i++;
      out[k] = await fn(items[k], k);
    }
  };
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, worker));
  return out;
}

// ─────────────────────────────── Dates & format ───────────────────────────────

const partsFmt = new Intl.DateTimeFormat('en-US', {
  timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23', weekday: 'short',
});
const EN_DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
/** Date → { key: 'AAAA-MM-JJ', hour, dow (0 = lundi) } dans le fuseau configuré */
function local(date) {
  const p = Object.fromEntries(partsFmt.formatToParts(date).map((x) => [x.type, x.value]));
  return { key: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour) % 24, dow: EN_DAYS.indexOf(p.weekday) };
}
const keyToMs = (k) => Date.UTC(+k.slice(0, 4), +k.slice(5, 7) - 1, +k.slice(8, 10));
const msToKey = (ms) => new Date(ms).toISOString().slice(0, 10);

const nf = new Intl.NumberFormat('fr-FR');
const fmt = (n) => nf.format(n);
const pct = (x) => `${x.toLocaleString('fr-FR', { maximumFractionDigits: x < 10 ? 1 : 0 })} %`;
const mo = (bytes) => `${(bytes / 1e6).toLocaleString('fr-FR', { maximumFractionDigits: 1 })} Mo`;
const plural = (n, one, many = `${one}s`) => `${fmt(n)} ${n > 1 ? many : one}`;
const MONTHS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];
const MONTHS_SHORT = ['janv.', 'févr.', 'mars', 'avr.', 'mai', 'juin', 'juil.', 'août', 'sept.', 'oct.', 'nov.', 'déc.'];
const DAYS = ['lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi', 'dimanche'];
const frDate = (key, short = false) =>
  `${+key.slice(8, 10)} ${(short ? MONTHS_SHORT : MONTHS)[+key.slice(5, 7) - 1]} ${key.slice(0, 4)}`;

const today = local(NOW);
const todayMs = keyToMs(today.key);
const WEEKS = 53;
const gridStartMs = todayMs - ((WEEKS - 1) * 7 + today.dow) * DAY; // lundi, 52 semaines avant la semaine en cours
const SINCE = new Date(gridStartMs - DAY).toISOString();
const YEAR_AGO = NOW.getTime() - 365 * DAY;

function daysAgo(date) {
  return Math.round((todayMs - keyToMs(local(date).key)) / DAY);
}
function relative(date) {
  const d = daysAgo(date);
  if (d <= 0) return 'aujourd’hui';
  if (d === 1) return 'hier';
  if (d < 7) return `il y a ${d} j`;
  if (d < 30) return `il y a ${Math.round(d / 7)} sem.`;
  if (d < 365) return `il y a ${Math.round(d / 30.4)} mois`;
  const y = Math.floor(d / 365);
  return `il y a ${y} an${y > 1 ? 's' : ''}`;
}

// ─────────────────────────────── Détection de stack ───────────────────────────────

const dep = (...names) => (h) => names.some((n) => h.deps.has(n));
const py = (...names) => (h) => names.some((n) => h.py.has(n));
const any = (...tests) => (h) => tests.some((t) => t(h));
const file = (re) => (h) => h.files.some((f) => re.test(f));
const prefix = (p) => (h) => [...h.deps].some((d) => d.startsWith(p));
const text = (re) => (h) => re.test(h.text);

const CATEGORIES = {
  front: 'Interfaces',
  desktop: 'Desktop & natif',
  back: 'Back-end & données',
  ai: 'IA',
  tooling: 'Outillage, tests & déploiement',
};

// L'ordre compte : il sert de priorité pour la colonne « Stack » du tableau.
const TECH = [
  { name: 'Next.js', logo: 'nextdotjs', color: '000000', cat: 'front', test: dep('next') },
  { name: 'Nuxt', logo: 'nuxt', color: '00DC82', cat: 'front', test: dep('nuxt') },
  { name: 'React', logo: 'react', color: '087EA4', cat: 'front', test: dep('react'), impliedBy: ['Next.js', 'React Native'] },
  { name: 'Vue.js', logo: 'vuedotjs', color: '42B883', cat: 'front', test: dep('vue'), impliedBy: ['Nuxt'] },
  { name: 'Svelte', logo: 'svelte', color: 'FF3E00', cat: 'front', test: dep('svelte') },
  { name: 'Tailwind CSS', logo: 'tailwindcss', color: '06B6D4', cat: 'front', test: dep('tailwindcss', '@tailwindcss/vite', '@tailwindcss/postcss') },
  { name: 'shadcn/ui', logo: 'shadcnui', color: '000000', cat: 'front', test: file(/(^|\/)components\.json$/) },
  { name: 'Radix UI', logo: 'radixui', color: '161618', cat: 'front', test: any(prefix('@radix-ui/'), dep('radix-ui')) },
  { name: 'MUI', logo: 'mui', color: '007FFF', cat: 'front', test: dep('@mui/material') },
  { name: 'Three.js', logo: 'threedotjs', color: '000000', cat: 'front', test: dep('three') },
  { name: 'Motion', logo: 'framer', color: '0055FF', cat: 'front', test: dep('framer-motion', 'motion') },
  { name: 'TanStack Query', logo: 'reactquery', color: 'FF4154', cat: 'front', test: dep('@tanstack/react-query', '@tanstack/vue-query') },
  { name: 'Zustand', logo: '', color: '443E38', cat: 'front', test: dep('zustand') },
  { name: 'Pinia', logo: '', color: 'FFD859', logoColor: 'black', cat: 'front', test: dep('pinia') },
  { name: 'Leaflet', logo: 'leaflet', color: '199900', cat: 'front', test: dep('leaflet', 'react-leaflet', '@vue-leaflet/vue-leaflet') },
  { name: 'MapLibre', logo: 'maplibre', color: '396CB2', cat: 'front', test: dep('maplibre-gl', 'react-map-gl') },
  { name: 'Mapbox', logo: 'mapbox', color: '000000', cat: 'front', test: dep('mapbox-gl') },
  { name: 'MDX', logo: 'mdx', color: '1B1F24', cat: 'front', test: any(prefix('@mdx-js/'), dep('next-mdx-remote', '@next/mdx'), file(/\.mdx$/)) },
  { name: 'PWA', logo: 'pwa', color: '5A0FC8', cat: 'front', test: dep('vite-plugin-pwa', 'next-pwa', '@ducanh2912/next-pwa', '@serwist/next', 'workbox-window') },

  { name: 'Tauri', logo: 'tauri', color: '24C8D8', cat: 'desktop', test: any(prefix('@tauri-apps/'), (h) => h.cargo.has('tauri')) },
  { name: 'Electron', logo: 'electron', color: '47848F', cat: 'desktop', test: dep('electron') },
  { name: 'React Native', logo: 'react', color: '20232A', cat: 'desktop', test: dep('react-native') },
  { name: 'Expo', logo: 'expo', color: '000020', cat: 'desktop', test: dep('expo') },
  { name: 'Capacitor', logo: 'capacitor', color: '119EFF', cat: 'desktop', test: dep('@capacitor/core') },
  { name: 'Rust', logo: 'rust', color: '000000', cat: 'desktop', test: file(/(^|\/)Cargo\.toml$/), impliedBy: ['Tauri'] },

  { name: 'Express', logo: 'express', color: '000000', cat: 'back', test: dep('express') },
  { name: 'Fastify', logo: 'fastify', color: '000000', cat: 'back', test: dep('fastify') },
  { name: 'NestJS', logo: 'nestjs', color: 'E0234E', cat: 'back', test: dep('@nestjs/core') },
  { name: 'Hono', logo: 'hono', color: 'E36002', cat: 'back', test: dep('hono') },
  { name: 'FastAPI', logo: 'fastapi', color: '009688', cat: 'back', test: py('fastapi') },
  { name: 'Django', logo: 'django', color: '092E20', cat: 'back', test: py('django') },
  { name: 'Flask', logo: 'flask', color: '000000', cat: 'back', test: py('flask') },
  { name: 'tRPC', logo: 'trpc', color: '2596BE', cat: 'back', test: dep('@trpc/server') },
  { name: 'Socket.IO', logo: 'socketdotio', color: '010101', cat: 'back', test: dep('socket.io', 'socket.io-client') },
  { name: 'Prisma', logo: 'prisma', color: '2D3748', cat: 'back', test: dep('prisma', '@prisma/client') },
  { name: 'Drizzle', logo: 'drizzle', color: 'C5F74F', logoColor: 'black', cat: 'back', test: dep('drizzle-orm') },
  { name: 'SQLAlchemy', logo: 'sqlalchemy', color: 'D71F00', cat: 'back', test: py('sqlalchemy') },
  { name: 'Supabase', logo: 'supabase', color: '3FCF8E', cat: 'back', test: any(dep('@supabase/supabase-js', '@supabase/ssr'), file(/(^|\/)supabase\/config\.toml$/)) },
  { name: 'PostgreSQL', logo: 'postgresql', color: '4169E1', cat: 'back', test: any(dep('pg', 'postgres', '@neondatabase/serverless'), py('psycopg', 'psycopg2', 'psycopg2-binary', 'asyncpg'), (h) => h.langs.has('PLpgSQL'), text(/provider\s*=\s*["']postgresql["']|image:\s*["']?(postgres|postgis|supabase\/postgres)|postgres(ql)?:\/\//i)) },
  { name: 'MySQL', logo: 'mysql', color: '4479A1', cat: 'back', test: any(dep('mysql2', 'mysql'), py('pymysql', 'mysqlclient'), text(/provider\s*=\s*["']mysql["']|image:\s*["']?(mysql|mariadb)|mysql:\/\//i)) },
  { name: 'SQLite', logo: 'sqlite', color: '003B57', cat: 'back', test: any(dep('better-sqlite3', 'sqlite3', '@libsql/client', 'sql.js'), text(/provider\s*=\s*["']sqlite["']|sqlite:/i)) },
  { name: 'MongoDB', logo: 'mongodb', color: '47A248', cat: 'back', test: any(dep('mongoose', 'mongodb'), py('pymongo', 'motor')) },
  { name: 'Redis', logo: 'redis', color: 'FF4438', cat: 'back', test: any(dep('redis', 'ioredis', 'bullmq'), py('redis'), text(/image:\s*["']?(redis|valkey)/i)) },
  { name: 'Zod', logo: 'zod', color: '3E67B1', cat: 'back', test: dep('zod') },
  { name: 'Pydantic', logo: 'pydantic', color: 'E92063', cat: 'back', test: py('pydantic') },
  { name: 'Stripe', logo: 'stripe', color: '635BFF', cat: 'back', test: any(dep('stripe', '@stripe/stripe-js'), py('stripe')) },

  { name: 'OpenAI', logo: 'openai', color: '412991', cat: 'ai', test: any(dep('openai', '@ai-sdk/openai'), py('openai')) },
  { name: 'Claude', logo: 'claude', color: 'D97757', cat: 'ai', test: any(dep('@anthropic-ai/sdk', '@ai-sdk/anthropic', '@anthropic-ai/claude-agent-sdk'), py('anthropic')) },
  { name: 'Gemini', logo: 'googlegemini', color: '8E75B2', cat: 'ai', test: any(dep('@google/genai', '@google/generative-ai', '@ai-sdk/google'), py('google-genai', 'google-generativeai')) },
  { name: 'Mistral', logo: 'mistralai', color: 'FA520F', cat: 'ai', test: any(dep('@mistralai/mistralai', '@ai-sdk/mistral'), py('mistralai')) },
  { name: 'Vercel AI SDK', logo: 'vercel', color: '000000', cat: 'ai', test: dep('ai') },
  { name: 'Replicate', logo: 'replicate', color: '000000', cat: 'ai', test: any(dep('replicate'), py('replicate')) },
  { name: 'LangChain', logo: 'langchain', color: '1C3C3C', cat: 'ai', test: any(prefix('@langchain/'), dep('langchain'), py('langchain')) },
  { name: 'MCP', logo: 'modelcontextprotocol', color: '000000', cat: 'ai', test: any(prefix('@modelcontextprotocol/'), py('mcp', 'fastmcp')) },

  { name: 'Vite', logo: 'vite', color: '646CFF', cat: 'tooling', test: dep('vite') },
  { name: 'Turborepo', logo: 'turborepo', color: 'EF4444', cat: 'tooling', test: any(dep('turbo'), file(/^turbo\.json$/)) },
  { name: 'pnpm', logo: 'pnpm', color: 'F69220', cat: 'tooling', test: file(/^pnpm-lock\.yaml$/) },
  { name: 'Vitest', logo: 'vitest', color: '6E9F18', cat: 'tooling', test: dep('vitest') },
  { name: 'Jest', logo: 'jest', color: 'C21325', cat: 'tooling', test: dep('jest') },
  { name: 'Playwright', logo: 'playwright', color: '2EAD33', cat: 'tooling', test: dep('@playwright/test', 'playwright') },
  { name: 'pytest', logo: 'pytest', color: '0A9EDC', cat: 'tooling', test: py('pytest') },
  { name: 'Storybook', logo: 'storybook', color: 'FF4785', cat: 'tooling', test: prefix('@storybook/') },
  { name: 'Sentry', logo: 'sentry', color: '362D59', cat: 'tooling', test: any(prefix('@sentry/'), py('sentry-sdk')) },
  { name: 'Docker', logo: 'docker', color: '2496ED', cat: 'tooling', test: file(/(^|\/)(Dockerfile|docker-compose[^/]*\.ya?ml|compose\.ya?ml)$/) },
  { name: 'GitHub Actions', logo: 'githubactions', color: '2088FF', cat: 'tooling', test: file(/^\.github\/workflows\/[^/]+\.ya?ml$/) },
  { name: 'PM2', logo: 'pm2', color: '2B037A', cat: 'tooling', test: any(dep('pm2'), file(/(^|\/)ecosystem\.config\.[cm]?js$/)) },
];

const IGNORED = /(^|\/)(node_modules|vendor|dist|build|\.next|\.nuxt|\.venv|venv|target|coverage)\//;
const TEST_FILE = /(\.(test|spec)\.[cm]?[jt]sx?$)|((^|\/)(test_[^/]+|[^/]+_test)\.py$)|(\.(test|spec)\.rs$)/;
const AGENT_FILE = /(^|\/)(CLAUDE|AGENTS)\.md$/;

async function detectStack(base, files, languages) {
  const shallowFirst = (re, max) =>
    files.filter((f) => re.test(f)).sort((a, b) => a.split('/').length - b.split('/').length).slice(0, max);
  const read = (p) => raw(`${base}/contents/${p.split('/').map(encodeURIComponent).join('/')}`);

  const h = { deps: new Set(), py: new Set(), cargo: new Set(), files, langs: new Set(Object.keys(languages)), text: '' };
  const texts = [];
  await Promise.all([
    ...shallowFirst(/(^|\/)package\.json$/, 40).map(async (p) => {
      try {
        const j = JSON.parse((await read(p)) ?? '{}');
        for (const k of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
          Object.keys(j[k] ?? {}).forEach((d) => h.deps.add(d));
        }
      } catch {}
    }),
    ...shallowFirst(/(^|\/)(requirements[^/]*\.txt|pyproject\.toml|Pipfile)$/, 10).map(async (p) => {
      const t = (await read(p)) ?? '';
      const add = (n) => h.py.add(n.toLowerCase().replace(/_/g, '-'));
      for (const m of t.matchAll(/^\s*["']?([A-Za-z0-9][A-Za-z0-9._-]*)/gm)) add(m[1]);
      for (const m of t.matchAll(/["']([A-Za-z0-9][A-Za-z0-9._-]*)\s*(?:\[[^\]]*\])?\s*(?:[<>=~!;]|["'])/g)) add(m[1]);
    }),
    ...shallowFirst(/(^|\/)Cargo\.toml$/, 10).map(async (p) => {
      const t = (await read(p)) ?? '';
      for (const m of t.matchAll(/^\s*([A-Za-z0-9_-]+)\s*=/gm)) h.cargo.add(m[1]);
    }),
    ...shallowFirst(/(^|\/)(schema\.prisma|docker-compose[^/]*\.ya?ml|compose\.ya?ml|drizzle\.config\.[cm]?[jt]s|\.env\.example)$/, 8).map(
      async (p) => texts.push((await read(p)) ?? ''),
    ),
  ]);
  h.text = texts.join('\n');
  return new Set(TECH.filter((t) => t.test(h)).map((t) => t.name));
}

// ─────────────────────────────── Collecte ───────────────────────────────

async function listRepos() {
  try {
    return await paginate('/user/repos?per_page=100&affiliation=owner,collaborator,organization_member');
  } catch {
    // Token d'installation (GITHUB_TOKEN) : pas d'accès à /user → dépôts publics uniquement.
    console.warn('⚠ /user/repos inaccessible, repli sur les dépôts publics uniquement.');
    return paginate(`/users/${OWNER}/repos?per_page=100&type=owner`);
  }
}

async function collect(r) {
  const base = `/repos/${r.full_name}`;
  const sha = encodeURIComponent(r.default_branch);
  const [languages, totalCommits, commits, contributors, tree] = await Promise.all([
    api(`${base}/languages`).then((x) => x ?? {}),
    countCommits(`${base}/commits?sha=${sha}&per_page=1`),
    paginate(`${base}/commits?sha=${sha}&since=${SINCE}&per_page=100`),
    paginate(`${base}/contributors?per_page=100`),
    api(`${base}/git/trees/${sha}?recursive=1`),
  ]);
  const files = (tree?.tree ?? []).filter((e) => e.type === 'blob' && !IGNORED.test(e.path)).map((e) => e.path);
  const techs = await detectStack(base, files, languages);
  console.log(`  ✓ ${r.name.padEnd(24)} ${String(totalCommits).padStart(5)} commits · ${techs.size} technos`);
  return {
    name: r.name,
    private: r.private,
    archived: r.archived,
    url: r.html_url,
    description: r.description,
    createdAt: new Date(r.created_at),
    pushedAt: new Date(r.pushed_at),
    languages,
    totalCommits,
    commits: commits
      .map((c) => new Date(c.commit?.author?.date ?? c.commit?.committer?.date))
      .filter((d) => !Number.isNaN(d.getTime())),
    contributors: contributors.filter((c) => c.type === 'User'),
    fileCount: files.length,
    testFiles: files.filter((f) => TEST_FILE.test(f)).length,
    agentReady: files.some((f) => AGENT_FILE.test(f)),
    techs,
  };
}

console.log(`→ Dépôts de ${OWNER}…`);
const excluded = new Set((CONFIG.exclude ?? []).map((s) => s.toLowerCase()));
const repos = (await listRepos()).filter(
  (r) =>
    r.owner.login.toLowerCase() === OWNER.toLowerCase() &&
    !excluded.has(r.name.toLowerCase()) &&
    (CONFIG.includeForks || !r.fork) &&
    !CONFIG.projects?.[r.name]?.hide,
);
if (!repos.length) throw new Error(`Aucun dépôt visible pour ${OWNER} avec ce token.`);
const projects = (await pool(repos, 4, collect)).sort((a, b) => b.pushedAt - a.pushedAt);

// Noms affichés (anonymisation optionnelle des dépôts privés)
{
  const anon = CONFIG.privateRepos?.showNames === false;
  const showDesc = CONFIG.privateRepos?.showDescriptions !== false;
  let n = 0;
  for (const p of [...projects].sort((a, b) => a.createdAt - b.createdAt)) {
    const o = CONFIG.projects?.[p.name] ?? {};
    const masked = p.private && anon && !o.name;
    p.display = o.name ?? (masked ? `Projet confidentiel ${++n}` : p.name);
    p.desc = o.description ?? (masked || (p.private && !showDesc) ? null : p.description);
  }
}

// ─────────────────────────────── Agrégats ───────────────────────────────

const allDates = projects.flatMap((p) => p.commits);
const yearDates = allDates.filter((d) => d.getTime() > YEAR_AGO);

const byDay = new Map();
const punch = Array.from({ length: 7 }, () => new Array(24).fill(0));
for (const d of allDates) {
  const l = local(d);
  if (keyToMs(l.key) >= gridStartMs) byDay.set(l.key, (byDay.get(l.key) ?? 0) + 1);
  if (d.getTime() > YEAR_AGO) punch[l.dow][l.hour]++;
}

const langBytes = {};
for (const p of projects) for (const [l, b] of Object.entries(p.languages)) langBytes[l] = (langBytes[l] ?? 0) + b;
const totalBytes = Object.values(langBytes).reduce((a, b) => a + b, 0);
const langs = Object.entries(langBytes).sort((a, b) => b[1] - a[1]);

const team = new Map();
const teamExclude = new Set([OWNER, ...(CONFIG.team?.exclude ?? [])].map((s) => s.toLowerCase()));
for (const p of projects) {
  for (const c of p.contributors) {
    const t = team.get(c.login) ?? { login: c.login, avatar: c.avatar_url, url: c.html_url, commits: 0 };
    t.commits += c.contributions;
    team.set(c.login, t);
  }
}
const humans = [...team.values()];
const teamShown = humans.filter((t) => !teamExclude.has(t.login.toLowerCase())).sort((a, b) => a.login.localeCompare(b.login));

const stats = {
  projects: projects.length,
  privateCount: projects.filter((p) => p.private).length,
  commits: projects.reduce((a, p) => a + p.totalCommits, 0),
  yearCommits: yearDates.length,
  contributors: teamShown.length || humans.length,
  bytes: totalBytes,
  languages: langs.length,
  active: projects.filter((p) => daysAgo(p.pushedAt) <= 30).length,
  since: Math.min(...projects.map((p) => p.createdAt.getFullYear())),
};

// Faits marquants
const facts = (() => {
  const n = yearDates.length || 1;
  let night = 0, weekend = 0;
  for (const d of yearDates) {
    const l = local(d);
    if (l.hour >= 22 || l.hour < 6) night++;
    if (l.dow >= 5) weekend++;
  }
  const dowTotals = punch.map((row) => row.reduce((a, b) => a + b, 0));
  const hourTotals = Array.from({ length: 24 }, (_, h) => punch.reduce((a, row) => a + row[h], 0));
  const peakDow = dowTotals.indexOf(Math.max(...dowTotals));
  const peakHour = hourTotals.indexOf(Math.max(...hourTotals));

  let record = { key: null, count: 0 };
  for (const [key, count] of byDay) if (keyToMs(key) > todayMs - 365 * DAY && count > record.count) record = { key, count };

  let longest = 0, run = 0;
  for (let ms = todayMs - 364 * DAY; ms <= todayMs; ms += DAY) {
    run = byDay.get(msToKey(ms)) ? run + 1 : 0;
    longest = Math.max(longest, run);
  }
  let current = 0;
  for (let ms = byDay.get(today.key) ? todayMs : todayMs - DAY; byDay.get(msToKey(ms)); ms -= DAY) current++;

  const month = projects
    .map((p) => ({ p, n: p.commits.filter((d) => d.getTime() > NOW.getTime() - 30 * DAY).length }))
    .sort((a, b) => b.n - a.n)[0];
  const oldest = [...projects].sort((a, b) => a.createdAt - b.createdAt)[0];

  return {
    nightPct: (night / n) * 100,
    weekendPct: (weekend / n) * 100,
    peakDow, peakHour, record, longest, current,
    hotProject: month?.n ? month : null,
    oldest,
    agentReady: projects.filter((p) => p.agentReady).length,
    testFiles: projects.reduce((a, p) => a + p.testFiles, 0),
    files: projects.reduce((a, p) => a + p.fileCount, 0),
  };
})();

// ─────────────────────────────── SVG ───────────────────────────────

const THEMES = {
  light: {
    dark: false,
    bg: '#ffffff', border: '#d1d9e0', text: '#1f2328', muted: '#59636e', faint: '#d1d9e0', tile: '#f6f8fa',
    ok: '#1a7f37', warn: '#bf8700',
    ...PALETTE.light,
  },
  dark: {
    dark: true,
    bg: '#0d1117', border: '#3d444d', text: '#f0f6fc', muted: '#9198a1', faint: '#3d444d', tile: '#151b23',
    ok: '#3fb950', warn: '#d29922',
    ...PALETTE.dark,
  },
};

/** Largeur approximative d'un texte en police système (suffisant pour la mise en page) */
function textWidth(s, size, bold = false) {
  let w = 0;
  for (const ch of String(s)) {
    if ('il.,:;|!\'’ '.includes(ch)) w += 0.28;
    else if ('fjtrI()[]-/'.includes(ch)) w += 0.36;
    else if ('mwMW'.includes(ch)) w += 0.84;
    else if (/[A-Z]/.test(ch)) w += 0.66;
    else if (/[0-9]/.test(ch)) w += 0.56;
    else w += 0.54;
  }
  return w * size * (bold ? 1.07 : 1);
}
function truncate(s, size, max, bold = false) {
  if (textWidth(s, size, bold) <= max) return s;
  let out = s;
  while (out.length > 1 && textWidth(`${out}…`, size, bold) > max) out = out.slice(0, -1);
  return `${out.trimEnd()}…`;
}
/** Force un texte à tenir dans `max` px s'il risque de déborder */
const fit = (s, size, max, bold = false) =>
  textWidth(s, size, bold) > max ? ` textLength="${max.toFixed(1)}" lengthAdjust="spacingAndGlyphs"` : '';

function luminance(hex) {
  const n = parseInt(hex.slice(1), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    v /= 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function darken(hex, k) {
  const n = parseInt(hex.slice(1), 16);
  return `#${[(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => Math.round(v * (1 - k)).toString(16).padStart(2, '0')).join('')}`;
}
/** Couleur de marque lisible sur le fond du thème */
function brandColor(tech, t) {
  const c = `#${tech.color}`;
  const l = luminance(c);
  if (t.dark && l < 0.05) return t.text;
  if (!t.dark && l > 0.55) return darken(c, 0.4);
  return c;
}

const LANG_COLORS = {
  TypeScript: '#3178c6', JavaScript: '#f1e05a', Python: '#3572A5', Vue: '#41b883', Rust: '#dea584',
  CSS: '#663399', SCSS: '#c6538c', HTML: '#e34c26', Shell: '#89e051', PowerShell: '#012456',
  PLpgSQL: '#336790', MDX: '#fcb32c', Dockerfile: '#384d54', Go: '#00ADD8', Java: '#b07219',
  Kotlin: '#A97BFF', Swift: '#F05138', PHP: '#4F5D95', Ruby: '#701516', 'C#': '#178600', 'C++': '#f34b7d',
  C: '#555555', Dart: '#00B4AB', Svelte: '#ff3e00', Astro: '#ff5a03', Mako: '#7e858d', NSIS: '#7e858d',
  TSQL: '#e38c00', SQL: '#e38c00', Lua: '#000080', Makefile: '#427819', Handlebars: '#f7931e',
};
const langColor = (l, t) => LANG_COLORS[l] ?? t.muted;

const FONT = `-apple-system,BlinkMacSystemFont,'Segoe UI','Noto Sans',Helvetica,Arial,sans-serif`;
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const W = 840;

function frame(t, h, label, body, css = '') {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${h}" viewBox="0 0 ${W} ${h}" role="img" aria-label="${esc(label)}">
<title>${esc(label)}</title>
<defs><clipPath id="card"><rect width="${W}" height="${h}" rx="12"/></clipPath></defs>
<style>
text{font-family:${FONT};fill:${t.text}}
.m{fill:${t.muted}}
.h{font-size:15px;font-weight:600}
.s{font-size:12px}
.xs{font-size:11px}
@keyframes fade{from{opacity:0}}
@keyframes grow{from{transform:scaleX(0)}}
@keyframes pop{from{transform:scale(0)}}
${css}
@media (prefers-reduced-motion:reduce){*{animation:none!important}}
</style>
<rect x=".5" y=".5" width="${W - 1}" height="${h - 1}" rx="12" fill="${t.bg}" stroke="${t.border}"/>
${body}
</svg>
`;
}

function overviewSvg(t) {
  const h = 206;
  const updated = frDate(today.key, true);
  const tiles = [
    [fmt(stats.projects), 'projets', `dont ${fmt(stats.privateCount)} privés`],
    [fmt(stats.commits), 'commits', `depuis ${stats.since}`],
    [fmt(stats.yearCommits), 'commits', 'sur 12 mois'],
    [fmt(stats.active), 'projets actifs', 'push < 30 jours'],
    [mo(stats.bytes), 'de code', `en ${stats.languages} langages`],
    [fmt(stats.contributors), 'contributeurs', 'humains'],
  ];
  const tw = (W - 64) / tiles.length;
  const body = `
<rect width="${W}" height="4" fill="${t.accent}" clip-path="url(#card)"/>
<text x="32" y="54" style="font-size:26px;font-weight:700">${esc(CONFIG.title ?? OWNER)}</text>
<text x="32" y="78" class="m" style="font-size:13px">${esc(CONFIG.tagline ?? '')}</text>
<text x="${W - 32}" y="52" class="m s" text-anchor="end">mis à jour le ${esc(updated)}</text>
<line x1="32" y1="104" x2="${W - 32}" y2="104" stroke="${t.border}"/>
${tiles
  .map(
    ([v, l, s], i) => `<g style="animation:fade .6s ease-out ${i * 80}ms backwards">
  <text x="${32 + i * tw}" y="148" style="font-size:27px;font-weight:700">${esc(v)}</text>
  <text x="${32 + i * tw}" y="170" style="font-size:13px;font-weight:600">${esc(l)}</text>
  <text x="${32 + i * tw}" y="188" class="m xs">${esc(s)}</text>
</g>`,
  )
  .join('\n')}`;
  return frame(t, h, `${OWNER} : ${stats.projects} projets, ${stats.commits} commits`, body);
}

function languagesSvg(t) {
  const MAX = 9;
  const top = langs.slice(0, MAX);
  const rest = langs.slice(MAX).reduce((a, [, b]) => a + b, 0);
  const items = top.map(([l, b]) => ({ name: l, bytes: b, color: langColor(l, t) }));
  if (rest > 0) items.push({ name: 'Autres', bytes: rest, color: t.faint });

  const x0 = 24, bw = W - 48, y = 58;
  let x = x0;
  const segs = items.map((it) => {
    const w = Math.max((it.bytes / totalBytes) * bw, 2);
    const s = `<rect x="${x.toFixed(2)}" y="${y}" width="${w.toFixed(2)}" height="10" fill="${it.color}"/>`;
    x += w;
    return s;
  });
  const cols = 5, cw = bw / cols;
  const legend = items
    .map((it, i) => {
      const lx = x0 + (i % cols) * cw, ly = 100 + Math.floor(i / cols) * 24;
      return `<circle cx="${lx + 5}" cy="${ly - 4}" r="5" fill="${it.color}"/><text x="${lx + 16}" y="${ly}" style="font-size:13px">${esc(it.name)} <tspan class="m s">${pct((it.bytes / totalBytes) * 100)}</tspan></text>`;
    })
    .join('\n');
  const h = 100 + Math.ceil(items.length / cols) * 24 + 4;
  const body = `
<text x="24" y="36" class="h">Langages</text>
<text x="${W - 24}" y="36" class="m s" text-anchor="end">${esc(`${mo(totalBytes)} de code · ${stats.languages} langages · ${stats.projects} projets`)}</text>
<clipPath id="bar"><rect x="${x0}" y="${y}" width="${bw}" height="10" rx="5"/></clipPath>
<g clip-path="url(#bar)"><g style="transform-origin:${x0}px 0;animation:grow 1s cubic-bezier(.2,.8,.2,1) backwards">${segs.join('')}</g></g>
${legend}`;
  return frame(t, h, `Langages : ${items.slice(0, 3).map((i) => i.name).join(', ')}…`, body);
}

function activitySvg(t) {
  const x0 = 56, y0 = 74, cell = 11, step = 14;
  const values = [...byDay.values()].filter((v) => v > 0).sort((a, b) => a - b);
  const q = (p) => values[Math.min(values.length - 1, Math.floor(p * values.length))] ?? 1;
  const [q1, q2, q3] = [q(0.25), q(0.5), q(0.8)];
  const level = (v) => (!v ? 0 : v <= q1 ? 1 : v <= q2 ? 2 : v <= q3 ? 3 : 4);

  const cols = [];
  const months = [];
  let lastMonth = -1;
  for (let c = 0; c < WEEKS; c++) {
    const colStart = gridStartMs + c * 7 * DAY;
    const m = new Date(colStart).getUTCMonth();
    if (m !== lastMonth) {
      months.push({ c, m });
      lastMonth = m;
    }
    const cells = [];
    for (let r = 0; r < 7; r++) {
      const ms = colStart + r * DAY;
      if (ms > todayMs) break;
      const key = msToKey(ms);
      const v = byDay.get(key) ?? 0;
      cells.push(
        `<rect x="${x0 + c * step}" y="${y0 + r * step}" width="${cell}" height="${cell}" rx="2.5" fill="${t.heat[level(v)]}"><title>${v} commit${v > 1 ? 's' : ''} le ${frDate(key)}</title></rect>`,
      );
    }
    cols.push(`<g style="animation:fade .5s ease-out ${c * 14}ms backwards">${cells.join('')}</g>`);
  }
  const monthLabels = months
    .filter((mm, i) => !(i === 0 && months[1] && months[1].c - mm.c < 3))
    .map((mm) => `<text x="${x0 + mm.c * step}" y="${y0 - 10}" class="m xs">${MONTHS_SHORT[mm.m]}</text>`)
    .join('');
  const dayLabels = [0, 2, 4]
    .map((r) => `<text x="24" y="${y0 + r * step + 9}" class="m xs">${['lun.', '', 'mer.', '', 'ven.'][r]}</text>`)
    .join('');
  const yb = y0 + 7 * step + 22;
  const legendX = W - 24 - 5 * 15 - 34;
  const legend = `<text x="${legendX - 8}" y="${yb}" class="m xs" text-anchor="end">moins</text>
${t.heat.map((c, i) => `<rect x="${legendX + i * 15}" y="${yb - 10}" width="${cell}" height="${cell}" rx="2.5" fill="${c}"/>`).join('')}
<text x="${legendX + 5 * 15 + 4}" y="${yb}" class="m xs">plus</text>`;

  const r = facts.record;
  const body = `
<text x="24" y="36" class="h">Activité <tspan class="m" style="font-weight:400">· ${esc(plural(stats.yearCommits, 'commit'))} sur 12 mois, tous projets confondus</tspan></text>
${r.key ? `<text x="${W - 24}" y="36" class="m s" text-anchor="end">record : ${esc(`${r.count} commits le ${frDate(r.key, true)}`)}</text>` : ''}
${monthLabels}
${dayLabels}
${cols.join('\n')}
<text x="24" y="${yb}" class="m xs">${esc(`plus longue série : ${plural(facts.longest, 'jour')} d’affilée · série en cours : ${plural(facts.current, 'jour')}`)}</text>
${legend}`;
  return frame(t, yb + 18, `Activité : ${stats.yearCommits} commits sur 12 mois`, body);
}

function habitsSvg(t) {
  const x0 = 64, y0 = 62, cs = (W - 24 - x0) / 24, rs = 26;
  const max = Math.max(1, ...punch.flat());
  const dots = [];
  for (let d = 0; d < 7; d++) {
    for (let hh = 0; hh < 24; hh++) {
      const v = punch[d][hh];
      const cx = (x0 + hh * cs + cs / 2).toFixed(1), cy = y0 + d * rs + rs / 2;
      if (!v) {
        dots.push(`<circle cx="${cx}" cy="${cy}" r="1.5" fill="${t.faint}"/>`);
        continue;
      }
      const k = v / max;
      dots.push(
        `<circle cx="${cx}" cy="${cy}" r="${(2.5 + 9.5 * Math.sqrt(k)).toFixed(1)}" fill="${t.accent}" fill-opacity="${(0.3 + 0.7 * k).toFixed(2)}" style="transform-box:fill-box;transform-origin:center;animation:pop .5s cubic-bezier(.3,1.4,.5,1) ${hh * 25 + d * 15}ms backwards"><title>${DAYS[d]} ${hh} h : ${v} commit${v > 1 ? 's' : ''}</title></circle>`,
      );
    }
  }
  const dayLabels = DAYS.map((d, i) => `<text x="24" y="${y0 + i * rs + rs / 2 + 4}" class="m xs">${d.slice(0, 3)}.</text>`).join('');
  const hourLabels = Array.from({ length: 8 }, (_, i) => i * 3)
    .map((hh) => `<text x="${(x0 + hh * cs + cs / 2).toFixed(1)}" y="${y0 + 7 * rs + 18}" class="m xs" text-anchor="middle">${hh} h</text>`)
    .join('');
  const body = `
<text x="24" y="36" class="h">Rythme de commit <tspan class="m" style="font-weight:400">· jour × heure (${esc(TZ.split('/').pop())}), 12 derniers mois</tspan></text>
<text x="${W - 24}" y="36" class="m s" text-anchor="end">pic : le ${DAYS[facts.peakDow]} vers ${facts.peakHour} h</text>
${dayLabels}
${dots.join('\n')}
${hourLabels}`;
  return frame(t, y0 + 7 * rs + 34, `Rythme de commit, pic le ${DAYS[facts.peakDow]} vers ${facts.peakHour} h`, body);
}

const SPARK_WEEKS = 26;
const sparkStartMs = gridStartMs + (WEEKS - SPARK_WEEKS) * 7 * DAY;
for (const p of projects) {
  p.spark = new Array(SPARK_WEEKS).fill(0);
  for (const d of p.commits) {
    const c = Math.floor((keyToMs(local(d).key) - sparkStartMs) / (7 * DAY));
    if (c >= 0 && c < SPARK_WEEKS) p.spark[c]++;
  }
  p.sparkTotal = p.spark.reduce((a, b) => a + b, 0);
}

function factTiles() {
  const f = facts;
  const o = f.oldest;
  return [
    { icon: '🌙', value: pct(f.nightPct), label: 'des commits la nuit', sub: 'entre 22 h et 6 h' },
    { icon: '🛋️', value: pct(f.weekendPct), label: 'des commits le week-end', sub: 'samedi et dimanche' },
    { icon: '📅', value: DAYS[f.peakDow], label: 'jour le plus productif', sub: `pic d’activité vers ${f.peakHour} h` },
    f.record.key && { icon: '🔥', value: plural(f.record.count, 'commit'), label: 'en une seule journée', sub: `le ${frDate(f.record.key)}` },
    f.longest > 1 && { icon: '📈', value: plural(f.longest, 'jour'), label: 'de série record', sub: 'au moins un commit par jour' },
    f.hotProject && { icon: '🚀', value: f.hotProject.p.display, label: 'projet le plus actif', sub: `${plural(f.hotProject.n, 'commit')} en 30 jours` },
    { icon: '🏛️', value: o.display, label: 'le doyen des projets', sub: `lancé en ${MONTHS[o.createdAt.getMonth()]} ${o.createdAt.getFullYear()}` },
    f.agentReady && { icon: '🤖', value: `${f.agentReady} / ${stats.projects}`, label: 'projets prêts pour l’IA', sub: 'CLAUDE.md ou AGENTS.md' },
    f.testFiles && { icon: '🧪', value: fmt(f.testFiles), label: 'fichiers de tests', sub: `sur ${fmt(f.files)} fichiers au total` },
  ].filter(Boolean);
}

function factsSvg(t) {
  const items = factTiles();
  const cols = 3, gap = 12, th = 92, y0 = 56;
  const tw = (W - 48 - gap * (cols - 1)) / cols;
  const rows = Math.ceil(items.length / cols);
  const tiles = items
    .map((it, i) => {
      const x = 24 + (i % cols) * (tw + gap), y = y0 + Math.floor(i / cols) * (th + gap);
      const tx = x + 62, avail = tw - 62 - 14;
      const vs = Math.min(22, Math.floor((avail / textWidth(it.value, 1, true)) * 10) / 10);
      return `<g style="animation:fade .6s ease-out ${i * 70}ms backwards">
  <rect x="${x}" y="${y}" width="${tw}" height="${th}" rx="10" fill="${t.tile}" stroke="${t.border}" stroke-opacity=".6"/>
  <circle cx="${x + 32}" cy="${y + th / 2}" r="19" fill="${t.accent}" fill-opacity=".12"/>
  <text x="${x + 32}" y="${y + th / 2 + 6.5}" text-anchor="middle" class="emoji">${it.icon}</text>
  <text x="${tx}" y="${y + 38}" style="font-size:${vs}px;font-weight:700">${esc(it.value)}</text>
  <text x="${tx}" y="${y + 58}" style="font-size:12.5px;font-weight:600"${fit(it.label, 12.5, avail, true)}>${esc(it.label)}</text>
  <text x="${tx}" y="${y + 76}" class="m xs"${fit(it.sub, 11, avail)}>${esc(it.sub)}</text>
</g>`;
    })
    .join('\n');
  const body = `
<text x="24" y="36" class="h">Le saviez-vous ?</text>
<text x="${W - 24}" y="36" class="m s" text-anchor="end">sur les 12 derniers mois, tous projets confondus</text>
${tiles}`;
  return frame(t, y0 + rows * (th + gap) - gap + 24, 'Le saviez-vous ?', body,
    `.emoji{font-size:18px;font-family:'Apple Color Emoji','Segoe UI Emoji','Noto Color Emoji',sans-serif}`);
}

const STATUS = {
  active: { label: 'actif', color: (t) => t.ok },
  recent: { label: 'récent', color: (t) => t.warn },
  idle: { label: 'au repos', color: (t) => t.muted },
  archived: { label: 'archivé', color: (t) => t.faint },
};
function statusOf(p) {
  if (p.archived) return 'archived';
  const d = daysAgo(p.pushedAt);
  return d <= 14 ? 'active' : d <= 60 ? 'recent' : 'idle';
}

/** 4 technos max, en alternant les catégories pour donner une vue d'ensemble */
function stackOf(p, max = 4) {
  const pickable = TECH.filter((t) => p.techs.has(t.name) && t.cat !== 'tooling' && !(t.impliedBy ?? []).some((x) => p.techs.has(x)));
  const queues = ['front', 'desktop', 'back', 'ai'].map((c) => pickable.filter((t) => t.cat === c));
  const out = [];
  while (out.length < max && queues.some((q) => q.length)) {
    for (const q of queues) if (q.length && out.length < max) out.push(q.shift());
  }
  return out;
}

function pills(techs, x, y, t) {
  let cx = x;
  return techs
    .map((tech) => {
      const color = brandColor(tech, t);
      const tw = textWidth(tech.name, 11);
      const w = tw + 25;
      const s = `<rect x="${cx.toFixed(1)}" y="${y}" width="${w.toFixed(1)}" height="20" rx="10" fill="${color}" fill-opacity="${t.dark ? 0.16 : 0.1}"/>`
        + `<circle cx="${(cx + 10.5).toFixed(1)}" cy="${y + 10}" r="3.5" fill="${color}"/>`
        + `<text x="${(cx + 18).toFixed(1)}" y="${y + 14}" class="xs" textLength="${tw.toFixed(1)}" lengthAdjust="spacingAndGlyphs">${esc(tech.name)}</text>`;
      cx += w + 6;
      return s;
    })
    .join('');
}

const lockIcon = (x, y, c) =>
  `<g transform="translate(${x} ${y})"><rect x="1.5" y="5.5" width="9" height="6.5" rx="1.5" fill="${c}"/><path d="M3.5 5.5V4a2.5 2.5 0 0 1 5 0v1.5" fill="none" stroke="${c}" stroke-width="1.4"/></g>`;
const globeIcon = (x, y, c) =>
  `<g transform="translate(${x} ${y})" fill="none" stroke="${c}" stroke-width="1.2"><circle cx="6" cy="7" r="5"/><ellipse cx="6" cy="7" rx="2.1" ry="5"/><path d="M1 7h10"/></g>`;

function projectsSvg(t) {
  const top = 96, rowH = 56;
  const COL = { name: 72, commits: 606, spark: 622, push: W - 24 };
  const step = 4.4, sh = 24;

  let lx = W - 24;
  const legend = ['idle', 'recent', 'active']
    .map((k) => {
      const { label, color } = STATUS[k];
      const tw = textWidth(label, 12);
      const s = `<circle cx="${(lx - tw - 9).toFixed(1)}" cy="32" r="4" fill="${color(t)}"/><text x="${(lx - tw).toFixed(1)}" y="36" class="m s">${label}</text>`;
      lx -= tw + 30;
      return s;
    })
    .join('');

  const rows = projects
    .map((p, i) => {
      const y = top + i * rowH, mid = y + rowH / 2;
      const st = statusOf(p), sc = STATUS[st].color(t);
      const nameW = textWidth(p.display, 14, true);
      const desc = p.desc ? truncate(p.desc, 12, COL.commits - 70 - COL.name - nameW - 10) : '';
      const max = Math.max(1, ...p.spark);
      const bars = p.spark
        .map((v, k) => {
          const bh = v ? Math.max(2.5, (v / max) * sh) : 1.5;
          return `<rect x="${(COL.spark + k * step).toFixed(1)}" y="${(mid + 12 - bh).toFixed(1)}" width="3" height="${bh.toFixed(1)}" rx=".8" fill="${v ? t.accent : t.faint}"/>`;
        })
        .join('');
      const recent = daysAgo(p.pushedAt) <= 1;
      return `<g style="animation:fade .5s ease-out ${i * 45}ms backwards">
${i % 2 ? '' : `<rect x="12" y="${y}" width="${W - 24}" height="${rowH}" rx="8" fill="${t.tile}"/>`}
${st === 'active' ? `<circle cx="36" cy="${mid}" r="4.5" fill="${sc}" opacity="0" class="pulse"/>` : ''}
<circle cx="36" cy="${mid}" r="4.5" fill="${sc}"><title>${STATUS[st].label}</title></circle>
${p.private ? lockIcon(52, y + 12, t.muted) : globeIcon(52, y + 12, t.accent)}
<text x="${COL.name}" y="${y + 23}" style="font-size:14px;font-weight:600">${esc(p.display)}${desc ? `<tspan dx="8" class="m s" style="font-weight:400">${esc(desc)}</tspan>` : ''}</text>
${pills(stackOf(p), COL.name, y + 30, t)}
<text x="${COL.commits}" y="${mid + 5}" text-anchor="end" style="font-size:14px;font-weight:600">${fmt(p.totalCommits)}</text>
<g style="transform-box:fill-box;transform-origin:50% 100%;animation:rise .7s cubic-bezier(.2,.8,.2,1) ${200 + i * 45}ms backwards"><title>${plural(p.sparkTotal, 'commit')} sur 6 mois</title>${bars}</g>
<text x="${COL.push}" y="${mid + 4}" text-anchor="end" class="s${recent ? '' : ' m'}">${relative(p.pushedAt)}</text>
</g>`;
    })
    .join('\n');

  const head = (x, label, anchor = 'start') =>
    `<text x="${x}" y="78" class="m xs" text-anchor="${anchor}" style="letter-spacing:.06em;font-weight:600">${label}</text>`;
  const body = `
<text x="24" y="36" class="h">Projets <tspan class="m" style="font-weight:400">· ${plural(stats.projects, 'dépôt')}, dont ${fmt(stats.privateCount)} privés</tspan></text>
${legend}
${head(COL.name, 'PROJET')}${head(COL.commits, 'COMMITS', 'end')}${head(COL.spark, 'SUR 6 MOIS')}${head(COL.push, 'DERNIER PUSH', 'end')}
<line x1="24" y1="${top - 8}" x2="${W - 24}" y2="${top - 8}" stroke="${t.border}"/>
${rows}`;
  return frame(t, top + projects.length * rowH + 16, `${stats.projects} projets`, body,
    `@keyframes rise{from{transform:scaleY(0)}}
@keyframes pulse{0%{transform:scale(1);opacity:.45}70%,100%{transform:scale(2.8);opacity:0}}
.pulse{transform-box:fill-box;transform-origin:center;animation:pulse 2.8s ease-out infinite}`);
}

// ─────────────────────────────── Markdown ───────────────────────────────

const pic = (name, alt) => `<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/${name}-dark.svg">
  <img alt="${esc(alt)}" src="assets/${name}-light.svg" width="100%">
</picture>`;

const shield = (s) => encodeURIComponent(s.replace(/-/g, '--').replace(/_/g, '__'));
function badge(tech, count) {
  const q = new URLSearchParams({ style: 'flat-square', labelColor: tech.color });
  if (tech.logo) {
    q.set('logo', tech.logo);
    q.set('logoColor', tech.logoColor ?? 'white');
  }
  return `<img alt="${esc(`${tech.name} (${count})`)}" src="https://img.shields.io/badge/${shield(tech.name)}-${count}-3d444d?${q}">`;
}

/** Les cartes SVG ne sont pas cliquables : on garde des liens vers les dépôts publics */
function publicLinks() {
  const pub = projects.filter((p) => !p.private);
  if (!pub.length) return '';
  return `<p align="center"><sub>🌐 Dépôts publics : ${pub.map((p) => `<a href="${p.url}">${esc(p.display)}</a>`).join(' · ')}</sub></p>\n`;
}

function stackSection() {
  const counts = new Map();
  for (const p of projects) for (const name of p.techs) counts.set(name, (counts.get(name) ?? 0) + 1);
  return Object.entries(CATEGORIES)
    .map(([cat, label]) => {
      const techs = TECH.filter((t) => t.cat === cat && counts.has(t.name)).sort((a, b) => counts.get(b.name) - counts.get(a.name));
      if (!techs.length) return '';
      return `**${label}**<br>\n${techs.map((t) => badge(t, counts.get(t.name))).join(' ')}\n`;
    })
    .filter(Boolean)
    .join('\n');
}

function teamSection() {
  if (CONFIG.team?.show === false || !teamShown.length) return '';
  const avatars = teamShown
    .map((m) => {
      const src = `${m.avatar}${m.avatar.includes('?') ? '&' : '?'}s=96`;
      return `<a href="${m.url}" title="${esc(m.login)}"><img src="${src}" width="48" height="48" alt="${esc(m.login)}"></a>`;
    })
    .join('\n');
  return `### 👥 L’équipe\n\n<p>\n${avatars}\n</p>\n`;
}

const generatedAt = new Intl.DateTimeFormat('fr-FR', { timeZone: TZ, dateStyle: 'long', timeStyle: 'short' }).format(NOW);
const block = `<div align="center">

${pic('overview', `${OWNER} en chiffres`)}

</div>

${pic('activity', 'Activité sur 12 mois')}

${pic('languages', 'Répartition des langages')}

${pic('habits', 'Rythme de commit')}

${pic('facts', 'Le saviez-vous ?')}

${pic('projects', 'Les projets')}

${publicLinks()}
### 🧰 Stack

<sub>Détectée automatiquement dans les manifestes (package.json, pyproject, Cargo.toml…) · le chiffre = nombre de projets</sub>

${stackSection()}
${teamSection()}
---

<div align="center"><sub>
📡 Généré le ${esc(generatedAt)} à partir de ${plural(stats.projects, 'dépôt')} (dont ${fmt(stats.privateCount)} privés) ·
<a href="scripts/generate.mjs">le script</a> · <a href=".github/workflows/update-readme.yml">le workflow</a>
</sub></div>`;

// ─────────────────────────────── Écriture ───────────────────────────────

const assets = path.join(ROOT, 'assets');
await rm(path.join(assets, 'spark'), { recursive: true, force: true }); // ancien format
await mkdir(assets, { recursive: true });
const CARDS = { overview: overviewSvg, activity: activitySvg, languages: languagesSvg, habits: habitsSvg, facts: factsSvg, projects: projectsSvg };
for (const [theme, t] of Object.entries(THEMES)) {
  for (const [card, render] of Object.entries(CARDS)) await writeFile(path.join(assets, `${card}-${theme}.svg`), render(t));
}

const readmePath = path.join(ROOT, 'README.md');
const START = '<!-- STATS:START -->', END = '<!-- STATS:END -->';
let readme = await readFile(readmePath, 'utf8').catch(() => '');
if (!readme.includes(START) || !readme.includes(END)) {
  readme = `<!-- Tout ce qui est hors du bloc STATS est libre : il n'est jamais réécrit par le script. -->\n\n${START}\n${END}\n`;
}
readme = readme.replace(new RegExp(`${START}[\\s\\S]*${END}`), () => `${START}\n${block}\n${END}`);
await writeFile(readmePath, readme);

console.log(`✔ README.md + assets/ générés (${stats.projects} projets, ${fmt(stats.commits)} commits).`);
