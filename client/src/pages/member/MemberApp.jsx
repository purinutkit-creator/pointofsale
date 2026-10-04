// Member Web App — Sukhumvit, Minimal / Premium, mobile first, real-time points & reward status
import { useEffect, useState, useCallback } from 'react';
import { Routes, Route, NavLink, useNavigate, useParams, Navigate } from 'react-router-dom';
import { io } from 'socket.io-client';
import './member.css';
import { api, auth, uid } from '../../lib/api.js';
import { toast } from '../../lib/store.js';
import { Button, Input, Select, Modal, Icon, Spinner, PinPad } from '../../components/ui.jsx';
import { int, money, fmtThaiLong, fmtThaiShort, fmtDateTime } from '../../lib/util.js';
import { qrSvg, barcodeSvg } from '@shared/codes.js';
import { POINT_TX_TYPES } from '@shared/points.js';

const m = (path, opts = {}) => api(path, { ...opts, member: true });

function useMember() {
  const [shop, setShop] = useState(null);
  const [me, setMe] = useState(null);
  const [ready, setReady] = useState(false);
  const load = useCallback(async () => {
    if (!auth.memberToken) { setMe(null); setReady(true); return null; }
    try { const x = await m('/m/me'); setMe(x); return x; } catch (e) { if (e.status === 401) auth.memberToken = null; setMe(null); return null; } finally { setReady(true); }
  }, []);
  useEffect(() => {
    m('/m/shop').then((s) => {
      setShop(s);
      const r = document.documentElement;
      if (s.theme?.memberPrimary) r.style.setProperty('--m-primary', s.theme.memberPrimary);
      if (s.theme?.memberAccent) r.style.setProperty('--m-accent', s.theme.memberAccent);
      if (s.memberFontUrl && !document.getElementById('m-font')) {
        const st = document.createElement('style'); st.id = 'm-font';
        st.textContent = `@font-face{font-family:'Sukhumvit';src:url('${s.memberFontUrl.replace(/'/g, '')}');font-display:swap}`;
        document.head.appendChild(st);
      }
      document.title = `${s.name} Member`;
    }).catch(() => {});
    load();
  }, [load]);
  return { shop, me, setMe, reload: load, ready };
}

