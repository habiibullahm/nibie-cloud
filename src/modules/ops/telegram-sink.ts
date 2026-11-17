import { defaultFetcher, type Fetcher } from '../integrations/fetcher.js';
import type { AlertSink } from './alerter.js';

export class AlertDeliveryError extends Error {
  constructor() {
    super('Alert delivery failed');
    this.name = 'AlertDeliveryError';
  }
}

/**
 * Sends operator alerts to one Telegram chat. The bot token is part of the URL path, so it is never logged and
 * errors are reduced to a fixed class. Plain text on purpose (no parse mode), so message content cannot be
 * interpreted as markup.
 */
export function createTelegramSink(o: { botToken: string; chatId: string; fetcher?: Fetcher }): AlertSink {
  const fetcher = o.fetcher ?? defaultFetcher;
  return async (text) => {
    let status: number;
    try {
      ({ status } = await fetcher(`https://api.telegram.org/bot${o.botToken}/sendMessage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: o.chatId, text, disable_web_page_preview: true }),
        allowHosts: ['api.telegram.org'],
        timeoutMs: 10_000,
        maxBytes: 64 * 1024,
      }));
    } catch {
      throw new AlertDeliveryError();
    }
    if (status !== 200) throw new AlertDeliveryError();
  };
}
