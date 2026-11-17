// Run for Earn backend: Telegram login check, daily leaderboard, referrals, prize settlement.
const crypto = require('crypto');
const admin = require('firebase-admin');
if (!admin.apps.length) admin.initializeApp({ credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
const db = admin.firestore(), FV = admin.firestore.FieldValue;
const PRIZES = [200, 100, 50, 30, 20], REF_RATE = 0.05;
const day = (back = 0) => new Date(Date.now() + 19800000 - back * 86400000).toISOString().slice(0, 10); // IST date

function verify(initData) {
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

async function credit(uid, amt, label) {
  const ref = db.collection('users').doc(uid), u = (await ref.get()).data() || {}, b = db.batch(), t = Date.now();
  b.set(ref, { wallet: { available: FV.increment(amt), earned: FV.increment(amt) } }, { merge: true });
  b.set(ref.collection('tx').doc(), { label, amount: amt, t });
  if (u.referredBy) {
    const c = Math.round(amt * REF_RATE * 100) / 100, rr = db.collection('users').doc(u.referredBy);
    b.set(rr, { wallet: { available: FV.increment(c), earned: FV.increment(c) }, refEarned: FV.increment(c) }, { merge: true });
    b.set(rr.collection('tx').doc(), { label: 'Referral 5% - ' + (u.name || 'friend'), amount: c, t });
    b.set(ref, { refEarnedForReferrer: FV.increment(c) }, { merge: true });
  }
  await b.commit();
}

async function settle(date) {
  const dref = db.doc('daily/' + date);
  const top = (await dref.collection('scores').orderBy('score', 'desc').limit(5).get()).docs;
  const first = await db.runTransaction(async t => {
    const s = await t.get(dref);
    if (s.exists && s.data().settled) return false;
    t.set(dref, { settled: true, at: Date.now() }, { merge: true });
    return true;
  });
  if (!first) return { settled: false, reason: 'already settled' };
  for (let i = 0; i < top.length; i++) await credit(top[i].id, PRIZES[i], 'Rank #' + (i + 1) + ' prize ' + date);
  return { settled: true, winners: top.length };
}

module.exports = async (req, res) => {
  try {
    if (req.method === 'GET') { // daily cron (Vercel sends Authorization: Bearer CRON_SECRET)
      if (req.query.action !== 'settle' || !process.env.CRON_SECRET || req.headers.authorization !== 'Bearer ' + process.env.CRON_SECRET) return res.status(401).json({ error: 'unauthorized' });
      return res.json(await settle(day(1)));
    }
    if (req.method !== 'POST') return res.status(405).end();
    const { action, initData, score } = req.body || {};
    const v = verify(initData || '');
    if (!v) return res.status(401).json({ error: 'invalid Telegram data' });
    const uid = String(v.user.id), ref = db.collection('users').doc(uid);
    const name = [v.user.first_name, v.user.last_name].filter(Boolean).join(' ') || v.user.username || 'Player';

    if (action === 'me') {
      let s = await ref.get();
      if (!s.exists) {
        let referredBy = null;
        if (/^[A-Z0-9]{1,12}$/.test(v.start)) {
          const rid = String(parseInt(v.start, 36));
          if (rid !== uid && (await db.collection('users').doc(rid).get()).exists) { referredBy = rid; await db.collection('users').doc(rid).set({ refCount: FV.increment(1) }, { merge: true }); }
        }
        await ref.set({ name, code: Number(uid).toString(36).toUpperCase(), wallet: { available: 0, pending: 0, earned: 0, withdrawn: 0 }, best: 0, referredBy, refCount: 0, refEarned: 0, createdAt: Date.now() });
      } else await ref.set({ name }, { merge: true });
      const u = (await ref.get()).data();
      const tx = (await ref.collection('tx').orderBy('t', 'desc').limit(20).get()).docs.map(d => ({ label: d.data().label, amount: d.data().amount }));
      const fr = (await db.collection('users').where('referredBy', '==', uid).limit(50).get()).docs.map(d => ({ name: d.data().name, earned: d.data().refEarnedForReferrer || 0 }));
      return res.json({ name, code: u.code, wallet: u.wallet, best: u.best || 0, history: tx, refs: { count: u.refCount || 0, earned: u.refEarned || 0, list: fr } });
    }
    if (action === 'start') { await ref.set({ run: { t0: Date.now() } }, { merge: true }); return res.json({ ok: true }); }
    if (action === 'score') {
      const u = (await ref.get()).data() || {}, s = Math.floor(Number(score));
      if (!u.run || !(s >= 0)) return res.status(400).json({ error: 'no active run' });
      const el = (Date.now() - u.run.t0) / 1000;
      await ref.set({ run: FV.delete() }, { merge: true }); // one score per run
      if (s > el * 40 + 30) return res.status(400).json({ error: 'invalid score' });
      const dref = db.doc('daily/' + day() + '/scores/' + uid), ds = await dref.get();
      if (!ds.exists || ds.data().score < s) await dref.set({ name, score: s });
      const best = Math.max(u.best || 0, s);
      await ref.set({ best }, { merge: true });
      return res.json({ best });
    }
    if (action === 'board') {
      const col = db.collection('daily/' + day() + '/scores');
      const top = (await col.orderBy('score', 'desc').limit(5).get()).docs.map(d => ({ name: d.data().name, score: d.data().score }));
      const mine = await col.doc(uid).get();
      let rank = 0, sc = 0;
      if (mine.exists) { sc = mine.data().score; rank = 1 + (await col.where('score', '>', sc).count().get()).data().count; }
      return res.json({ top, rank, score: sc });
    }
    res.status(400).json({ error: 'unknown action' });
  } catch (e) { console.error(e); res.status(500).json({ error: 'server error' }); }
};
