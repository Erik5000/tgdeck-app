import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync } from 'node:fs';

if (existsSync('.git')) {
  try {
    let existing = '';
    try { existing = execFileSync('git', ['config', '--get', 'core.hooksPath'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(); }
    catch (error) { if ((error as { status?: number }).status !== 1) throw error; }
    if (existing && existing !== '.githooks') {
      console.error('An existing Git hooks path is configured. Integrate the tgdeck privacy hooks before committing or pushing.');
      process.exitCode = 1;
    } else {
      for (const name of ['pre-commit', 'pre-push']) chmodSync(`.githooks/${name}`, 0o755);
      execFileSync('git', ['config', '--local', 'core.hooksPath', '.githooks']);
      console.log('tgdeck privacy hooks installed for this repository.');
    }
  } catch {
    console.error('Could not install privacy hooks. Run npm run prepare from the repository with Git write access.');
    process.exitCode = 1;
  }
}
