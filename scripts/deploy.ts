// Publishes the game to GitHub Pages: builds it with the runs currently in public/runs, then force-pushes dist/ as the
// single commit on the gh-pages branch. The runs are gitignored on main (they change with every re-record), so they
// only ever live on gh-pages, and force-pushing keeps old recordings from piling up in the repository.
import { execSync } from 'node:child_process';
import { existsSync, rmSync, writeFileSync } from 'node:fs';

const sh = (cmd: string, cwd = '.') => execSync(cmd, { cwd, stdio: 'inherit' });
const remote = execSync('git remote get-url origin').toString().trim();

if (!existsSync('public/runs/index.json')) throw new Error('No recorded runs in public/runs: run  npm run export  first');
sh('npx vite build');
writeFileSync('dist/.nojekyll', ''); // serve files as they are, no Jekyll pass
rmSync('dist/.git', { recursive: true, force: true });
sh('git init -q -b gh-pages', 'dist');
sh('git add -A', 'dist');
sh('git commit -q -m "Deploy"', 'dist');
sh(`git push -f "${remote}" gh-pages`, 'dist');
rmSync('dist/.git', { recursive: true, force: true });
console.log('Deployed. GitHub Pages picks it up within a minute or two.');
