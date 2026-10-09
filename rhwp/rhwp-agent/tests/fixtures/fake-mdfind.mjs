// Stand-in for /usr/bin/mdfind in home-search tests.
import { appendFileSync, readFileSync } from 'node:fs';

if (process.env.FAKE_MDFIND_LOG) appendFileSync(process.env.FAKE_MDFIND_LOG, `${JSON.stringify(process.argv.slice(2))}\n`);
if (process.env.FAKE_MDFIND_MODE === 'hang') {
  setInterval(() => {}, 1_000);
} else {
  const paths = JSON.parse(readFileSync(process.env.FAKE_MDFIND_OUT, 'utf8'));
  process.stdout.write(paths.map((entry) => `${entry}\0`).join(''));
}
