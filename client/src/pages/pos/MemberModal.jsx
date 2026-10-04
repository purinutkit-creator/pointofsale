// POS: สมาชิก / Membership — search by phone/ID/name/QR, register, redeem rewards, use points
import { useEffect, useRef, useState } from 'react';
import { api, uid } from '../../lib/api.js';
import { useApp, toast } from '../../lib/store.js';
import { usePos, fromServer } from './posStore.js';
import { Modal, Button, Input, NumPad, applyKey, Select, Badge, Icon, Empty, Spinner } from '../../components/ui.jsx';
import { money, int } from '../../lib/util.js';

export function CameraScanner({ onCode, onClose }) {
  const video = useRef(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    let stream; let stop = false;
    (async () => {
      if (!('BarcodeDetector' in window)) { setErr('อุปกรณ์นี้ไม่รองรับการสแกนด้วยกล้อง ใช้เครื่องสแกนบาร์โค้ดหรือพิมพ์รหัสแทน'); return; }
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
        video.current.srcObject = stream; await video.current.play();
        const det = new window.BarcodeDetector({ formats: ['qr_code', 'code_128', 'ean_13', 'ean_8', 'code_39', 'upc_a'] });
        const tick = async () => {
          if (stop) return;
          try { const r = await det.detect(video.current); if (r[0]?.rawValue) { onCode(r[0].rawValue); return; } } catch { /* frame not ready */ }
          requestAnimationFrame(tick);
        };
        tick();
      } catch (e) { setErr(`เปิดกล้องไม่ได้: ${e.message}`); }
    })();
    return () => { stop = true; stream?.getTracks().forEach((t) => t.stop()); };
  }, [onCode]);
  return (
    <Modal title="สแกน Barcode / QR" size="narrow" onClose={onClose}>
      {err ? <div className="empty">{err}</div> : <video ref={video} playsInline muted style={{ width: '100%', borderRadius: 12, background: '#000' }} />}
    </Modal>
  );
}

