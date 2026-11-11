import { PassThrough } from 'node:stream';
import Docker from 'dockerode';

/** Test-only: run a command inside a tenant container (the customer shell broker is a later milestone). */
export async function execIn(
  docker: Docker,
  instanceId: string,
  cmd: string[],
): Promise<{ code: number; out: string }> {
  const container = docker.getContainer(`hermes-${instanceId}`);
  const exec = await container.exec({ Cmd: cmd, AttachStdout: true, AttachStderr: true });
  const stream = await exec.start({ hijack: true, stdin: false });
  const out = new PassThrough();
  const chunks: Buffer[] = [];
  out.on('data', (c: Buffer) => chunks.push(c));
  docker.modem.demuxStream(stream, out, out);
  await new Promise<void>((resolve) => {
    stream.on('end', resolve);
    stream.on('close', resolve);
  });
  const info = await exec.inspect();
  return { code: info.ExitCode ?? -1, out: Buffer.concat(chunks).toString('utf8') };
}
