/**
 * Immich-same-age: Days of Life photo gallery
 * 
 * Fetches specific people (by name) from Immich, calculates DOL (Days of Life),
 * and serves a responsive gallery frontend with lightGallery.
 */

require('dotenv').config();
import express, { Request, Response } from 'express';
import path from 'path';
import https from 'https';
import http from 'http';

// ─── Configuration ──────────────────────────────────────────────────────────────

const IMMICH_API_URL = process.env.IMMICH_API_URL;
if (!IMMICH_API_URL) {
  console.error('❌ IMMICH_API_URL environment variable is required');
  process.exit(1);
}
const IMMICH_API_KEY = process.env.IMMICH_API_KEY;
if (!IMMICH_API_KEY) {
  console.error('❌ IMMICH_API_KEY environment variable is required');
  process.exit(1);
}
const PORT = parseInt(process.env.PORT || '8080', 10);
const MAX_DOL_LOOKBACK = parseInt(process.env.MAX_DOL_LOOKBACK || '30', 10);
const SAME_AGE_PERSONS_STR = process.env.SAME_AGE_PERSONS;
if (!SAME_AGE_PERSONS_STR) {
  console.error('❌ SAME_AGE_PERSONS environment variable is required');
  process.exit(1);
}
const SAME_AGE_PERSONS = SAME_AGE_PERSONS_STR
  .split(',')
  .map(s => s.trim())
  .filter(s => s.length > 0);
if (SAME_AGE_PERSONS.length === 0) {
  console.error('❌ SAME_AGE_PERSONS must contain at least one non-empty name');
  process.exit(1);
}

console.log(`📋 Filtering to persons: ${SAME_AGE_PERSONS.join(', ')}`);

// ─── Types ──────────────────────────────────────────────────────────────────────

interface Person {
  id: string;
  name: string;
  birth_date: string;
}

interface DOLAsset {
  person: string;
  person_id: string;
  birth_date: string;
  dol_days: number;
  asset_id: string;
  created: string;
  thumbnail_proxy: string;
}

interface APIResponse {
  people: Person[];
  assets: DOLAsset[];
}

// ─── Data Cache ─────────────────────────────────────────────────────────────────

let cachedData: APIResponse | null = null;
let lastFetched: number = 0;
let inflightRefresh: Promise<APIResponse> | null = null;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

// Immich asset IDs are UUIDs — anything else in the proxy path is suspect.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ─── Immich API Helper ──────────────────────────────────────────────────────────

function createImmichRequest(targetUrl: URL, method: string = 'GET', body?: unknown): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const transport = targetUrl.protocol === 'https:' ? https : http;

    const options: http.RequestOptions = {
      hostname: targetUrl.hostname,
      port: targetUrl.port || (targetUrl.protocol === 'https:' ? 443 : 80),
      path: targetUrl.pathname + targetUrl.search,
      method,
      headers: {
        'X-Api-Key': IMMICH_API_KEY,
        'Content-Type': 'application/json',
      },
      timeout: 30000,
    };

    const req = transport.request(options, (res: http.IncomingMessage) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => {
        if (res.statusCode! >= 400) {
          reject(new Error(`Immich API error: ${res.statusCode} ${res.statusMessage}`));
          return;
        }
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString()));
        } catch (e) {
          reject(new Error(`Failed to parse JSON: ${Buffer.concat(chunks).toString().substring(0, 200)}`));
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(30000, () => { req.destroy(); reject(new Error('Request timeout')); });

    if (body) {
      req.write(JSON.stringify(body));
    }
    req.end();
  });
}

// ─── Fetch filtered people ──────────────────────────────────────────────────────

async function fetchFilteredPeople(): Promise<Person[]> {
  const targetUrl = new URL('/api/people', IMMICH_API_URL);
  const data = await createImmichRequest(targetUrl) as Record<string, unknown>;
  
  const allPeople = data.people as Array<Record<string, unknown>>;
  
  // Filter to only the names we care about
  const people = allPeople
    .filter((p: Record<string, unknown>) => {
      const name = String(p.name || '').trim();
      const birthDate = p.birthDate;
      return birthDate && SAME_AGE_PERSONS.includes(name);
    })
    .map((p: Record<string, unknown>) => ({
      id: String(p.id),
      name: String(p.name),
      birth_date: String(p.birthDate),
    }))
    .sort((a: Person, b: Person) => a.birth_date.localeCompare(b.birth_date));

  return people;
}

