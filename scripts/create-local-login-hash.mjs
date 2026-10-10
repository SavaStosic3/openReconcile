import { randomBytes } from 'node:crypto';
import { hashPassword } from '../backend/local-auth.js';

// Secrets arrive through hidden stdin, never command arguments or a file.
async function readInput() {
  return new Promise((resolve, reject) => {
    let value = '', finished = false;
    const terminal = process.stdin.isTTY;
    const finish = error => {
      if (finished) return;
      finished = true;
      process.stdin.removeListener('data', onData);
      process.stdin.removeListener('end', onEnd);
      if (terminal) process.stdin.setRawMode(false);
      process.stdin.pause();
      error ? reject(error) : resolve(value);
    };
    const onData = chunk => {
      value += chunk;
      if (value.includes('\u0003')) finish(new Error('Cancelled.'));
      else if (value.length > 8192) finish(new Error('Input is too large.'));
      else if (value.includes('\r') || value.includes('\n')) finish();
    };
    const onEnd = () => finish();
    if (terminal) {
      process.stdin.setRawMode(true);
      process.stderr.write('Ready for credential JSON on stdin (input is hidden).\n');
    }
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', onData);
    process.stdin.once('end', onEnd);
    process.stdin.resume();
  });
}

try {
  const input = JSON.parse(await readInput());
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['password', 'pepper'].includes(key))) throw new Error();
  const pepper = input.pepper ?? randomBytes(32).toString('base64url');
  const passwordHash = await hashPassword(input.password, pepper);
  input.password = '';
  process.stdout.write(`${JSON.stringify({ pepper, passwordHash })}\n`);
} catch {
  process.stderr.write('Could not generate credentials. Supply a JSON object with a password of 8–1024 characters and an optional existing pepper of 32–1024 characters.\n');
  process.exitCode = 1;
}
