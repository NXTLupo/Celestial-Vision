/**
 * APPLAUSE Archive Query Middleware
 *
 * Uses the TAP sync endpoint to find historical photographic plates
 * overlapping a given sky region.
 *
 * Endpoint: https://www.plate-archive.org/tap/sync
 * Auth: Authorization: Token <token>
 * Language: PostgreSQL (as used by plateanalysis repo)
 *
 * References:
 *   https://github.com/cuernodegazpacho/plateanalysis (uses PostgreSQL lang)
 *   https://github.com/lupinix/applausequery (uses ADQL)
 */
import type { Plugin } from 'vite';

const TAP_SYNC_URL = 'https://www.plate-archive.org/tap/sync';

export function applauseQueryPlugin(token: string): Plugin {
  return {
    name: 'applause-query-api',
    configureServer(server) {
      const APPLAUSE_TOKEN = token;

      server.middlewares.use(async (req, res, next) => {
        if (req.url !== '/api/applause/plates' || req.method !== 'POST') {
          return next();
        }

        try {
          const MAX_BODY_BYTES = 16_384;
          const declared = Number(req.headers['content-length'] || 0);
          if (declared > MAX_BODY_BYTES) {
            res.statusCode = 413;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: 'Request too large' }));
            return;
          }

          const body = await new Promise<string>((resolve, reject) => {
            let data = '';
            let size = 0;
            req.on('data', (chunk: Buffer) => {
              size += chunk.length;
              if (size > MAX_BODY_BYTES) {
                reject(new Error('Request body exceeded limit'));
                return;
              }
              data += chunk.toString();
            });
            req.on('end', () => resolve(data));
            req.on('error', reject);
          });

          const parsed = JSON.parse(body);
          const ra = Number(parsed.ra);
          const dec = Number(parsed.dec);
          const radius = Number(parsed.radius ?? 2.0);

          if (!Number.isFinite(ra) || ra < 0 || ra > 360) {
            res.statusCode = 400;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: 'Invalid ra (must be a finite number in [0, 360])' }));
            return;
          }
          if (!Number.isFinite(dec) || dec < -90 || dec > 90) {
            res.statusCode = 400;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: 'Invalid dec (must be a finite number in [-90, 90])' }));
            return;
          }
          if (!Number.isFinite(radius) || radius <= 0 || radius > 5) {
            res.statusCode = 400;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: 'Invalid radius (must be a finite number in (0, 5])' }));
            return;
          }

          if (!APPLAUSE_TOKEN) {
            res.statusCode = 500;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: 'APPLAUSE_TOKEN not configured' }));
            return;
          }

          const searchRadius = radius;
          // Box search in RA/Dec — simple and universally supported
          const cosDec = Math.cos(dec * Math.PI / 180);
          const raMin = (ra - searchRadius / Math.max(cosDec, 0.1)).toFixed(4);
          const raMax = (ra + searchRadius / Math.max(cosDec, 0.1)).toFixed(4);
          const decMin = (dec - searchRadius).toFixed(4);
          const decMax = (dec + searchRadius).toFixed(4);

          // Query uses the solution table (has ra_icrs, dec_icrs) joined with
          // plate and exposure tables for metadata.
          // Uses PostgreSQL language as plateanalysis repo does.
          const query = `SELECT DISTINCT p.plate_id, p.archive_id, p.plate_num, p.telescope, p.date_orig, e.exptime, e.ut_mid, e.year_mid, s.ra_icrs, s.dec_icrs, s.fov1, s.fov2, sc.filename_scan, sc.scan_id FROM applause_dr4.plate AS p LEFT JOIN applause_dr4.exposure AS e USING (plate_id) LEFT JOIN applause_dr4.solution AS s USING (plate_id) LEFT JOIN applause_dr4.scan AS sc USING (plate_id) WHERE s.ra_icrs BETWEEN ${raMin} AND ${raMax} AND s.dec_icrs BETWEEN ${decMin} AND ${decMax} AND s.header_wcs IS NOT NULL ORDER BY p.date_orig ASC LIMIT 50`;

          console.log('[APPLAUSE] Query:', query.substring(0, 120) + '...');
          console.log('[APPLAUSE] Token present:', !!APPLAUSE_TOKEN);

          // TAP sync request — standard IVOA TAP 1.1
          const params = new URLSearchParams();
          params.set('REQUEST', 'doQuery');
          params.set('LANG', 'PostgreSQL');
          params.set('QUERY', query);
          params.set('FORMAT', 'csv');

          const response = await fetch(TAP_SYNC_URL, {
            method: 'POST',
            headers: {
              'Authorization': `Token ${APPLAUSE_TOKEN}`,
              'Content-Type': 'application/x-www-form-urlencoded',
            },
            body: params.toString(),
          });

          const responseText = await response.text();

          if (!response.ok) {
            console.error('[APPLAUSE] TAP error:', response.status, responseText.substring(0, 500));
            res.statusCode = 502;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({
              error: `APPLAUSE returned ${response.status}`,
              detail: responseText.substring(0, 300),
            }));
            return;
          }

          console.log('[APPLAUSE] Response length:', responseText.length, 'First 200 chars:', responseText.substring(0, 200));

          // Check if response is VOTable XML (error case) or CSV
          if (responseText.trim().startsWith('<?xml') || responseText.trim().startsWith('<VOTABLE')) {
            // VOTable response — might be an error or the service returned VOTable despite requesting CSV
            // Try to extract any error message
            const errorMatch = responseText.match(/<INFO[^>]*value="([^"]*)"[^>]*>/);
            if (errorMatch) {
              console.error('[APPLAUSE] VOTable error:', errorMatch[1]);
            }
            // Parse VOTable: extract TABLEDATA rows
            const fieldMatches = [...responseText.matchAll(/<FIELD[^>]*name="([^"]*)"[^>]*>/g)];
            const columns = fieldMatches.map(m => m[1]);
            const rowMatches = [...responseText.matchAll(/<TR>([\s\S]*?)<\/TR>/g)];
            const rows = rowMatches.map(rm => {
              const cells = [...rm[1].matchAll(/<TD>([\s\S]*?)<\/TD>/g)].map(c => c[1].trim());
              const obj: any = {};
              columns.forEach((col, i) => { obj[col] = cells[i] || ''; });
              if (obj.plate_id && obj.archive_id) {
                obj.archive_url = `https://www.plate-archive.org/objects/dr.4/plates/${obj.archive_id}_${obj.plate_id}`;
              }
              return obj;
            });

            res.statusCode = 200;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ count: rows.length, query_ra: ra, query_dec: dec, query_radius: searchRadius, plates: rows }));
            return;
          }

          // Parse CSV response
          const lines = responseText.trim().split('\n');
          if (lines.length < 2) {
            res.statusCode = 200;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ count: 0, query_ra: ra, query_dec: dec, query_radius: searchRadius, plates: [] }));
            return;
          }

          const headers = lines[0].split(',').map(h => h.trim().replace(/"/g, ''));
          const rows = lines.slice(1).map(line => {
            // Handle quoted CSV values
            const values: string[] = [];
            let current = '';
            let inQuotes = false;
            for (const ch of line) {
              if (ch === '"') { inQuotes = !inQuotes; continue; }
              if (ch === ',' && !inQuotes) { values.push(current.trim()); current = ''; continue; }
              current += ch;
            }
            values.push(current.trim());

            const obj: any = {};
            headers.forEach((h, i) => { obj[h] = values[i] || ''; });
            if (obj.plate_id) {
              obj.archive_url = `https://www.plate-archive.org/objects/dr.4/plates/${obj.plate_id}/`;
            }
            return obj;
          });

          console.log(`[APPLAUSE] Found ${rows.length} plates.`);

          res.statusCode = 200;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ count: rows.length, query_ra: ra, query_dec: dec, query_radius: searchRadius, plates: rows }));

        } catch (err: any) {
          console.error('[APPLAUSE API Error]', err);
          res.statusCode = 500;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: err.message || 'Internal server error' }));
        }
      });

      // Preview image resolution + proxy endpoint
      // GET /api/applause/preview?plate_id=12345
      // Scrapes the APPLAUSE plate page for the preview image URL, then proxies the image
      const previewCache = new Map<string, string>();

      server.middlewares.use(async (req, res, next) => {
        const url = new URL(req.url || '', 'http://localhost');
        if (!url.pathname.startsWith('/api/applause/preview')) return next();

        const plateId = url.searchParams.get('plate_id');
        const archiveId = url.searchParams.get('archive_id');
        if (!plateId || !archiveId) {
          res.statusCode = 400;
          res.end(JSON.stringify({ error: 'Missing plate_id or archive_id' }));
          return;
        }

        const cacheKey = `${archiveId}_${plateId}`;

        try {
          let previewUrl = previewCache.get(cacheKey);

          if (!previewUrl) {
            // Fetch plate detail page and find preview image
            const pageUrl = `https://www.plate-archive.org/objects/dr.4/plates/${archiveId}_${plateId}`;
            console.log('[APPLAUSE] Fetching plate page:', pageUrl);
            const pageRes = await fetch(pageUrl, {
              headers: { 'Authorization': `Token ${APPLAUSE_TOKEN}` },
            });
            const html = await pageRes.text();

            // Look for preview image patterns: _l.png, _l.jpg, or image-scan-preview
            const imgMatch = html.match(/src="(\/files\/[^"]*(?:_l\.png|_l\.jpg|preview[^"]*))"/) ||
                             html.match(/src="(\/media\/[^"]*(?:_l\.png|_l\.jpg|preview[^"]*))"/) ||
                             html.match(/href="(\/files\/[^"]*\.(?:png|jpg))"[^>]*>.*?preview/i);

            if (imgMatch) {
              previewUrl = `https://www.plate-archive.org${imgMatch[1]}`;
            } else {
              // Fallback: construct from filename_scan
              const scanMatch = html.match(/filename_scan[^>]*>([^<]+)/);
              if (scanMatch) {
                const scanFile = scanMatch[1].trim();
                const base = scanFile.replace('.fits', '');
                previewUrl = `https://www.plate-archive.org/files/${base}_l.png`;
              }
            }

            if (previewUrl) {
              previewCache.set(cacheKey, previewUrl);
              console.log('[APPLAUSE] Preview URL resolved:', previewUrl);
            }
          }

          if (!previewUrl) {
            res.statusCode = 404;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: 'Preview not found' }));
            return;
          }

          // Proxy the image to avoid CORS
          const imgRes = await fetch(previewUrl, {
            headers: { 'Authorization': `Token ${APPLAUSE_TOKEN}` },
          });

          if (!imgRes.ok) {
            res.statusCode = imgRes.status;
            res.end(`Preview fetch failed: ${imgRes.status}`);
            return;
          }

          const contentType = imgRes.headers.get('content-type') || 'image/png';
          res.setHeader('Content-Type', contentType);
          res.setHeader('Cache-Control', 'public, max-age=86400');
          const buffer = Buffer.from(await imgRes.arrayBuffer());
          res.end(buffer);

        } catch (err: any) {
          console.error('[APPLAUSE Preview Error]', err);
          res.statusCode = 500;
          res.end(JSON.stringify({ error: err.message }));
        }
      });
    },
  };
}
