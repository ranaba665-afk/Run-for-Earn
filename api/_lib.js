// Shared helpers (files starting with "_" are not exposed as API routes)
const crypto = require('crypto'), admin = require('firebase-admin');
let initError = null; // shown to the app as a clear setup message instead of a blank 500
try {
  if (!process.env.BOT_TOKEN) throw 'BOT_TOKEN is missing in Vercel environment variables';
  if (!process.env.FIREBASE_SERVICE_ACCOUNT) throw 'FIREBASE_SERVICE_ACCOUNT is missing in Vercel environment variables';
  let sa; try { sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT); } catch (e) { throw 'FIREBASE_SERVICE_ACCOUNT is not valid JSON (paste the whole downloaded file)'; }
  if (!admin.apps.length) admin.initializeApp({ credential: admin.credential.cert(sa) });
} catch (e) { initError = typeof e === 'string' ? e : 'Firebase setup failed (check the service account JSON)'; }
const db = initError ? null : admin.firestore(), FV = admin.firestore.FieldValue;
const DEF = { prizes: [20, 15, 10, 5, 2], refRate: 0.05, minWithdraw: 20, welcomeBonus: 5 }; // USD / USDT
const day = (back = 0) => new Date(Date.now() + 19800000 - back * 86400000).toISOString().slice(0, 10); // IST date
const ue = m => Object.assign(new Error(m), { user: true }); // error safe to show to users
async function getConfig() { const s = await db.doc('config/main').get(); return Object.assign({}, DEF, s.exists ? s.data() : {}); }

function verify(initData) { // Telegram Mini App signature check
  const p = new URLSearchParams(initData), hash = p.get('hash');
  if (!hash) return null;
  p.delete('hash');
  const str = [...p.entries()].map(([k, v]) => k + '=' + v).sort().join('\n');
  const key = crypto.createHmac('sha256', 'WebAppData').update(process.env.BOT_TOKEN).digest();
  const h = crypto.createHmac('sha256', key).update(str).digest('hex');
  if (h.length !== hash.length || !crypto.timingSafeEqual(Buffer.from(h), Buffer.from(hash))) return null;
  if (Date.now() / 1000 - Number(p.get('auth_date')) > 86400) return null;
  try { return { user: JSON.parse(p.get('user')), start: p.get('start_param') || '' }; } catch (e) { return null; }
}

// Pays the day's top 5 (+ referral commission) in ONE atomic transaction; safe to run twice.
async function settle(date) {
  const cfg = await getConfig(), dref = db.doc('daily/' + date), U = id => db.collection('users').doc(id);
  return db.runTransaction(async t => {
    const ds = await t.get(dref);
    if (ds.exists && ds.data().settled) return { settled: false, reason: 'already settled' };
    const top = (await t.get(dref.collection('scores').orderBy('score', 'desc').limit(10))).docs;
    const us = top.length ? await t.getAll(...top.map(d => U(d.id))) : [];
    const win = [];
    us.forEach((u, i) => { const d = u.exists ? u.data() : {}; if (win.length < 5 && !d.banned) win.push({ id: u.id, name: d.name || 'Player', score: top[i].data().score, ref: d.referredBy || null, bonus: (d.wallet && d.wallet.bonus) || 0 }); });
    const rids = [...new Set(win.map(w => w.ref).filter(Boolean))];
    const rs = rids.length ? await t.getAll(...rids.map(U)) : [];
    const rok = new Set(rs.filter(r => r.exists && !r.data().banned).map(r => r.id));
    const now = Date.now();
    win.forEach((w, i) => {
      const amt = cfg.prizes[i] || 0; w.prize = amt; if (!amt) return;
      t.set(U(w.id), { wallet: { available: FV.increment(amt + w.bonus), earned: FV.increment(amt), bonus: 0 } }, { merge: true }); // a prize unlocks the locked welcome bonus
      if (w.bonus > 0) t.set(U(w.id).collection('tx').doc(), { label: 'Welcome bonus unlocked', amount: w.bonus, t: now });
      t.set(U(w.id).collection('tx').doc(), { label: 'Rank #' + (i + 1) + ' prize ' + date, amount: amt, t: now });
      const c = Math.round(amt * cfg.refRate * 100) / 100;
      if (w.ref && rok.has(w.ref) && c > 0) {
        t.set(U(w.ref), { wallet: { available: FV.increment(c), earned: FV.increment(c) }, refEarned: FV.increment(c) }, { merge: true });
        t.set(U(w.ref).collection('tx').doc(), { label: 'Referral commission - ' + w.name, amount: c, t: now });
        t.set(U(w.id), { refEarnedForReferrer: FV.increment(c) }, { merge: true });
      }
    });
    t.set(dref, { settled: true, at: now, winners: win.map(w => ({ uid: w.id, name: w.name, score: w.score, prize: w.prize || 0 })) }, { merge: true });
    return { settled: true, winners: win.length };
  });
}
module.exports = { db, FV, day, ue, getConfig, verify, settle, initError };
