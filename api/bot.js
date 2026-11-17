// Telegram bot webhook: replies to /start, /play and /getid, and opens the Mini App.
const APP = process.env.APP_URL || 'https://runforearn.vercel.app', BOT = 'run_for_earn_bot';
const send = (chat_id, text, extra) => fetch('https://api.telegram.org/bot' + process.env.BOT_TOKEN + '/sendMessage', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(Object.assign({ chat_id, text, parse_mode: 'HTML' }, extra))
});
module.exports = async (req, res) => {
  try {
    if (req.method !== 'POST' || !process.env.WEBHOOK_SECRET || req.headers['x-telegram-bot-api-secret-token'] !== process.env.WEBHOOK_SECRET) return res.status(401).end();
    const m = (req.body || {}).message;
    if (m && m.chat && m.chat.type === 'private') {
      const parts = String(m.text || '').trim().split(/\s+/), cmd = parts[0].split('@')[0].toLowerCase(), arg = parts[1] || '';
      if (cmd === '/getid') await send(m.chat.id, 'Your Telegram ID: <code>' + m.from.id + '</code>');
      else {
        const ref = cmd === '/start' && /^[A-Za-z0-9]{1,12}$/.test(arg) ? 'https://t.me/' + BOT + '?startapp=' + arg.toUpperCase() : null; // old-style invite links
        const rows = [[ref ? { text: '🐰 RUN for EARN 🐰', url: ref } : { text: '🐰 RUN for EARN 🐰', web_app: { url: APP } }]];
        if (process.env.CHANNEL_URL) rows.push([{ text: 'Join our official channel', url: process.env.CHANNEL_URL }]);
        await send(m.chat.id, '<b>Welcome to RUN for EARN! 🐰</b>\n\nRun, jump and beat your high score. The top 5 players win real prizes every day.\n\nInvite friends and earn a commission on their winnings 🚀', { reply_markup: { inline_keyboard: rows } });
      }
    }
    res.status(200).json({ ok: true });
  } catch (e) { console.error(e); res.status(200).json({ ok: true }); } // always 200 so Telegram does not retry
};
