import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { StringDecoder } from 'node:string_decoder';
import { setupAdmin, addUser, backupDatabase, verifyBackup } from './accounts.js';

const help = `openReconcile server administration

  node deploy/cli.mjs setup --username PlantAdmin [--name "Plant Administrator"] [--email admin@example.com]
  node deploy/cli.mjs add-user --username OperatorOne [--role viewer|operator|editor|admin] [--name "Name"] [--email user@example.com]
  node deploy/cli.mjs backup [--output /data/backups/new-backup]
  node deploy/cli.mjs verify-backup --output /data/backups/existing-backup

All commands accept --data-dir PATH (default APP_DATA_DIR or /data).
Account commands require an interactive terminal and prompt for the password.
Setup creates only the first administrator; existing accounts are never reset.
`;

export async function hiddenPassword(prompt, { input = process.stdin, output = process.stdout } = {}) {
  if (!input.isTTY || !output.isTTY || typeof input.setRawMode !== 'function') throw new Error('Password setup requires an interactive terminal. Run docker compose run --rm app node deploy/cli.mjs setup --username PlantAdmin from a terminal.');
  output.write(prompt);
  const previousRaw = Boolean(input.isRaw);
  input.setRawMode(true); input.resume();
  return new Promise((resolve, reject) => {
    let value = ''; const decoder = new StringDecoder('utf8');
    const cleanup = () => { input.off('data', read); input.off('end', ended); input.setRawMode(previousRaw); input.pause(); output.write('\n'); };
    const ended = () => { cleanup(); reject(new Error('Password entry was interrupted.')); };
    const read = chunk => {
      for (const character of decoder.write(chunk)) {
        if (character === '\u0003' || character === '\u0004') { cleanup(); reject(new Error('Password entry was cancelled.')); return; }
        if (character === '\r' || character === '\n') { cleanup(); resolve(value); return; }
        if (character === '\u007f' || character === '\b') value = Array.from(value).slice(0, -1).join('');
        else if (character >= ' ' && value.length < 1024) value += character;
      }
    };
    input.on('data', read); input.once('end', ended);
  });
}

export async function main(args = process.argv.slice(2)) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, strict: true, options: {
    username: { type: 'string' }, name: { type: 'string' }, email: { type: 'string' }, role: { type: 'string' }, output: { type: 'string' }, 'data-dir': { type: 'string' }, help: { type: 'boolean', short: 'h' }
  } });
  if (values.help || !positionals.length) { process.stdout.write(help); return; }
  if (positionals.length !== 1 || !['setup', 'add-user', 'backup', 'verify-backup'].includes(positionals[0])) throw new Error('Choose setup, add-user, backup or verify-backup. Use --help for command details.');
  const command = positionals[0], dataDir = values['data-dir'] ?? process.env.APP_DATA_DIR ?? '/data';
  if (command === 'backup' || command === 'verify-backup') {
    if (['username', 'name', 'email', 'role'].some(key => values[key] !== undefined)) throw new Error('Account options are not accepted by backup.');
    if (command === 'verify-backup') {
      const result = await verifyBackup({ backupDir: values.output });
      process.stdout.write(`Backup verified: ${result.backupDir}\nDatabase integrity and database/secrets checksums match the manifest.\n`);
      return;
    }
    const result = await backupDatabase({ dataDir, backupDir: values.output });
    process.stdout.write(`Backup created: ${result.backupDir}\nCopy the entire directory to your backup system. It contains the database and private server secrets.\n`);
    return;
  }
  if (values.output !== undefined || (command === 'setup' && values.role !== undefined)) throw new Error('That option is not accepted by this account command.');
  if (!values.username) throw new Error('Provide --username.');
  const password = await hiddenPassword('Password (at least 12 characters): '), confirmation = await hiddenPassword('Confirm password: ');
  if (password !== confirmation) throw new Error('The passwords do not match. No account was created.');
  const options = { dataDir, username: values.username, password, name: values.name, email: values.email, role: values.role };
  const account = await (command === 'setup' ? setupAdmin(options) : addUser(options));
  process.stdout.write(`Created ${account.role} account: ${account.username}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(error => { process.stderr.write(`Error: ${error.message}\n`); process.exitCode = 1; });