// ─── Fetch assets for a person within a DOL range ─────────────────────────────

async function fetchAssetsForPerson(
  personId: string,
  personBirthDate: string,
  personName: string,
  minDolDays: number,
  maxDolDays: number,
): Promise<DOLAsset[]> {
  const birth = new Date(personBirthDate + 'T00:00:00.000Z');

  // Only fetch photos for DOL ∈ [minDolDays, maxDolDays].
  // Immich uses takenAfter/takenBefore (EXIF date) and supports order: "asc".
  const takenAfter = new Date(birth.getTime() + minDolDays * 86400000).toISOString();
  const takenBefore = new Date(birth.getTime() + (maxDolDays + 1) * 86400000).toISOString();

  const allItems: Array<Record<string, unknown>> = [];
  let page = 1;
  const PAGE_LIMIT = 20; // safety cap: 20 × 1000 = 20 000 assets

  while (page <= PAGE_LIMIT) {
    const targetUrl = new URL('/api/search/metadata', IMMICH_API_URL);
    const data = await createImmichRequest(targetUrl, 'POST', {
      personIds: [personId],
      size: 1000,
      page,
      order: 'asc',   // oldest first — lets us stop early once we exceed maxDolDays
      takenAfter,
      takenBefore,
    }) as Record<string, unknown>;

    const assetsData = data.assets as Record<string, unknown>;
    const items = assetsData.items as Array<Record<string, unknown>>;

    // Keep only items within the DOL window (guards against filters being ignored)
    let exceededRange = false;
    for (const item of items) {
      const dolDays = Math.floor(
        (new Date(String(item.fileCreatedAt)).getTime() - birth.getTime()) / 86400000
      );
      if (dolDays >= minDolDays && dolDays <= maxDolDays) {
        allItems.push(item);
      } else if (dolDays > maxDolDays) {
        exceededRange = true;
      }
    }

    const nextPage = assetsData.nextPage;
    if (!nextPage || items.length === 0 || exceededRange) break;
    page++;
  }

  return allItems.map((asset: Record<string, unknown>) => {
    const created = new Date(String(asset.fileCreatedAt));
    const dolDays = Math.floor((created.getTime() - birth.getTime()) / (1000 * 60 * 60 * 24));

    return {
      person: personName,
      person_id: personId,
      birth_date: personBirthDate,
      dol_days: dolDays,
      asset_id: String(asset.id),
      created: String(asset.fileCreatedAt),
      thumbnail_proxy: `/proxy/thumbnail/${asset.id}`,
    };
  });
}

// ─── Refresh cache ──────────────────────────────────────────────────────────────

async function refreshCache(): Promise<APIResponse> {
  console.log('🔄 Fetching fresh data from Immich...');
  const startTime = Date.now();

  const people = await fetchFilteredPeople();
  console.log(`  → Found ${people.length} target people: ${people.map(p => p.name).join(', ')}`);

  // Reference DOL = how many days old the youngest person is today.
  // We only fetch photos for ages 0..referenceDol so that both children
  // are always compared at the same chronological age.
  const youngest = [...people].sort((a, b) => b.birth_date.localeCompare(a.birth_date))[0];
  const todayUTC = Date.UTC(new Date().getFullYear(), new Date().getMonth(), new Date().getDate());
  const birthUTC = new Date(youngest.birth_date + 'T00:00:00.000Z').getTime();
  const referenceDol = Math.floor((todayUTC - birthUTC) / 86400000);
  console.log(`  → Reference DOL: ${referenceDol} (${youngest.name} born ${youngest.birth_date})`);

  const minDol = Math.max(0, referenceDol - MAX_DOL_LOOKBACK + 1);
  console.log(`  → Fetching assets for ${people.length} people in parallel (DOL ${minDol}–${referenceDol})...`);
  const perPersonResults = await Promise.all(people.map(async (person) => {
    try {
      const assets = await fetchAssetsForPerson(person.id, person.birth_date, person.name, minDol, referenceDol);
      const dolRange = assets.length > 0
        ? `DOL ${Math.min(...assets.map(a => a.dol_days))}–${Math.max(...assets.map(a => a.dol_days))}`
        : 'no assets';
      console.log(`  → ${person.name}: ${assets.length} assets (${dolRange})`);
      return assets;
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error(`  → ❌ Error fetching ${person.name}: ${msg}`);
      return [];
    }
  }));

  const allAssets = perPersonResults.flat().sort((a, b) => b.dol_days - a.dol_days);

  cachedData = { people, assets: allAssets };
  lastFetched = Date.now();

  console.log(`  → Total: ${allAssets.length} assets in ${(Date.now() - startTime) / 1000}s`);
  return cachedData;
}

