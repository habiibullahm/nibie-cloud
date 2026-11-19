import nodemailer from 'nodemailer';
import type { Config } from '../../config/env.js';
import type { Logger } from '../../shared/logger.js';

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  /** Left out for a plain-text mail. */
  html?: string;
  /** Where a reply goes. A monitored address shows Gmail a person stands behind the mail; `noreply@` alone looks like bulk. */
  replyTo?: string;
}

export interface Mailer {
  /** False when no SMTP settings exist: callers skip sending and do not record a notice as sent. */
  readonly enabled: boolean;
  send(message: MailMessage): Promise<void>;
}

/** Shown as the sender name in the inbox; a bare `noreply@` address looks like bulk mail to Gmail. */
export const MAIL_FROM_NAME = 'Nibie Cloud';

type Transport = { sendMail(message: { from: { name: string; address: string }; to: string; subject: string; text: string; html?: string; replyTo?: string }): Promise<unknown> };

export interface TransportFactoryInput { host: string; port: number; secure: boolean; auth: { user: string; pass: string } }

const defaultFactory = (o: TransportFactoryInput): Transport =>
  nodemailer.createTransport({ ...o, connectionTimeout: 10_000, greetingTimeout: 10_000, socketTimeout: 20_000 });

/**
 * SMTP mailer over SumoPod. Port 465 uses implicit TLS; any other port starts plain and upgrades with
 * STARTTLS. Without configuration it is a disabled no-op. Errors are reduced to their class name: an SMTP
 * error text can contain the account name or server banner.
 */
export function createMailer(mail: Config['mail'], logger: Logger, transportFactory: (o: TransportFactoryInput) => Transport = defaultFactory): Mailer {
  if (!mail) {
    return { enabled: false, send: async () => { logger.warn('mail is not configured; email not sent'); } };
  }
  const transport = transportFactory({ host: mail.host, port: mail.port, secure: mail.port === 465, auth: { user: mail.user, pass: mail.pass } });
  return {
    enabled: true,
    async send(m) {
      try {
        await transport.sendMail({ from: { name: MAIL_FROM_NAME, address: mail.from }, to: m.to, subject: m.subject, text: m.text, ...(m.html ? { html: m.html } : {}), ...(m.replyTo ? { replyTo: m.replyTo } : {}) });
      } catch (e) {
        logger.warn({ errName: (e as Error).name }, 'email send failed');
        throw new MailSendError();
      }
    },
  };
}

export class MailSendError extends Error {
  constructor() {
    super('email could not be sent');
    this.name = 'MailSendError';
  }
}
