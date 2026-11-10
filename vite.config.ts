// The dev server, plus the endpoint behind the page's Levers panel: it saves levers and re-records the runs.
import { spawn } from 'node:child_process';
import { createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { defineConfig, type Plugin } from 'vite';

const LEVERS = 'src/levers.json', PENDING = 'out/levers.pending.json', RECORD_TIMEOUT_MS = 10 * 60 * 1000;

function record(count: number) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', 'scripts/export-viewer.ts', '--count', String(count), '--levers', PENDING]);
    let log = '';
    const keep = (d: Buffer) => { log = (log + d).slice(-1500); };
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    const timer = setTimeout(() => child.kill(), RECORD_TIMEOUT_MS);
    child.on('error', reject);
    child.on('exit', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(); else reject(new Error(log || 'Re-recording timed out'));
    });
  });
}

function leverApi(): Plugin {
  let busy = false;
  return {
    name: 'lever-api',
    configureServer(server) {
      server.middlewares.use('/api/levers', (req, res) => {
        const reply = (status: number, text: string) => { res.statusCode = status; res.setHeader('Content-Type', 'text/plain'); res.end(text); };
        // requiring JSON stops another website's plain form post from reaching this
        if (req.method !== 'POST' || !req.headers['content-type']?.startsWith('application/json')) return reply(415, 'POST JSON only');
        if (busy) return reply(409, 'Already re-recording');
        let body = '';
        req.on('data', (d) => { body += d; });
        req.on('end', async () => {
          busy = true;
          try {
            const { levers, rerecord, count } = JSON.parse(body) as { levers: Record<string, unknown>; rerecord: boolean; count: number };
            if (!levers || typeof levers !== 'object' || !Number.isInteger(count) || count < 1 || count > 500) { reply(400, 'Bad request'); return; }
            const text = JSON.stringify(levers, null, 2) + '\n';
            if (rerecord) {
              mkdirSync('out', { recursive: true });
              writeFileSync(PENDING, text);
              await record(count);
            }
            writeFileSync(LEVERS, text); // last, so a failed re-record leaves both levers and runs as they were
            reply(200, 'ok');
          } catch (e) {
            reply(500, e instanceof Error ? e.message : String(e));
          } finally {
            busy = false;
          }
        });
      });
    },
  };
}

/** The Analysis page reads the datasets that  npm run generate  and  npm run sweep  write to out/datasets/. */
function datasetApi(): Plugin {
  const ROOT = 'out/datasets';
  return {
    name: 'dataset-api',
    configureServer(server) {
      server.middlewares.use('/api/datasets', (req, res) => {
        const name = decodeURIComponent((req.url ?? '/').split('?')[0].slice(1));
        if (!name) {
          const list = existsSync(ROOT) ? readdirSync(ROOT).filter((d) => existsSync(`${ROOT}/${d}/meta.json`)).map((d) => JSON.parse(readFileSync(`${ROOT}/${d}/meta.json`, 'utf8'))) : [];
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(list));
          return;
        }
        const file = `${ROOT}/${name}/runs.jsonl`;
        if (/[\\/]|\.\./.test(name) || !existsSync(file)) { res.statusCode = 404; res.end('No such dataset'); return; }
        res.setHeader('Content-Type', 'text/plain');
        createReadStream(file).pipe(res);
      });
      // Recorded runs, read from disk on every request. Vite only serves public files it knew about when it started
      // (and doesn't watch this folder), so runs recorded while the server is running would otherwise be missing.
      server.middlewares.use('/runs', (req, res, next) => {
        const file = (req.url ?? '/').split('?')[0].slice(1);
        if (!/^(index\.json|\d+\/(run|\d+-(escape|crash))\.json)$/.test(file)) return next();
        const path = `public/runs/${file}`;
        if (!existsSync(path)) { res.statusCode = 404; res.end('Not recorded'); return; }
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Cache-Control', 'no-store');
        createReadStream(path).pipe(res);
      });
    },
  };
}

export default defineConfig({
  base: './', // relative, so the build works under a GitHub Pages project path
  plugins: [leverApi(), datasetApi()],
  server: { watch: { ignored: ['**/out/**', '**/public/runs/**'] } },
});
