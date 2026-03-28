const nodemailer = require('nodemailer');

let transporter = null;

function getTransporter() {
  if (transporter) return transporter;
  if (!process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_PASS) return null;
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT || '587'),
    secure: process.env.SMTP_SECURE === 'true',
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });
  return transporter;
}

/**
 * Send payment confirmation email to registrant.
 * Silently skips if SMTP is not configured.
 */
async function sendPaymentConfirmation({ toEmail, toName, tournamentName }) {
  const t = getTransporter();
  if (!t || !toEmail) return;

  const from = process.env.EMAIL_FROM || process.env.SMTP_USER;
  await t.sendMail({
    from,
    to: toEmail,
    subject: `【报名确认】${tournamentName} · Registration Confirmed`,
    html: `
      <div style="font-family:sans-serif; max-width:560px; margin:0 auto; padding:32px 24px; background:#fff;">
        <div style="text-align:center; margin-bottom:24px;">
          <div style="font-size:2.5rem;">🐎🃏</div>
          <h2 style="color:#641E16; margin:8px 0;">硅谷掼蛋联赛</h2>
          <p style="color:#888; font-size:0.9rem;">Silicon Valley Guandan League</p>
        </div>

        <div style="background:#D5F5E3; border-radius:10px; padding:20px 24px; margin-bottom:24px; border-left:5px solid #27AE60;">
          <p style="margin:0; font-size:1.1rem; font-weight:700; color:#1E8449;">✅ 报名费已收到！</p>
          <p style="margin:6px 0 0; font-size:0.95rem; color:#27AE60;">Payment Received!</p>
        </div>

        <p style="color:#333; font-size:0.97rem;">亲爱的 <strong>${toName}</strong>，</p>
        <p style="color:#333; font-size:0.97rem;">您参加 <strong>${tournamentName}</strong> 的报名费已收到，请按照报名通知准时参加比赛。</p>
        <p style="color:#666; font-size:0.9rem; font-style:italic;">Dear <strong>${toName}</strong>, your registration fee for <strong>${tournamentName}</strong> has been received. Please attend the tournament on time as per the registration notice.</p>

        <div style="background:#FEF9E7; border:1px solid #D4AC0D; border-radius:8px; padding:16px 20px; margin:24px 0;">
          <p style="margin:0; font-size:0.88rem; color:#9A7D0A;">⚠️ 如有疑问请联系主办方 | Contact the organizer if you have any questions.</p>
        </div>

        <p style="text-align:center; font-size:0.78rem; color:#bbb; margin-top:32px;">
          🔒 此邮件由系统自动发送 | Automated email from Silicon Valley Guandan League<br>
          🐎 2026硅谷掼蛋联赛 · Silicon Valley Guandan League
        </p>
      </div>
    `,
  });
}

module.exports = { sendPaymentConfirmation };
