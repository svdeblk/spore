import { Resend } from 'resend';

export function createMailer(config, { log = console.log, resend } = {}) {
  if (config.mailTransport === 'console') {
    return {
      async send({ to, subject, text }) {
        log(`mail to ${to}: ${subject}\n${text}`);
      },
    };
  }

  if (config.mailTransport === 'resend') {
    const client = resend ?? new Resend(config.resendApiKey);
    return {
      async send({ to, subject, text, html }) {
        // resend reports a refused message in the result instead of throwing
        const { error } = await client.emails.send({ from: config.fromEmail, to, subject, text, html });
        if (error) throw new Error(`resend refused the message to ${to}: ${error.message}`);
      },
    };
  }

  throw new Error(`MAIL_TRANSPORT must be console or resend, not ${config.mailTransport}`);
}
