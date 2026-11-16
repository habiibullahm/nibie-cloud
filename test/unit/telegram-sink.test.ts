import { describe, expect, it, vi } from 'vitest';
import type { Fetcher } from '../../src/modules/integrations/fetcher.js';
import { AlertDeliveryError, createTelegramSink } from '../../src/modules/ops/telegram-sink.js';

const token = '123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw';

describe('createTelegramSink', () => {
  it('posts plain text to the sendMessage endpoint of api.telegram.org only', async () => {
    const fetcher = vi.fn<Fetcher>(async () => ({ status: 200, headers: {}, body: '{"ok":true}' }));
    await createTelegramSink({ botToken: token, chatId: '42', fetcher })('halo');
    const [url, opts] = fetcher.mock.calls[0]!;
    expect(url).toBe(`https://api.telegram.org/bot${token}/sendMessage`);
    expect(opts.method).toBe('POST');
    expect(opts.allowHosts).toEqual(['api.telegram.org']);
    expect(JSON.parse(opts.body!)).toEqual({ chat_id: '42', text: 'halo', disable_web_page_preview: true });
  });

  it.each([400, 401, 429, 500])('fails with a fixed error on HTTP %i, without echoing the token', async (status) => {
    const fetcher: Fetcher = async () => ({ status, headers: {}, body: `{"description":"bad ${token}"}` });
    const err = await createTelegramSink({ botToken: token, chatId: '42', fetcher })('x').catch((e: Error) => e);
    expect(err).toBeInstanceOf(AlertDeliveryError);
    expect((err as Error).message).not.toContain('AAHdqTcv');
  });

  it('fails with the same fixed error when the call itself fails', async () => {
    const fetcher: Fetcher = async () => { throw new Error(`connect failed for ${token}`); };
    const err = await createTelegramSink({ botToken: token, chatId: '42', fetcher })('x').catch((e: Error) => e);
    expect(err).toBeInstanceOf(AlertDeliveryError);
    expect((err as Error).message).not.toContain('AAHdqTcv');
  });
});
