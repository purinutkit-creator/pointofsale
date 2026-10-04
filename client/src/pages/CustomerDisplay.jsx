// Customer Display: real-time cart / totals / QR / change, idle promotion slideshow,
// "สะสมแต้ม" numeric keypad (member self lookup / register) and "ใช้ Reward".
import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api, auth } from '../lib/api.js';
import { connectSocket, on, getSocket, onConnection } from '../lib/socket.js';
import { useApp } from '../lib/store.js';
import { Button, Icon, NumPad, applyKey, Input, Select, Modal } from '../components/ui.jsx';
import { money, int, cls } from '../lib/util.js';
import { qrSvg } from '@shared/codes.js';

let bc = null;
try { bc = new BroadcastChannel('pos-display'); } catch { bc = null; }

export default function CustomerDisplay() {
  const nav = useNavigate();
  const [params] = useSearchParams();
  const local = params.get('local') === '1';
  const settings = useApp((s) => s.settings);
  const [state, setState] = useState({ stage: 'idle' });
  const [slide, setSlide] = useState(0);
  const [panel, setPanel] = useState(null);
  const [connected, setConnected] = useState(true);

  useEffect(() => {
    (async () => {
      if (!auth.deviceToken) return nav('/device');
      await useApp.getState().loadDevice();
      if (!local) {
        connectSocket();
        on('display:state', (s) => setState(s));
        onConnection(setConnected);
      }
    })();
    if (bc && local) bc.onmessage = (e) => { if (e.data?.kind === 'state') setState(e.data.state); };
    return () => { if (bc) bc.onmessage = null; };
  }, [nav, local]);

  const display = settings?.display || {};
  const images = display.images || [];
  useEffect(() => {
    if (state.stage !== 'idle' || images.length < 2) return undefined;
    const t = setInterval(() => setSlide((s) => (s + 1) % images.length), (Number(display.intervalSec) || 8) * 1000);
    return () => clearInterval(t);
  }, [state.stage, images.length, display.intervalSec]);
  useEffect(() => { if (state.stage === 'idle' || state.stage === 'done') setPanel(null); }, [state.stage]);

  const emit = (event) => {
    if (local) bc?.postMessage({ kind: 'event', event });
    else getSocket()?.emit('display:event', event);
  };
  const shop = settings?.shop || {};

  if (state.stage === 'idle') {
    return (
      <div style={{ height: '100dvh', background: '#000', position: 'relative', overflow: 'hidden' }} onDoubleClick={() => document.documentElement.requestFullscreen?.()}>
        {images.length ? images.map((src, i) => (
          <img key={src + i} src={src} alt="" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover', opacity: i === slide ? 1 : 0, transition: 'opacity 1s' }} />
        )) : (
          <div className="fullcenter col" style={{ color: '#fff', background: 'linear-gradient(135deg, var(--primary), #111)', height: '100%', alignItems: 'center' }}>
            {shop.logoUrl && <img src={shop.logoUrl} alt="" style={{ width: 160, height: 160, borderRadius: 32, objectFit: 'cover' }} />}
            <h1 style={{ fontSize: 56 }}>{shop.name}</h1>
            <div style={{ fontSize: 28 }}>{display.welcomeText || 'ยินดีต้อนรับ'}</div>
          </div>
        )}
        {!connected && <span className="badge danger" style={{ position: 'absolute', top: 10, right: 10 }}>Offline</span>}
      </div>
    );
  }

  const t = state.totals;
  return (
    <div style={{ height: '100dvh', display: 'grid', gridTemplateColumns: 'minmax(0, 1.3fr) minmax(320px, 1fr)', background: 'var(--bg)' }}>
      <div className="col" style={{ padding: 20, minHeight: 0 }}>
        <div className="row">
          {shop.logoUrl && <img src={shop.logoUrl} alt="" style={{ width: 52, height: 52, borderRadius: 12, objectFit: 'cover' }} />}
          <div><h2>{shop.name}</h2><div className="muted">{state.queueNo ? `คิว ${state.queueNo}` : state.table ? `โต๊ะ ${state.table}` : ''}</div></div>
        </div>
        <div className="card" style={{ flex: 1, overflow: 'auto' }}>
          {(state.items || []).map((i) => (
            <div key={i.id} style={{ padding: '12px 16px', borderBottom: '1px solid var(--border)' }}>
              <div className="row between" style={{ fontSize: 20 }}><b>{i.qty} × {i.name}{i.variant ? ` (${i.variant})` : ''}</b><b className="num">{money(i.total)}</b></div>
              {i.modifiers?.length > 0 && <div className="muted">{i.modifiers.join(', ')}</div>}
            </div>
          ))}
          {!state.items?.length && state.stage === 'cart' && <div className="empty">กำลังเพิ่มรายการ…</div>}
        </div>
      </div>
      <div className="col" style={{ padding: 20, background: 'var(--surface)', borderLeft: '1px solid var(--border)', minHeight: 0, overflow: 'auto' }}>
        {state.stage === 'done' ? (
          <div className="col center" style={{ alignItems: 'center', margin: 'auto' }}>
            <Icon name="check" size={80} style={{ color: 'var(--success)' }} />
            <h1>ขอบคุณที่ใช้บริการ</h1>
            {state.change > 0 && <><div className="muted" style={{ fontSize: 22 }}>เงินทอน</div><div className="change-big" style={{ fontSize: 64, fontWeight: 800, color: 'var(--success)' }}>฿{money(state.change)}</div></>}
            {state.member && <div className="card pad" style={{ fontSize: 20 }}>คุณ{state.member.name} ได้รับ <b style={{ color: 'var(--success)' }}>+{state.member.earned}</b> คะแนน · คงเหลือ {int(state.member.balance)}</div>}
          </div>
        ) : state.stage === 'payment' ? (
          <div className="col center" style={{ alignItems: 'center' }}>
            <div className="muted" style={{ fontSize: 22 }}>ยอดชำระ</div>
            <div style={{ fontSize: 60, fontWeight: 800 }} className="num">฿{money(state.remaining ?? state.due)}</div>
            {state.qr && <div style={{ width: 300, background: '#fff', padding: 10, borderRadius: 16 }} dangerouslySetInnerHTML={{ __html: qrSvg(state.qr) }} />}
            {!state.qr && state.qrImage && <img src={state.qrImage} alt="QR" style={{ width: 300, borderRadius: 16 }} />}
            {(state.qr || state.qrImage) && <div className="bold">สแกนจ่ายด้วย PromptPay {state.accountName ? `· ${state.accountName}` : ''}</div>}
            {state.received > 0 && <div style={{ fontSize: 24 }}>รับเงิน ฿{money(state.received)}</div>}
            {state.change > 0 && <div style={{ fontSize: 30, color: 'var(--success)', fontWeight: 800 }}>เงินทอน ฿{money(state.change)}</div>}
          </div>
        ) : (
          <>
            {t && (
              <div className="col gap-s" style={{ fontSize: 20 }}>
                <div className="row between"><span>Subtotal</span><span className="num">{money(t.subtotal)}</span></div>
                {t.discount > 0 && <div className="row between" style={{ color: 'var(--danger)' }}><span>Discount</span><span className="num">-{money(t.discount)}</span></div>}
                {t.serviceCharge > 0 && <div className="row between"><span>Service Charge {t.serviceChargeRate}%</span><span className="num">{money(t.serviceCharge)}</span></div>}
                {t.vatRate > 0 && <div className="row between muted"><span>VAT {t.vatRate}%{t.vatMode === 'inclusive' ? ' (รวมแล้ว)' : ''}</span><span className="num">{money(t.vat)}</span></div>}
                <div className="row between" style={{ fontSize: 40, fontWeight: 800, borderTop: '2px solid var(--border)', paddingTop: 8 }}><span>รวม</span><span className="num">฿{money(t.remaining ?? t.total)}</span></div>
              </div>
            )}
            {state.pointsEnabled && (
              state.member ? (
                <div className="card pad mt" style={{ borderColor: state.member.tierColor || 'var(--warning)', borderWidth: 2 }}>
                  <div style={{ fontSize: 22 }}>คุณ <b>{state.member.name}</b></div>
                  <div className="muted">{state.member.tier || 'Member'} Member · {int(state.member.points)} Points</div>
                  <div style={{ fontSize: 22, marginTop: 6 }}>รายการนี้จะได้รับ <b style={{ color: 'var(--success)' }}>+{state.earnPoints}</b> คะแนน</div>
                  {display.allowMemberInput !== false && <Button className="mt" size="lg" block icon="gift" onClick={() => setPanel({ type: 'rewards', member: state.member })}>ใช้ Reward</Button>}
                </div>
              ) : display.allowMemberInput !== false && (
                <Button className="mt" variant="primary" size="xl" icon="star" onClick={() => setPanel({ type: 'phone' })}>สะสมแต้ม {state.earnPoints ? `(+${state.earnPoints})` : ''}</Button>
              )
            )}
          </>
        )}
      </div>
      {panel && <MemberPanel panel={panel} setPanel={setPanel} earn={state.earnPoints} emit={emit} terms={settings?.member?.termsText} />}
    </div>
  );
}

