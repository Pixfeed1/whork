// Envoi d'e-mails (réinitialisation du mot de passe). Actif si SMTP_HOST est défini.
import nodemailer from "nodemailer";

export const mailEnabled = () => !!process.env.SMTP_HOST;

let transport: ReturnType<typeof nodemailer.createTransport> | null = null;
function getTransport() {
  if (!transport) {
    const port = Number(process.env.SMTP_PORT ?? 587);
    transport = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port,
      secure: process.env.SMTP_SECURE ? process.env.SMTP_SECURE === "true" : port === 465,
      auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
    });
  }
  return transport;
}

export async function sendMail(to: string, subject: string, text: string, html: string) {
  await getTransport().sendMail({
    from: process.env.SMTP_FROM ?? process.env.SMTP_USER,
    to,
    subject,
    text,
    html,
  });
}

export function resetMail(name: string, link: string) {
  const text = `Bonjour ${name},

Vous avez demandé à réinitialiser votre mot de passe MétréToit.
Cliquez sur ce lien (valable 1 heure) pour choisir un nouveau mot de passe :
${link}

Si vous n'êtes pas à l'origine de cette demande, ignorez ce message : votre mot de passe actuel reste valable.`;
  const html = `<div style="font-family:Arial,sans-serif;font-size:15px;color:#1b2b3f;max-width:520px">
<p>Bonjour ${escapeHtml(name)},</p>
<p>Vous avez demandé à réinitialiser votre mot de passe <b>MétréToit</b>.</p>
<p><a href="${link}" style="display:inline-block;background:#0f7ea8;color:#fff;padding:12px 22px;border-radius:999px;text-decoration:none;font-weight:bold">Choisir un nouveau mot de passe</a></p>
<p style="color:#6b7280;font-size:13px">Ce lien est valable 1 heure. Si vous n'êtes pas à l'origine de cette demande, ignorez ce message : votre mot de passe actuel reste valable.</p>
</div>`;
  return { text, html };
}

function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}