export default function MemberApp() {
  const ctx = useMember();
  useEffect(() => {
    if (!ctx.me) return undefined;
    const s = io({ auth: { memberToken: auth.memberToken }, transports: ['websocket', 'polling'] });
    s.on('member:updated', () => ctx.reload());
    s.on('member:redemption', () => ctx.reload());
    s.on('member:notification', (n) => toast(n.title, 'success', 5000));
    return () => s.disconnect();
  }, [ctx.me?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!ctx.ready || !ctx.shop) return <div className="member-app"><div className="fullcenter"><Spinner /></div></div>;
  return (
    <div className="member-app">
      <Routes>
        <Route path="claim/:token" element={<Claim ctx={ctx} />} />
        <Route path="login" element={<Login ctx={ctx} />} />
        <Route path="*" element={ctx.me ? <Shell ctx={ctx} /> : <Navigate to="/m/login" replace />} />
      </Routes>
    </div>
  );
}

function Shell({ ctx }) {
  return (
    <>
      <div className="m-content">
        <Routes>
          <Route index element={<Home ctx={ctx} />} />
          <Route path="rewards" element={<Rewards ctx={ctx} />} />
          <Route path="history" element={<History />} />
          <Route path="card" element={<Profile ctx={ctx} />} />
          <Route path="*" element={<Navigate to="/m" replace />} />
        </Routes>
      </div>
      <nav className="m-nav">
        <NavLink end to="/m"><Icon name="home" />หน้าแรก</NavLink>
        <NavLink to="/m/rewards"><Icon name="gift" />รางวัล</NavLink>
        <NavLink to="/m/history"><Icon name="history" />ประวัติ</NavLink>
        <NavLink to="/m/card"><Icon name="user" />สมาชิก</NavLink>
      </nav>
    </>
  );
}

function Login({ ctx }) {
  const nav = useNavigate();
  const [phone, setPhone] = useState('');
  const [stage, setStage] = useState('phone');
  const [reg, setReg] = useState({ name: '', gender: 'unspecified', birthday: '', pin: '', pin2: '', accept: false, email: '' });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const back = sessionStorage.getItem('m.after') || '/m';
  const done = async (r) => { auth.memberToken = r.token; ctx.setMe(r.member); sessionStorage.removeItem('m.after'); nav(back, { replace: true }); };
  const check = async (e) => {
    e.preventDefault(); setBusy(true); setErr('');
    try { const r = await m('/m/check-phone', { method: 'POST', body: { phone } }); setStage(r.exists ? (r.hasPin ? 'pin' : 'nopin') : 'register'); } catch (x) { setErr(x.message); } finally { setBusy(false); }
  };
  const login = async (pin) => { setBusy(true); setErr(''); try { await done(await m('/m/login', { method: 'POST', body: { phone, pin } })); } catch (x) { setErr(x.message); } finally { setBusy(false); } };
  const register = async () => {
    if (!/^\d{4,6}$/.test(reg.pin) || reg.pin !== reg.pin2) return setErr('PIN ต้องเป็นตัวเลข 4–6 หลัก และตรงกัน');
    setBusy(true); setErr('');
    try { await done(await m('/m/register', { method: 'POST', body: { phone, name: reg.name, gender: reg.gender, birthday: reg.birthday || null, pin: reg.pin, acceptTerms: true, email: reg.email || '' } })); } catch (x) { setErr(x.message); } finally { setBusy(false); }
  };
  return (
    <div className="m-login">
      <div className="m-hero" style={ctx.shop.coverImageUrl ? { backgroundImage: `linear-gradient(rgba(0,0,0,.35),rgba(0,0,0,.6)), url("${ctx.shop.coverImageUrl}")` } : undefined}>
        {ctx.shop.logoUrl && <img src={ctx.shop.logoUrl} alt="" className="m-logo" />}
        <h1>{ctx.shop.name}</h1><div>Membership</div>
      </div>
      <div className="m-card col">
        {stage === 'phone' && (
          <form className="col" onSubmit={check}>
            <h2>เข้าสู่ระบบ / สมัครสมาชิก</h2>
            <Input size="lg" label="เบอร์โทรศัพท์" inputMode="tel" value={phone} onValue={(v) => setPhone(v.replace(/[^\d]/g, ''))} placeholder="08x xxx xxxx" autoFocus />
            {err && <div className="m-err">{err}</div>}
            <Button variant="primary" size="lg" type="submit" loading={busy} disabled={phone.length < 9}>ถัดไป</Button>
          </form>
        )}
        {stage === 'pin' && (<><h2>กรอก PIN</h2><div className="muted">{phone}</div><PinPad onSubmit={login} busy={busy} error={err} /><Button variant="ghost" onClick={() => setStage('phone')}>เปลี่ยนเบอร์</Button></>)}
        {stage === 'nopin' && (<><h2>ยังไม่ได้ตั้ง PIN</h2><div className="muted">บัญชีนี้สมัครผ่านพนักงาน กรุณาให้พนักงานตั้ง PIN ให้ที่ร้าน แล้วกลับมาเข้าสู่ระบบอีกครั้ง</div><Button onClick={() => setStage('phone')}>กลับ</Button></>)}
        {stage === 'register' && (
          <div className="col">
            <h2>ยังไม่พบสมาชิก — สมัครสมาชิก</h2>
            <Input label="เบอร์โทร" value={phone} disabled />
            <Input label="ชื่อ *" value={reg.name} onValue={(v) => setReg({ ...reg, name: v })} />
            <Select label="เพศ" value={reg.gender} onValue={(v) => setReg({ ...reg, gender: v })} options={[{ value: 'unspecified', label: 'ไม่ระบุ' }, { value: 'male', label: 'ชาย' }, { value: 'female', label: 'หญิง' }, { value: 'other', label: 'อื่นๆ' }]} />
            <Input label="วันเกิด" type="date" value={reg.birthday} onValue={(v) => setReg({ ...reg, birthday: v })} />
            <Input label="ตั้ง PIN 4–6 หลัก *" type="password" inputMode="numeric" value={reg.pin} onValue={(v) => setReg({ ...reg, pin: v })} />
            <Input label="ยืนยัน PIN *" type="password" inputMode="numeric" value={reg.pin2} onValue={(v) => setReg({ ...reg, pin2: v })} />
            <label className="check"><input type="checkbox" checked={reg.accept} onChange={(e) => setReg({ ...reg, accept: e.target.checked })} /><span className="small">{ctx.shop.termsText}</span></label>
            {err && <div className="m-err">{err}</div>}
            <Button variant="primary" size="lg" loading={busy} disabled={!reg.name || !reg.accept} onClick={register}>สมัครสมาชิก</Button>
            <Button variant="ghost" onClick={() => setStage('phone')}>กลับ</Button>
          </div>
        )}
      </div>
    </div>
  );
}

function TierProgress({ me, tiers }) {
  const cur = me.tier;
  const next = me.nextTier;
  const base = me.tierProgressBasis;
  const curMin = tiers.find((t) => t.id === cur?.id)?.min_points || 0;
  const pct = next ? Math.min(100, Math.max(0, ((base - curMin) / Math.max(1, next.minPoints - curMin)) * 100)) : 100;
  return (
    <div className="col gap-s">
      <div className="row between small"><b>{cur?.name || 'Member'}</b><span>{next ? `${int(base)} / ${int(next.minPoints)}` : 'ระดับสูงสุด'}</span></div>
      <div className="m-progress"><div style={{ width: `${pct}%`, background: cur?.color || 'var(--m-accent)' }} /></div>
      {next && <div className="xs muted">เหลืออีก {int(next.need)} คะแนน เพื่อเป็น {next.name}</div>}
    </div>
  );
}

function Home({ ctx }) {
  const { me, shop } = ctx;
  const [rewards, setRewards] = useState([]);
  const [promos, setPromos] = useState([]);
  const [bday, setBday] = useState([]);
  const [notes, setNotes] = useState([]);
  const [show, setShow] = useState(null);
  useEffect(() => {
    m('/m/rewards').then(setRewards).catch(() => {});
    m('/m/promotions').then(setPromos).catch(() => {});
    m('/m/birthday').then(setBday).catch(() => {});
    m('/m/notifications').then(setNotes).catch(() => {});
  }, [me.points]);
  const claimBday = async (c) => {
    try { const r = await m(`/m/birthday/${c.id}/claim`, { method: 'POST', body: {} }); toast('รับสิทธิ์วันเกิดแล้ว 🎂', 'success'); ctx.reload(); if (r.redemption) setShow(r.redemption); m('/m/birthday').then(setBday); } catch (e) { toast(e.message, 'error'); }
  };
  const unread = notes.filter((n) => !n.read_at).length;
  return (
    <div className="col gap-l">
      <div className="m-top">
        <div className="row between"><div><div className="small" style={{ opacity: 0.8 }}>สวัสดี</div><h2>คุณ {me.name}</h2></div>
          <button type="button" className="m-bell" onClick={async () => { await m('/m/notifications/read', { method: 'POST', body: {} }); setNotes(notes.map((n) => ({ ...n, read_at: n.read_at || 'x' }))); setShow({ notes: true }); }}><Icon name="bell" />{unread > 0 && <span>{unread}</span>}</button>
        </div>
        <div className="m-tier-badge" style={{ background: me.tier?.color }}>{me.tier?.icon} {me.tier?.name || 'Member'} Member</div>
        <div className="m-points"><span>{int(me.points)}</span> Points</div>
        <TierProgress me={me} tiers={shop.tiers} />
      </div>
      {me.activeRedemptions.length > 0 && (
        <section><h3>สิทธิ์ของคุณ</h3>
          <div className="m-scroll">{me.activeRedemptions.map((r) => <button key={r.id} type="button" className="m-coupon" onClick={() => setShow(r)}><b>{r.name}</b><span className="xs">หมดอายุ {fmtThaiShort(r.expires_at)}</span><span className="m-code">{r.code}</span></button>)}</div>
        </section>
      )}
      {bday.filter((c) => c.eligible && !c.claimed).map((c) => (
        <section key={c.id} className="m-bday">
          <div style={{ fontSize: 34 }}>🎂</div>
          <div className="grow"><b>{c.message || c.name}</b><div className="small">{c.benefit === 'points' ? `รับ ${c.points} คะแนน` : `รับฟรี ${c.rewardName}`}</div></div>
          <Button variant="primary" onClick={() => claimBday(c)}>รับสิทธิ์</Button>
        </section>
      ))}
      <section><div className="row between"><h3>Reward แนะนำ</h3><NavLink to="/m/rewards" className="small">ดูทั้งหมด</NavLink></div>
        <div className="m-scroll">{rewards.slice(0, 6).map((r) => <RewardCard key={r.id} r={r} compact />)}</div>
      </section>
      {promos.length > 0 && <section><h3>โปรโมชั่น</h3>{promos.map((p) => <div key={p.id} className="m-promo">{p.image_url && <img src={p.image_url} alt="" />}<div><b>{p.name}</b><div className="small muted">{p.description}</div></div></div>)}</section>}
      {me.tier && shop.tiers.length > 0 && <section><h3>สิทธิประโยชน์ระดับสมาชิก</h3>{shop.tiers.map((t) => <div key={t.id} className="m-tier-row" style={{ borderColor: t.color }}><b style={{ color: t.color }}>{t.icon} {t.name}</b><span className="small muted">{int(t.min_points)}{t.max_points != null ? `–${int(t.max_points)}` : '+'} คะแนน</span><div className="small">{t.benefits}</div></div>)}</section>}
      {show?.code && <CodeModal r={show} onClose={() => setShow(null)} />}
      {show?.notes && <Modal title="การแจ้งเตือน" onClose={() => setShow(null)}>{notes.length ? notes.map((n) => <div key={n.id} className="m-note"><b>{n.title}</b><div className="small muted">{n.body}</div><div className="xs muted">{fmtDateTime(n.created_at)}</div></div>) : <div className="empty">ไม่มีการแจ้งเตือน</div>}</Modal>}
    </div>
  );
}

function RewardCard({ r, compact, onRedeem }) {
  return (
    <div className={`m-reward ${compact ? 'compact' : ''}`}>
      <div className="img" style={r.imageUrl ? { backgroundImage: `url("${r.imageUrl}")` } : undefined}>{!r.imageUrl && <Icon name="gift" size={32} />}</div>
      <div className="body">
        <b>{r.name}</b>
        <div className="m-pts">{int(r.pointsRequired)} Points</div>
        {!compact && r.description && <div className="small muted">{r.description}</div>}
        {!compact && r.remaining != null && <div className="xs muted">เหลือ {r.remaining} สิทธิ์</div>}
        {!compact && (r.blocker ? <div className="xs" style={{ color: 'var(--danger)' }}>{r.blocker}</div> : <Button variant="primary" block onClick={() => onRedeem(r)}>แลกรางวัล</Button>)}
      </div>
    </div>
  );
}

export function CodeModal({ r, onClose }) {
  const name = r.name || r.reward_name;
  return (
    <Modal title={name} size="narrow" onClose={onClose}>
      <div className="col center" style={{ alignItems: 'center' }}>
        <div className="muted">Redemption Code</div>
        <div style={{ fontSize: 40, fontWeight: 800, letterSpacing: 6 }}>{r.code}</div>
        <div style={{ width: '100%', height: 80 }} dangerouslySetInnerHTML={{ __html: barcodeSvg(r.code, 60) }} />
        <div style={{ width: 200 }} dangerouslySetInnerHTML={{ __html: qrSvg(r.code) }} />
        <div className="m-tier-badge" style={{ background: r.status === 'active' ? 'var(--success)' : '#888' }}>{r.status === 'active' ? 'พร้อมใช้งาน' : r.status === 'used' ? 'ใช้แล้ว' : r.status}</div>
        <div className="small">หมดอายุ {fmtThaiLong(r.expires_at, undefined, true)}</div>
        <div className="xs muted">แสดงรหัสนี้ให้พนักงานสแกนที่ POS · ใช้ได้ครั้งเดียว</div>
      </div>
    </Modal>
  );
}

function Rewards({ ctx }) {
  const [list, setList] = useState(null);
  const [mine, setMine] = useState([]);
  const [confirm, setConfirm] = useState(null);
  const [show, setShow] = useState(null);
  const [busy, setBusy] = useState(false);
  const load = () => { m('/m/rewards').then(setList); m('/m/redemptions').then(setMine); };
  useEffect(load, [ctx.me.points]);
  const redeem = async () => {
    setBusy(true);
    try { const r = await m(`/m/rewards/${confirm.id}/redeem`, { method: 'POST', body: { txnId: uid() } }); setConfirm(null); setShow({ ...r, name: r.reward_name }); ctx.reload(); load(); } catch (e) { toast(e.message, 'error'); } finally { setBusy(false); }
  };
  return (
    <div className="col gap-l">
      <div className="m-top slim"><h2>ของรางวัล</h2><div className="m-points small-p"><span>{int(ctx.me.points)}</span> Points</div></div>
      {!list ? <Spinner /> : <div className="m-grid">{list.map((r) => <RewardCard key={r.id} r={r} onRedeem={setConfirm} />)}</div>}
      {mine.length > 0 && <section><h3>รางวัลของฉัน</h3>{mine.map((r) => <button type="button" key={r.id} className="m-coupon wide" onClick={() => setShow(r)} style={{ opacity: r.status === 'active' ? 1 : 0.55 }}><b>{r.name}</b><span className="xs">{r.status === 'active' ? `หมดอายุ ${fmtThaiShort(r.expires_at)}` : r.status === 'used' ? `ใช้แล้ว ${fmtThaiShort(r.used_at)}` : r.status}</span><span className="m-code">{r.code}</span></button>)}</section>}
      {confirm && (
        <Modal title="ยืนยันการแลก" size="narrow" onClose={() => setConfirm(null)} footer={<><Button onClick={() => setConfirm(null)}>ยกเลิก</Button><Button variant="primary" loading={busy} onClick={redeem}>ยืนยัน</Button></>}>
          <p>คุณต้องการใช้ <b>{int(confirm.pointsRequired)} คะแนน</b> เพื่อแลก <b>{confirm.name}</b> หรือไม่</p>
        </Modal>
      )}
      {show && <CodeModal r={show} onClose={() => setShow(null)} />}
    </div>
  );
}

function History() {
  const [list, setList] = useState(null);
  useEffect(() => { m('/m/history').then(setList); }, []);
  return (
    <div className="col gap-l">
      <div className="m-top slim"><h2>ประวัติ</h2></div>
      {!list ? <Spinner /> : !list.length ? <div className="empty">ยังไม่มีประวัติ</div> : list.map((t) => (
        <div key={t.id} className="m-hist">
          <div className="m-date">{fmtThaiShort(t.created_at)}</div>
          <div className="grow"><b>{t.order_no ? `Order #${t.order_no}` : POINT_TX_TYPES[t.type]}</b><div className="small muted">{t.amount ? `${money(t.amount)} บาท · ` : ''}{t.reason || POINT_TX_TYPES[t.type]}{t.branch_name ? ` · ${t.branch_name}` : ''}</div></div>
          <b style={{ color: t.points > 0 ? 'var(--success)' : 'var(--danger)' }}>{t.points > 0 ? '+' : ''}{t.points}</b>
        </div>
      ))}
    </div>
  );
}

function Profile({ ctx }) {
  const nav = useNavigate();
  const { me, shop } = ctx;
  const [edit, setEdit] = useState(null);
  const [pin, setPin] = useState(null);
  const save = async () => { try { ctx.setMe(await m('/m/me', { method: 'PUT', body: edit })); setEdit(null); toast('บันทึกแล้ว', 'success'); } catch (e) { toast(e.message, 'error'); } };
  return (
    <div className="col gap-l">
      <div className="m-membercard" style={{ background: `linear-gradient(135deg, ${me.tier?.color || '#333'}, var(--m-primary))` }}>
        <div className="row between"><b style={{ letterSpacing: 2 }}>{(me.tier?.name || 'MEMBER').toUpperCase()} MEMBER</b>{shop.logoUrl && <img src={shop.logoUrl} alt="" style={{ height: 32, borderRadius: 8 }} />}</div>
        <div style={{ fontSize: 24, fontWeight: 700, marginTop: 14 }}>{me.name}</div>
        <div className="row between mt"><div><div className="xs" style={{ opacity: 0.8 }}>Member ID</div><b>{me.memberCode}</b></div><div className="right"><div className="xs" style={{ opacity: 0.8 }}>Points</div><b style={{ fontSize: 22 }}>{int(me.points)}</b></div></div>
        <div className="m-codes">
          <div style={{ height: 60 }} dangerouslySetInnerHTML={{ __html: barcodeSvg(me.memberCode, 50) }} />
          <div style={{ width: 110 }} dangerouslySetInnerHTML={{ __html: qrSvg(me.memberCode) }} />
        </div>
        <div className="xs center" style={{ opacity: 0.85 }}>ให้พนักงานสแกนที่ POS เพื่อสะสมแต้ม</div>
      </div>
      <section className="m-card col gap-s">
        {[['เบอร์โทร', me.phone], ['อีเมล', me.email || '-'], ['วันเกิด', me.birthday ? fmtThaiLong(me.birthday) : '-'], ['สมาชิกตั้งแต่', fmtThaiLong(me.createdAt)], ['คะแนนสะสมตลอดชีพ', int(me.lifetimePoints)], ['ยอดซื้อสะสม', `${money(me.totalSpend)} บาท`]].map(([k, v]) => <div key={k} className="row between"><span className="muted">{k}</span><b>{v}</b></div>)}
        <Button onClick={() => setEdit({ name: me.name, email: me.email || '', gender: me.gender || 'unspecified', birthday: me.birthday || '', notifyChannels: me.notifyChannels })}>แก้ไขข้อมูล</Button>
        <Button onClick={() => setPin({ currentPin: '', newPin: '' })}>เปลี่ยน PIN</Button>
        <Button variant="ghost" icon="logout" onClick={async () => { await m('/m/logout', { method: 'POST', body: {} }).catch(() => {}); auth.memberToken = null; ctx.setMe(null); nav('/m/login'); }}>ออกจากระบบ</Button>
      </section>
      {edit && (
        <Modal title="แก้ไขข้อมูล" onClose={() => setEdit(null)} footer={<Button variant="primary" onClick={save}>บันทึก</Button>}>
          <div className="col">
            <Input label="ชื่อ" value={edit.name} onValue={(v) => setEdit({ ...edit, name: v })} />
            <Input label="อีเมล" value={edit.email} onValue={(v) => setEdit({ ...edit, email: v })} />
            <Select label="เพศ" value={edit.gender} onValue={(v) => setEdit({ ...edit, gender: v })} options={[{ value: 'unspecified', label: 'ไม่ระบุ' }, { value: 'male', label: 'ชาย' }, { value: 'female', label: 'หญิง' }, { value: 'other', label: 'อื่นๆ' }]} />
            <Input label="วันเกิด (ตั้งได้ครั้งเดียว)" type="date" value={edit.birthday} disabled={!!me.birthday} onValue={(v) => setEdit({ ...edit, birthday: v })} />
            <div className="row wrap">{['email', 'sms', 'line'].map((c) => <label key={c} className="check"><input type="checkbox" checked={edit.notifyChannels.includes(c)} onChange={(e) => setEdit({ ...edit, notifyChannels: e.target.checked ? [...edit.notifyChannels, c] : edit.notifyChannels.filter((x) => x !== c) })} />รับแจ้งเตือน {c.toUpperCase()}</label>)}</div>
          </div>
        </Modal>
      )}
      {pin && (
        <Modal title="เปลี่ยน PIN" size="narrow" onClose={() => setPin(null)} footer={<Button variant="primary" onClick={async () => { try { await m('/m/me/pin', { method: 'POST', body: pin }); setPin(null); toast('เปลี่ยน PIN แล้ว', 'success'); } catch (e) { toast(e.message, 'error'); } }}>บันทึก</Button>}>
          <div className="col"><Input label="PIN เดิม" type="password" inputMode="numeric" value={pin.currentPin} onValue={(v) => setPin({ ...pin, currentPin: v })} /><Input label="PIN ใหม่ (4–6 หลัก)" type="password" inputMode="numeric" value={pin.newPin} onValue={(v) => setPin({ ...pin, newPin: v })} /></div>
        </Modal>
      )}
    </div>
  );
}

// สะสมแต้มจาก QR ท้ายใบเสร็จ — ใช้ได้ครั้งเดียว
function Claim({ ctx }) {
  const { token } = useParams();
  const nav = useNavigate();
  const [rc, setRc] = useState(null);
  const [err, setErr] = useState('');
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { m(`/m/claim/${token}`).then(setRc).catch((e) => setErr(e.message)); }, [token]);
  const claim = async () => {
    if (!ctx.me) { sessionStorage.setItem('m.after', `/m/claim/${token}`); nav('/m/login'); return; }
    setBusy(true);
    try { const r = await m(`/m/claim/${token}`, { method: 'POST', body: {} }); setResult(r); ctx.setMe(r.member); } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };
  return (
    <div className="m-login">
      <div className="m-hero">{ctx.shop.logoUrl && <img src={ctx.shop.logoUrl} alt="" className="m-logo" />}<h1>สะสมแต้ม</h1><div>{ctx.shop.name}</div></div>
      <div className="m-card col center" style={{ alignItems: 'center' }}>
        {err && <div className="m-err">{err}</div>}
        {!rc && !err && <Spinner />}
        {rc && !result && (
          <>
            <div className="muted">ใบเสร็จ {rc.receipt_no} · {rc.branch_name}</div>
            <div>{fmtThaiLong(rc.created_at, undefined, true)}</div>
            <div style={{ fontSize: 22 }}>ยอดซื้อ {money(rc.total)} บาท</div>
            <div className="m-points"><span>+{int(rc.claim_points)}</span> Points</div>
            {rc.claim_status === 'available' ? <Button variant="primary" size="lg" block loading={busy} onClick={claim}>{ctx.me ? `สะสมแต้มให้คุณ ${ctx.me.name}` : 'เข้าสู่ระบบเพื่อสะสมแต้ม'}</Button>
              : <div className="m-err">{rc.claim_status === 'used' ? 'ใบเสร็จนี้สะสมแต้มไปแล้ว' : 'QR Code นี้ไม่สามารถใช้ได้'}</div>}
          </>
        )}
        {result && (<><Icon name="check" size={56} style={{ color: 'var(--success)' }} /><h2>สะสมแต้มสำเร็จ</h2><div>คุณได้รับ +{result.points} คะแนน</div><Button variant="primary" onClick={() => nav('/m')}>ไปหน้าสมาชิก</Button></>)}
      </div>
    </div>
  );
}
