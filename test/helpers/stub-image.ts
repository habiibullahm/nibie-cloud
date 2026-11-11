import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
export const STUB_IMAGE = 'hermes-stub:0.1.0';
const contextDir = fileURLToPath(new URL('../fixtures/hermes-stub/', import.meta.url));

/** Build the Hermes stand-in image if it is not already present. */
export async function ensureStubImage(): Promise<string> {
  try {
    await run('docker', ['image', 'inspect', STUB_IMAGE]);
  } catch {
    await run('docker', ['build', '-t', STUB_IMAGE, contextDir]);
  }
  return STUB_IMAGE;
}