function MemberPanel({ panel, setPanel, earn, emit, terms }) {
  const [phone, setPhone] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [reg, setReg] = useState({ name: '', gender: 'unspecified', birthday: '', accept: false });
  const [codes, setCodes] = useState(null);
  useEffect(() => {
    if (panel.type === 'rewards') api(`/display/member/${panel.member.id}/redemptions`).then(setCodes).catch(() => setCodes([]));
  }, [panel]);
  const lookup = async () => {
    setBusy(true); setErr('');
    try {
      const r = await api('/display/member-lookup', { method: 'POST', body: { phone } });
      setPanel(r.found ? { type: 'found', member: r.member } : { type: 'notfound' });
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };
  const register = async () => {
    setBusy(true); setErr('');
    try {
      const r = await api('/display/member-register', { method: 'POST', body: { phone, name: reg.name, gender: reg.gender, birthday: reg.birthday || null, acceptTerms: true } });
      setPanel({ type: 'found', member: r.member });
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };
  return (
    <Modal title={panel.type === 'rewards' ? 'Reward ของคุณ' : 'สะสมแต้ม'} size="narrow" onClose={() => setPanel(null)}>
      {panel.type === 'phone' && (
        <div className="col">
          <div className="center muted">กรอกเบอร์สมาชิก</div>
          <div className="input xl num" style={{ display: 'grid', placeItems: 'center', letterSpacing: 4 }}>{phone.replace(/(\d{3})(\d{3})(\d+)/, '$1 $2 $3') || '0__ ___ ____'}</div>
          <NumPad extra="" onKey={(k) => setPhone((v) => applyKey(v, k, { maxLen: 10, decimals: 0 }))} />
          {err && <div className="center" style={{ color: 'var(--danger)' }}>{err}</div>}
          <Button variant="primary" size="xl" loading={busy} disabled={phone.length < 9} onClick={lookup}>ยืนยัน</Button>
        </div>
      )}
      {panel.type === 'found' && (
        <div className="col center" style={{ alignItems: 'center' }}>
          <h2>สวัสดี คุณ {panel.member.name}</h2>
          <div style={{ fontSize: 20 }}>Tier : <b style={{ color: panel.member.tier?.color }}>{panel.member.tier?.name || 'Member'}</b></div>
          <div style={{ fontSize: 20 }}>แต้มปัจจุบัน : <b>{int(panel.member.points)}</b> คะแนน</div>
          <div className="card pad" style={{ fontSize: 20 }}>หลังจากชำระเงินรายการนี้<br />คุณจะได้รับ <b style={{ color: 'var(--success)' }}>+{earn || 0}</b> คะแนน</div>
          <Button variant="primary" size="xl" block onClick={() => { emit({ type: 'member_attach', memberId: panel.member.id }); setPanel(null); }}>ยืนยัน</Button>
          <Button variant="ghost" onClick={() => setPanel({ type: 'phone' })}>ไม่ใช่ฉัน</Button>
        </div>
      )}
      {panel.type === 'notfound' && (
        <div className="col">
          <div className="center bold" style={{ fontSize: 22 }}>ยังไม่พบสมาชิก</div>
          <div className="center muted">สมัครสมาชิกด้วยเบอร์ {phone}</div>
          <Input label="ชื่อ *" value={reg.name} onValue={(v) => setReg({ ...reg, name: v })} />
          <div className="grid-2">
            <Select label="เพศ" value={reg.gender} onValue={(v) => setReg({ ...reg, gender: v })} options={[{ value: 'unspecified', label: 'ไม่ระบุ' }, { value: 'male', label: 'ชาย' }, { value: 'female', label: 'หญิง' }, { value: 'other', label: 'อื่นๆ' }]} />
            <Input label="วันเกิด" type="date" value={reg.birthday} onValue={(v) => setReg({ ...reg, birthday: v })} />
          </div>
          <label className="check"><input type="checkbox" checked={reg.accept} onChange={(e) => setReg({ ...reg, accept: e.target.checked })} /><span className="small">{terms || 'ยอมรับเงื่อนไขการเป็นสมาชิก'}</span></label>
          {err && <div style={{ color: 'var(--danger)' }}>{err}</div>}
          <Button variant="primary" size="xl" loading={busy} disabled={!reg.name || !reg.accept} onClick={register}>สมัครสมาชิก</Button>
          <Button variant="ghost" onClick={() => setPanel({ type: 'phone' })}>กรอกเบอร์ใหม่</Button>
        </div>
      )}
      {panel.type === 'rewards' && (
        <div className="col">
          {codes === null ? <div className="center"><span className="spinner" /></div> : !codes.length ? <div className="empty">ยังไม่มี Reward ที่แลกไว้ — แลกได้ที่หน้าสมาชิก</div> : codes.map((c) => (
            <button key={c.id} type="button" className={cls('card pad')} style={{ textAlign: 'left', cursor: 'pointer' }} onClick={() => { emit({ type: 'reward_apply', code: c.code }); setPanel(null); }}>
              <b style={{ fontSize: 20 }}>{c.name}</b><div className="muted">รหัส {c.code} · แตะเพื่อใช้กับรายการนี้</div>
            </button>
          ))}
        </div>
      )}
    </Modal>
  );
}
