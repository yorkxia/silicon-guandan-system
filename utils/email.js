const { Resend } = require('resend');

let client = null;

function getClient() {
  if (client) return client;
  if (!process.env.RESEND_API_KEY) return null;
  client = new Resend(process.env.RESEND_API_KEY);
  return client;
}

async function sendPaymentConfirmation({ toEmail, toName, tournamentName, tournamentDate, tournamentLocation }) {
  const resend = getClient();
  if (!resend || !toEmail) return;

  const from = process.env.EMAIL_FROM || 'onboarding@resend.dev';

  const detailRows = [
    { icon: '🏆', label: '赛事名称 · Tournament', value: tournamentName },
    tournamentDate     ? { icon: '📅', label: '比赛日期 · Date',     value: tournamentDate }     : null,
    tournamentLocation ? { icon: '📍', label: '比赛地点 · Location', value: tournamentLocation } : null,
    { icon: '👤', label: '参赛者 · Participant', value: toName },
  ].filter(Boolean);

  const detailHtml = detailRows.map(r => `
    <tr>
      <td style="padding:10px 14px;border-bottom:1px solid #F0E8C0;font-size:0.85rem;color:#888;white-space:nowrap;width:1%">${r.icon} ${r.label}</td>
      <td style="padding:10px 14px;border-bottom:1px solid #F0E8C0;font-size:0.95rem;font-weight:700;color:#222">${r.value}</td>
    </tr>`).join('');

  await resend.emails.send({
    from,
    to: toEmail,
    subject: `【报名确认】${tournamentName} · Registration Confirmed`,
    html: `
      <div style="font-family:sans-serif; max-width:580px; margin:0 auto; padding:32px 24px; background:#fff;">
        <div style="text-align:center; margin-bottom:24px;">
          <div style="font-size:2.5rem;">🐎🃏</div>
          <h2 style="color:#641E16; margin:8px 0;">硅谷掼蛋联赛</h2>
          <p style="color:#888; font-size:0.9rem;">Silicon Valley Guandan League</p>
        </div>

        <div style="background:#D5F5E3; border-radius:10px; padding:20px 24px; margin-bottom:24px; border-left:5px solid #27AE60;">
          <p style="margin:0; font-size:1.1rem; font-weight:700; color:#1E8449;">✅ 报名费已收到！Payment Received!</p>
          <p style="margin:6px 0 0; font-size:0.9rem; color:#27AE60;">您的报名已完成确认，请准时参赛。</p>
        </div>

        <p style="color:#333; font-size:0.97rem;">亲爱的 <strong>${toName}</strong>，您好！</p>
        <p style="color:#555; font-size:0.93rem; line-height:1.6;">您的报名费已成功收到，以下是本次赛事的详细信息，请妥善保存：</p>

        <table style="width:100%;border-collapse:collapse;background:#FFFDF0;border:1px solid #E8D88A;border-radius:10px;overflow:hidden;margin:20px 0;">
          <thead>
            <tr style="background:linear-gradient(135deg,#641E16,#922B21)">
              <td colspan="2" style="padding:12px 16px;color:#FFD700;font-weight:700;font-size:1rem;letter-spacing:1px">📋 赛事报名信息</td>
            </tr>
          </thead>
          <tbody>${detailHtml}</tbody>
        </table>

        <p style="color:#666; font-size:0.88rem; font-style:italic; line-height:1.6;">
          Dear <strong>${toName}</strong>, your registration fee for <strong>${tournamentName}</strong> has been received.
          ${tournamentDate ? `The tournament is scheduled for <strong>${tournamentDate}</strong>. ` : ''}Please attend on time as per the registration notice.
        </p>

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

async function sendTournamentNotification({ toEmail, toName, tournamentName, tournamentDate, subject, bodyText, senderName }) {
  const resend = getClient();
  if (!resend || !toEmail) return;
  const from = process.env.EMAIL_FROM || 'onboarding@resend.dev';
  const bodyHtml = bodyText.replace(/\n/g, '<br>');
  await resend.emails.send({
    from,
    to: toEmail,
    subject: subject || `【赛事通知】${tournamentName}`,
    html: `
      <div style="font-family:sans-serif; max-width:580px; margin:0 auto; padding:32px 24px; background:#fff;">
        <div style="text-align:center; margin-bottom:24px;">
          <div style="font-size:2rem;">🏆📢</div>
          <h2 style="color:#641E16; margin:8px 0;">硅谷掼蛋联赛</h2>
          <p style="color:#888; font-size:0.9rem;">Silicon Valley Guandan League</p>
        </div>
        <div style="background:#FEF9E7; border-left:5px solid #D4AC0D; border-radius:0 10px 10px 0; padding:18px 22px; margin-bottom:24px;">
          <p style="margin:0; font-size:1rem; font-weight:700; color:#641E16;">📋 ${tournamentName}${tournamentDate ? '　· 　' + tournamentDate : ''}</p>
        </div>
        <p style="color:#333; font-size:0.97rem;">亲爱的 <strong>${toName}</strong>，您好！</p>
        <div style="background:#f9f9f9; border:1px solid #eee; border-radius:8px; padding:18px 22px; margin:18px 0; font-size:0.95rem; color:#333; line-height:1.8;">${bodyHtml}</div>
        <p style="font-size:0.82rem; color:#aaa; margin-top:8px;">— ${senderName || '赛事主办方'} · 硅谷掼蛋联赛</p>
        <p style="text-align:center; font-size:0.75rem; color:#ccc; margin-top:28px;">
          🔒 此邮件由系统自动发送 | Automated email from Silicon Valley Guandan League
        </p>
      </div>
    `,
  });
}

module.exports = { sendPaymentConfirmation, sendTournamentNotification };