export default function MemberModal({ onClose }) {
  const order = usePos((s) => s.order);
  const { settings, can } = useApp();
  const [q, setQ] = useState('');
  const [list, setList] = useState(null);
  const [summary, setSummary] = useState(null);
  const [reg, setReg] = useState(null);
  const [busy, setBusy] = useState(false);
  const [scan, setScan] = useState(false);
  const totals = usePos.getState().totals();

  const loadSummary = async (id) => { setBusy(true); try { setSummary(await api(`/members/${id}/pos-summary`)); } catch (e) { toast(e.message, 'error'); } finally { setBusy(false); } };
  useEffect(() => { if (order?.memberId) loadSummary(order.memberId); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const search = async (term = q) => {
    if (!term.trim()) return;
    setBusy(true);
    try {
      const r = await api(`/members?q=${encodeURIComponent(term.trim())}`);
      setList(r);
      if (r.length === 1) loadSummary(r[0].id);
      if (!r.length && /^0\d{8,9}$/.test(term.replace(/\D/g, ''))) setReg({ phone: term.replace(/\D/g, ''), name: '', gender: 'unspecified', birthday: '' });
    } catch (e) { toast(e.message, 'error'); } finally { setBusy(false); }
  };
  const attach = async (memberId) => {
    setBusy(true);
    try {
      await usePos.getState().flushSave();
      const o = await api(`/orders/${order.id}/member`, { method: 'POST', body: { memberId } });
      usePos.setState({ order: fromServer(o) });
      toast(memberId ? `เลือกสมาชิก ${o.member?.name}` : 'นำสมาชิกออกจากบิล', 'success');
      if (!memberId) onClose();
    } catch (e) { toast(e.message, 'error'); } finally { setBusy(false); }
  };
  const register = async () => {
    setBusy(true);
    try {
      const m = await api('/members', { method: 'POST', body: { ...reg, birthday: reg.birthday || null, acceptTerms: true } });
      toast(`สมัครสมาชิก ${m.name} สำเร็จ (${m.memberCode})`, 'success');
      setReg(null); await attach(m.id); await loadSummary(m.id);
    } catch (e) { toast(e.message, 'error'); } finally { setBusy(false); }
  };
  const redeem = async (reward) => {
    setBusy(true);
    try {
      const red = await api(`/members/${summary.member.id}/redeem`, { method: 'POST', body: { rewardId: reward.id, txnId: uid() } });
      await usePos.getState().flushSave();
      const r = await api(`/orders/${order.id}/redemptions`, { method: 'POST', body: { code: red.code } });
      usePos.setState({ order: fromServer(r.order) });
      toast(`ใช้ ${reward.points_required} แต้ม แลก ${reward.name}`, 'success');
      loadSummary(summary.member.id);
    } catch (e) { toast(e.message, 'error'); } finally { setBusy(false); }
  };
  const useCode = async (code) => {
    setBusy(true);
    try {
      await usePos.getState().flushSave();
      const r = await api(`/orders/${order.id}/redemptions`, { method: 'POST', body: { code } });
      usePos.setState({ order: fromServer(r.order) });
      toast(`ใช้สิทธิ์ ${r.redemption.reward_name}`, 'success');
      loadSummary(summary.member.id);
    } catch (e) { toast(e.message, 'error'); } finally { setBusy(false); }
  };

  const m = summary?.member;
  const attached = m && order?.memberId === m.id;
  const pv = Number(settings?.points?.pointValue) || 0;

  return (
    <Modal title="สมาชิก / Membership" size="wide" icon="crown" onClose={onClose}>
      <div className="grid-2" style={{ alignItems: 'start' }}>
        <div className="col">
          <div className="row">
            <input className="input lg grow" placeholder="เบอร์โทร / Member ID / ชื่อ" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && search()} autoFocus />
            <Button size="lg" icon="scan" onClick={() => setScan(true)} />
          </div>
          <NumPad extra="" onKey={(k) => setQ((v) => applyKey(v, k, { maxLen: 15, decimals: 0 }))} />
          <Button variant="primary" size="lg" loading={busy} onClick={() => search()} disabled={!can('member.search')}>ค้นหาสมาชิก</Button>
          {list && list.length > 1 && (
            <div className="col gap-s">{list.map((x) => <button key={x.id} type="button" className="pay-line" style={{ cursor: 'pointer', background: 'var(--surface)' }} onClick={() => loadSummary(x.id)}><b className="grow" style={{ textAlign: 'left' }}>{x.name}</b><span className="muted">{x.phone}</span><Badge>{x.tier_name}</Badge></button>)}</div>
          )}
          {list && !list.length && !reg && <div className="card pad center">ยังไม่พบสมาชิก {can('member.create') && <Button className="mt" block onClick={() => setReg({ phone: q.replace(/\D/g, ''), name: '', gender: 'unspecified', birthday: '' })}>สมัครสมาชิก</Button>}</div>}
          {reg && (
            <div className="card pad col">
              <b>สมัครสมาชิกใหม่</b>
              <Input label="เบอร์โทร *" inputMode="tel" value={reg.phone} onValue={(v) => setReg({ ...reg, phone: v })} />
              <Input label="ชื่อ *" value={reg.name} onValue={(v) => setReg({ ...reg, name: v })} />
              <div className="grid-2">
                <Select label="เพศ" value={reg.gender} onValue={(v) => setReg({ ...reg, gender: v })} options={[{ value: 'unspecified', label: 'ไม่ระบุ' }, { value: 'male', label: 'ชาย' }, { value: 'female', label: 'หญิง' }, { value: 'other', label: 'อื่นๆ' }]} />
                <Input label="วันเกิด" type="date" value={reg.birthday} onValue={(v) => setReg({ ...reg, birthday: v })} />
              </div>
              <div className="xs muted">{settings?.member?.termsText}</div>
              <div className="row"><Button onClick={() => setReg(null)}>ยกเลิก</Button><Button variant="primary" className="grow" loading={busy} disabled={!reg.name || !reg.phone || !can('member.create')} onClick={register}>ลูกค้ายอมรับเงื่อนไข · สมัคร</Button></div>
            </div>
          )}
        </div>
        <div className="col">
          {busy && !m && <div className="center"><Spinner /></div>}
          {!m && !busy && <Empty icon="user">ค้นหาสมาชิกเพื่อสะสมแต้ม / ใช้สิทธิ์</Empty>}
          {m && (
            <>
              <div className="card pad" style={{ borderColor: m.tier?.color || 'var(--border)', borderWidth: 2 }}>
                <div className="row between"><div><div className="xs muted">สมาชิก</div><h3>{m.name}</h3><div className="small muted">{m.phone} · ID {m.memberCode}</div></div><Badge style={{ background: m.tier?.color, color: '#fff' }}>{m.tier?.name || 'Member'}</Badge></div>
                <div className="grid-2 mt">
                  <div><div className="xs muted">แต้มปัจจุบัน</div><div className="bold" style={{ fontSize: 26 }}>{int(m.points)}</div></div>
                  <div><div className="xs muted">แต้มที่จะได้รับ</div><div className="bold" style={{ fontSize: 26, color: 'var(--success)' }}>+{attached ? totals?.earnPoints || 0 : '…'}</div></div>
                </div>
                {m.nextTier && <div className="xs muted mt">อีก {int(m.nextTier.need)} คะแนนเพื่อเป็น {m.nextTier.name}</div>}
                {m.tier?.discountPct > 0 && <div className="xs" style={{ color: 'var(--success)' }}>สิทธิ์ Tier: ส่วนลด {m.tier.discountPct}%</div>}
                <div className="row mt">
                  {attached ? <Button variant="ghost" icon="x" onClick={() => attach(null)}>เปลี่ยน/นำออก</Button> : <Button variant="primary" className="grow" size="lg" loading={busy} onClick={() => attach(m.id)}>ใช้สมาชิกนี้กับบิล</Button>}
                </div>
              </div>
              {attached && pv > 0 && can('member.use_points') && (
                <div className="card pad col">
                  <b>ใช้คะแนนเป็นส่วนลด (1 แต้ม = ฿{money(pv)})</b>
                  <div className="row">
                    <input className="input" type="number" min={0} max={m.points} value={order.pointsToUse || ''} placeholder="จำนวนแต้ม" onChange={(e) => usePos.getState().update({ pointsToUse: Math.max(0, Math.min(m.points, Number(e.target.value) || 0)) })} />
                    <Button onClick={() => usePos.getState().update({ pointsToUse: Math.min(m.points, Math.floor((totals?.total || 0) / pv)) })}>สูงสุด</Button>
                  </div>
                </div>
              )}
              {attached && m.activeRedemptions.length > 0 && (
                <div className="card pad col">
                  <b>สิทธิ์ที่แลกไว้แล้ว</b>
                  {m.activeRedemptions.map((r) => <div key={r.id} className="row"><span className="grow">{r.name} <span className="xs muted">#{r.code}</span></span><Button size="sm" variant="soft" loading={busy} onClick={() => useCode(r.code)}>ใช้สิทธิ์</Button></div>)}
                </div>
              )}
              {attached && (
                <div className="card pad col">
                  <b>Reward ที่แลกได้ ({summary.rewards.filter((r) => !r.blocker).length})</b>
                  {summary.rewards.map((r) => (
                    <div key={r.id} className="row">
                      <div className="grow"><div className="bold">{r.name}</div><div className="xs muted">{r.points_required} แต้ม{r.blocker ? ` · ${r.blocker}` : ''}</div></div>
                      <Button size="sm" variant="primary" disabled={!!r.blocker || busy || !can('member.use_points')} onClick={() => redeem(r)}>ใช้แต้ม / Redeem</Button>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      </div>
      {scan && <CameraScanner onClose={() => setScan(false)} onCode={(c) => { setScan(false); setQ(c); search(c); }} />}
    </Modal>
  );
}

export function RewardCodeModal({ onClose }) {
  const order = usePos((s) => s.order);
  const [code, setCode] = useState('');
  const [info, setInfo] = useState(null);
  const [busy, setBusy] = useState(false);
  const [scan, setScan] = useState(false);
  const [err, setErr] = useState('');
  const verify = async (c = code) => {
    setBusy(true); setErr(''); setInfo(null);
    try { setInfo(await api(`/redemptions/verify/${encodeURIComponent(c.replace(/\D/g, ''))}`)); } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };
  const apply = async () => {
    setBusy(true);
    try {
      await usePos.getState().flushSave();
      const r = await api(`/orders/${order.id}/redemptions`, { method: 'POST', body: { code: info.code } });
      usePos.setState({ order: fromServer(r.order) });
      toast(`ใช้สิทธิ์ ${info.reward_name} แล้ว`, 'success');
      onClose();
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };
  return (
    <Modal title="ใช้สิทธิ์ / Reward" icon="gift" size="narrow" onClose={onClose}>
      <div className="col">
        <div className="row">
          <input className="input xl grow" inputMode="numeric" placeholder="Redemption Code" value={code} onChange={(e) => setCode(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && verify()} autoFocus />
          <Button size="lg" icon="scan" onClick={() => setScan(true)} />
        </div>
        {!info && <NumPad extra="" onKey={(k) => setCode((v) => applyKey(v, k, { maxLen: 12, decimals: 0 }))} />}
        {!info && <Button variant="primary" size="lg" loading={busy} disabled={code.length < 4} onClick={() => verify()}>ตรวจสอบรหัส</Button>}
        {err && <div className="card pad" style={{ background: 'var(--danger-50)', color: 'var(--danger)', borderColor: 'transparent', fontWeight: 600 }}><Icon name="alert" /> {err}</div>}
        {info && (
          <div className="card pad col" style={{ borderColor: 'var(--success)', borderWidth: 2 }}>
            <Badge tone="success">Reward Valid</Badge>
            <div className="muted">คุณ {info.member_name} ({info.member_phone})</div>
            <h3>{info.reward_name}</h3>
            {info.min_spend > 0 && <div className="small muted">ยอดขั้นต่ำ ฿{money(info.min_spend)}</div>}
            <div className="small muted">หมดอายุ {info.expires_at}</div>
            <div className="row"><Button onClick={() => { setInfo(null); setCode(''); }}>ยกเลิก</Button><Button variant="success" size="lg" className="grow" loading={busy} onClick={apply}>ใช้สิทธิ์</Button></div>
          </div>
        )}
      </div>
      {scan && <CameraScanner onClose={() => setScan(false)} onCode={(c) => { setScan(false); setCode(c); verify(c); }} />}
    </Modal>
  );
}
