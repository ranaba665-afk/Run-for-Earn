// Admin API: protected by the ADMIN_KEY environment variable (min 16 chars).
const crypto = require('crypto');
const { db, FV, day, ue, getConfig, settle, initError } = require('./_lib');
const ok = k => { const a = Buffer.from(String(k || '')), b = Buffer.from(process.env.ADMIN_KEY || ''); return b.length >= 16 && a.length === b.length && crypto.timingSafeEqual(a, b); };
const U = id => db.collection('users').doc(String(id)), isDate = d => /^\d{4}-\d{2}-\d{2}$/.test(d);
module.exports = async (req, res) => {
  try {
    if (initError) return res.status(500).json({ error: 'Setup error: ' + initError });
    if (req.method !== 'POST') return res.status(405).end();
    if (!ok(req.headers['x-admin-key'])) { await new Promise(r => setTimeout(r, 1500)); return res.status(401).json({ error: 'Wrong key' }); }
    const b = req.body || {};
    if (b.action === 'withdrawals') {
      const q = await db.collection('withdrawals').where('status', '==', b.status || 'pending').limit(100).get();
      return res.json({ list: q.docs.map(d => ({ id: d.id, ...d.data() })).sort((x, y) => y.t - x.t) });
    }
    if (b.action === 'pay' || b.action === 'reject') {
      const wref = db.collection('withdrawals').doc(String(b.id));
      await db.runTransaction(async t => {
        const w = await t.get(wref);
        if (!w.exists || w.data().status !== 'pending') throw ue('Not pending');
        const d = w.data(), u = U(d.uid), now = Date.now();
        if (b.action === 'pay') {
          t.update(u, { 'wallet.pending': FV.increment(-d.amount), 'wallet.withdrawn': FV.increment(d.amount) });
          t.set(u.collection('tx').doc(), { label: 'Withdrawal of ₹' + d.amount + ' paid', amount: 0, t: now });
          t.update(wref, { status: 'paid', paidAt: now, ref: String(b.ref || '').slice(0, 60) });
        } else {
          t.update(u, { 'wallet.pending': FV.increment(-d.amount), 'wallet.available': FV.increment(d.amount) });
          t.set(u.collection('tx').doc(), { label: 'Withdrawal rejected - refunded', amount: d.amount, t: now });
          t.update(wref, { status: 'rejected', reason: String(b.reason || '').slice(0, 100), at: now });
        }
      });
      return res.json({ ok: true });
    }
    if (b.action === 'board') {
      const date = isDate(b.date) ? b.date : day(1), dref = db.doc('daily/' + date);
      const [meta, top] = await Promise.all([dref.get(), dref.collection('scores').orderBy('score', 'desc').limit(10).get()]);
      return res.json({ date, settled: !!(meta.exists && meta.data().settled), top: top.docs.map(d => ({ uid: d.id, ...d.data() })), cfg: await getConfig() });
    }
    if (b.action === 'settle') { if (!isDate(b.date) || b.date >= day()) throw ue('Only finished days can be paid'); return res.json(await settle(b.date)); }
    if (b.action === 'config') return res.json(await getConfig());
    if (b.action === 'setConfig') {
      const p = (b.prizes || []).map(Number), r = Number(b.refRate), m = Number(b.minWithdraw);
      if (p.length !== 5 || p.some(x => !(x >= 0 && x <= 100000))) throw ue('Enter 5 prizes (0 - 100000)');
      if (!(r >= 0 && r <= 0.5) || !(m >= 1)) throw ue('Bad referral % or minimum');
      await db.doc('config/main').set({ prizes: p, refRate: r, minWithdraw: m });
      return res.json({ ok: true });
    }
    if (b.action === 'ban') {
      if (!/^\d+$/.test(String(b.uid))) throw ue('Bad Telegram id');
      const e = await U(b.uid).get(); if (!e.exists) throw ue('User not found');
      await U(b.uid).set({ banned: !!b.banned }, { merge: true });
      return res.json({ ok: true, name: e.data().name });
    }
    res.status(400).json({ error: 'Unknown action' });
  } catch (e) {
    if (e.user) return res.status(400).json({ error: e.message });
    console.error(e); res.status(500).json({ error: 'Server error' });
  }
};
