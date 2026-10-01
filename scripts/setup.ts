import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';

try {
  writeFileSync('.env', `WEBHOOK_SECRET=${randomBytes(32).toString('hex')}\nADMIN_TOKEN=${randomBytes(32).toString('hex')}\nHOST=127.0.0.1\nPORT=4310\nDATABASE_PATH=data/hookledger.db\n`, { flag: 'wx', mode: 0o600 });
  console.log('Created .env with unique secrets. Run npm start, then npm run demo in another terminal.');
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  console.log('.env already exists; preserved your configuration.');
}
