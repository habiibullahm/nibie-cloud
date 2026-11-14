import nodemailer from 'nodemailer';
import type { Config } from '../../config/env.js';
import type { Logger } from '../../shared/logger.js';

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
}

export interface Mailer {
  /** False when no SMTP settings exist: callers skip sending and do not record a notice as sent. */
  readonly enabled: boolean;
  send(message: MailMessage): Promise<void>;
}

type Transport = { sendMail(message: { from: string; to: string; subject: string; text: string; html: string }): Promise<unknown> };

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
        await transport.sendMail({ from: mail.from, to: m.to, subject: m.subject, text: m.text, html: m.html });
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
