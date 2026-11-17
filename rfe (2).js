// Player API: Telegram login, scores, daily leaderboard, referrals, withdrawal requests.
const { db, FV, day, ue, getConfig, verify, settle, initError } = require('./_lib');
module.exports = async (req, res) => {
  try {
    if (initError) return res.status(500).json({ error: 'Setup error: ' + initError });
    if (req.method === 'GET') { // daily cron (Vercel sends Authorization: Bearer CRON_SECRET)
      if (req.query.action !== 'settle' || !process.env.CRON_SECRET || req.headers.authorization !== 'Bearer ' + process.env.CRON_SECRET) return res.status(401).json({ error: 'unauthorized' });
      return res.json(await settle(day(1)));
    }
    if (req.method !== 'POST') return res.status(405).end();
    const b = req.body || {}, v = verify(b.initData || '');
    if (!v) return res.status(401).json({ error: 'Invalid Telegram data' });
    const uid = String(v.user.id), ref = db.collection('users').doc(uid);
    const name = [v.user.first_name, v.user.last_name].filter(Boolean).join(' ') || v.user.username || 'Player';
    const cfg = await getConfig(), snap = await ref.get();
    if (snap.exists && snap.data().banned) return res.status(403).json({ error: 'Account blocked' });
    if (b.action !== 'me' && !snap.exists) return res.status(400).json({ error: 'Please reopen the app' });
    const u0 = snap.exists ? snap.data() : {};

    if (b.action === 'me') {
      if (!snap.exists) {
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
      return res.json({ name, code: u.code, wallet: u.wallet, best: u.best || 0, history: tx, refs: { count: u.refCount || 0, earned: u.refEarned || 0, list: fr }, cfg });
    }
    if (b.action === 'start') { await ref.set({ run: { t0: Date.now() } }, { merge: true }); return res.json({ ok: true }); }
    if (b.action === 'score') {
      const s = Math.floor(Number(b.score));
      if (!u0.run || !(s >= 0)) throw ue('No active run');
      const el = (Date.now() - u0.run.t0) / 1000;
      await ref.set({ run: FV.delete() }, { merge: true }); // one score per run
      if (s > el * 40 + 30) throw ue('Invalid score');
      const dref = db.doc('daily/' + day() + '/scores/' + uid), ds = await dref.get();
      if (!ds.exists || ds.data().score < s) await dref.set({ name, score: s }); // keeps only the highest score
      const best = Math.max(u0.best || 0, s);
      await ref.set({ best }, { merge: true });
      return res.json({ best });
    }
    if (b.action === 'board') {
      const col = db.collection('daily/' + day() + '/scores');
      const top = (await col.orderBy('score', 'desc').limit(5).get()).docs.map(d => ({ name: d.data().name, score: d.data().score }));
      const mine = await col.doc(uid).get();
      let rank = 0, sc = 0;
      if (mine.exists) { sc = mine.data().score; rank = 1 + (await col.where('score', '>', sc).count().get()).data().count; }
      return res.json({ top, rank, score: sc, prizes: cfg.prizes });
    }
    if (b.action === 'withdraw') {
      const amt = Math.round(Number(b.amount) * 100) / 100;
      const holder = String(b.name || '').trim(), acc = String(b.acc || '').replace(/\s/g, ''), ifsc = String(b.ifsc || '').toUpperCase().trim();
      if (!(amt >= cfg.minWithdraw)) throw ue('Minimum withdrawal is ₹' + cfg.minWithdraw);
      if (holder.length < 3 || holder.length > 60 || !/^\d{9,18}$/.test(acc) || !/^[A-Z]{4}0[A-Z0-9]{6}$/.test(ifsc)) throw ue('Please check the bank details');
      await db.runTransaction(async t => {
        const w = ((await t.get(ref)).data() || {}).wallet || {};
        if ((w.pending || 0) > 0) throw ue('You already have a pending withdrawal');
        if (amt > (w.available || 0) + 1e-9) throw ue('Insufficient balance');
        t.update(ref, { 'wallet.available': FV.increment(-amt), 'wallet.pending': FV.increment(amt) });
        t.set(ref.collection('tx').doc(), { label: 'Withdrawal requested', amount: -amt, t: Date.now() });
        t.set(db.collection('withdrawals').doc(), { uid, tgName: name, holder, acc, ifsc, amount: amt, status: 'pending', t: Date.now() });
      });
      return res.json({ ok: true });
    }
    res.status(400).json({ error: 'Unknown action' });
  } catch (e) {
    if (e.user) return res.status(400).json({ error: e.message });
    console.error(e); res.status(500).json({ error: 'Server error' });
  }
};