// ─── Express App ────────────────────────────────────────────────────────────────

const app = express();

// Middleware
app.use(express.json());
app.use(express.static(path.join(process.cwd(), 'public')));

// Proxy route for thumbnails (handles auth)
app.get('/proxy/thumbnail/:assetId', async (req: Request, res: Response) => {
  try {
    const { assetId } = req.params;
    if (!UUID_RE.test(assetId)) {
      res.status(400).json({ error: 'Invalid asset id' });
      return;
    }
    const targetUrl = new URL(`/api/assets/${assetId}/thumbnail`, IMMICH_API_URL);
    
    // Accept size parameter
    const size = req.query.size as string || 'thumbnail';
    targetUrl.searchParams.set('size', size);
    
    const transport = targetUrl.protocol === 'https:' ? https : http;
    const options: http.RequestOptions = {
      hostname: targetUrl.hostname,
      port: targetUrl.port || (targetUrl.protocol === 'https:' ? 443 : 80),
      path: targetUrl.pathname + targetUrl.search,
      method: 'GET',
      headers: {
        'X-Api-Key': IMMICH_API_KEY,
      },
      timeout: 15000,
    };
    
    const req2 = transport.request(options, (response: http.IncomingMessage) => {
      // Forward all headers except hop-by-hop
      const skipHeaders = ['transfer-encoding', 'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailers', 'upgrade'];
      for (const [key, value] of Object.entries(response.headers)) {
        if (!skipHeaders.includes(key.toLowerCase())) {
          res.setHeader(key, String(value));
        }
      }
      res.status(response.statusCode!);
      response.pipe(res);
    });
    
    req2.on('error', (error) => {
      console.error('❌ Proxy error:', error);
      res.status(500).json({ error: 'Failed to proxy request' });
    });
    
    req2.setTimeout(15000, () => {
      req2.destroy();
      res.status(504).json({ error: 'Request timeout' });
    });
    
    req2.end();
  } catch (error) {
    console.error('❌ Proxy error:', error);
    res.status(500).json({ error: 'Failed to proxy request' });
  }
});

async function getData(): Promise<APIResponse> {
  if (cachedData && (Date.now() - lastFetched) <= CACHE_TTL_MS) {
    return cachedData;
  }
  if (!inflightRefresh) {
    inflightRefresh = refreshCache().finally(() => { inflightRefresh = null; });
  }
  return inflightRefresh;
}

// Main API endpoint
app.get('/api/data', async (_req: Request, res: Response) => {
  try {
    const data = await getData();
    res.json(data);
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error('❌ Error fetching data:', msg);
    res.status(500).json({ error: 'Failed to fetch data from Immich' });
  }
});

// Health check
app.get('/api/health', (_req: Request, res: Response) => {
  res.json({ 
    status: 'ok',
    cached: cachedData ? { people: cachedData.people.length, assets: cachedData.assets.length } : null,
    cacheAge: lastFetched ? Math.round((Date.now() - lastFetched) / 1000) + 's' : null,
    filter: SAME_AGE_PERSONS
  });
});

// Serve frontend for all other routes
app.get('*', (req: Request, res: Response) => {
  res.sendFile(path.join(process.cwd(), 'public', 'index.html'));
});

// ─── Start Server ───────────────────────────────────────────────────────────────

const server = app.listen(PORT, () => {
  console.log(`🚀 immich-same-age server running on http://localhost:${PORT}`);
  console.log(`   Immich API: ${IMMICH_API_URL}`);
  console.log(`   Cache TTL: ${CACHE_TTL_MS / 1000}s`);
  console.log(`   Filtering to: ${SAME_AGE_PERSONS.join(', ')}`);
  console.log(`   Proxy: http://localhost:${PORT}/proxy/thumbnail/:assetId`);
});

function shutdown(signal: string): void {
  console.log(`📴 ${signal}`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
