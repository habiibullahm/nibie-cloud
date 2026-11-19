import { describe, expect, it, vi } from 'vitest';
import { createMailer, MailSendError, type TransportFactoryInput } from '../../src/modules/billing/mailer.js';
import { createLogger } from '../../src/shared/logger.js';

const logger = createLogger({ level: 'silent' });
const mail = { host: 'smtp.example.test', port: 465, user: 'smtp-user', pass: 'smtp-pass-secret', from: 'no-reply@example.test' };
const msg = { to: 'a@example.test', subject: 's', text: 't', html: '<p>t</p>' };

describe('createMailer', () => {
  it('is a disabled no-op without configuration and never builds a transport', async () => {
    const factory = vi.fn();
    const m = createMailer(null, logger, factory);
    expect(m.enabled).toBe(false);
    await expect(m.send(msg)).resolves.toBeUndefined();
    expect(factory).not.toHaveBeenCalled();
  });

  it('uses implicit TLS on port 465 and STARTTLS (secure false) otherwise', () => {
    const factory = vi.fn((_o: TransportFactoryInput) => ({ sendMail: vi.fn() }));
    createMailer(mail, logger, factory);
    createMailer({ ...mail, port: 587 }, logger, factory);
    expect(factory.mock.calls[0]![0]).toMatchObject({ host: 'smtp.example.test', port: 465, secure: true, auth: { user: 'smtp-user', pass: 'smtp-pass-secret' } });
    expect(factory.mock.calls[1]![0]).toMatchObject({ port: 587, secure: false });
  });

  it('sends from MAIL_FROM with the Nibie Cloud display name', async () => {
    const sendMail = vi.fn(async () => ({}));
    await createMailer(mail, logger, () => ({ sendMail })).send(msg);
    expect(sendMail).toHaveBeenCalledWith({ from: { name: 'Nibie Cloud', address: 'no-reply@example.test' }, to: 'a@example.test', subject: 's', text: 't', html: '<p>t</p>' });
  });

  it('sends a plain-text mail with Reply-To when asked', async () => {
    const sendMail = vi.fn(async (_m: object) => ({}));
    await createMailer(mail, logger, () => ({ sendMail })).send({ to: 'a@example.test', subject: 's', text: 't', replyTo: 'help@example.test' });
    expect(sendMail).toHaveBeenCalledWith({ from: { name: 'Nibie Cloud', address: 'no-reply@example.test' }, to: 'a@example.test', subject: 's', text: 't', replyTo: 'help@example.test' });
    expect(sendMail.mock.calls[0]![0]).not.toHaveProperty('html');
  });

  it('turns an SMTP failure into MailSendError without the server text', async () => {
    const sendMail = vi.fn(async () => { throw new Error('535 auth failed for smtp-user smtp-pass-secret'); });
    const err = await createMailer(mail, logger, () => ({ sendMail })).send(msg).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MailSendError);
    expect((err as Error).message).not.toContain('smtp-pass-secret');
  });
});
