import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import './pos.css';
import { api, auth } from '../../lib/api.js';
import { connectSocket, on } from '../../lib/socket.js';
import { startSync, onSynced } from '../../lib/sync.js';
import { useApp, toast } from '../../lib/store.js';
import { usePos, fromServer } from './posStore.js';
import { sendKitchen, holdOrder } from './actions.js';
import { printAgent } from '../../hw/printing.js';
import { Button, Icon, Loading, useDialog, Modal } from '../../components/ui.jsx';
import LockScreen from '../../components/LockScreen.jsx';
import { ConnectivityBadge, NotificationBell } from '../../components/StatusBar.jsx';
import CatalogPane from './CatalogPane.jsx';
import CartPane from './CartPane.jsx';
import StartOrder from './StartOrder.jsx';
import ProductOptions from './ProductOptions.jsx';
import PaymentModal from './PaymentModal.jsx';
import MemberModal, { RewardCodeModal } from './MemberModal.jsx';
import { DiscountModal, ItemModal } from './DiscountModal.jsx';
import SplitModal from './SplitModal.jsx';
import OrdersModal from './OrdersModal.jsx';
import ShiftModal, { OpenShift } from './ShiftModal.jsx';
import PrinterPanel, { PrintErrorWatcher } from './PrinterPanel.jsx';
import { pushDisplay, cartForDisplay, onLocalDisplayEvent } from './display.js';
import { playBeep, playChime } from '../../lib/sound.js';
import { cls, money } from '../../lib/util.js';

const VOID_REASONS = ['ลูกค้ายกเลิก', 'สั่งผิด', 'ทำอาหารผิด', 'ของหมด', 'รอนานเกินไป'];

export default function POS() {
  const nav = useNavigate();
  const dialog = useDialog();
  const { staff, settings, device, can } = useApp();
  const { order, catalog, shift, shiftRequired } = usePos();
  const [ready, setReady] = useState(false);
  const [modal, setModal] = useState(null);
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState('catalog');
  const [menu, setMenu] = useState(false);
  const [optionsFor, setOptionsFor] = useState(null);

  // ── boot ──
  useEffect(() => {
    (async () => {
      if (!auth.deviceToken) return nav('/device', { replace: true });
      if (!auth.session) return nav('/login', { replace: true });
      const d = useApp.getState().device || (await useApp.getState().loadDevice());
      if (d && (d.device?.type || d.type) !== 'pos') return nav('/', { replace: true });
      const me = await useApp.getState().loadMe();
      if (!me) return nav('/login', { replace: true });
      if (!useApp.getState().can('pos.access')) { toast('ไม่มีสิทธิ์เข้า POS', 'error'); return nav('/admin', { replace: true }); }
      connectSocket();
      startSync();
      const c = await usePos.getState().loadCatalog();
      await usePos.getState().loadShift();
      printAgent.configure(useApp.getState().device?.id, c?.printers || []);
      printAgent.start();
      setReady(true);
    })();
  }, [nav]);

  // ── realtime ──
  useEffect(() => {
    if (!ready) return undefined;
    const offs = [
      on('catalog:changed', async () => { const c = await usePos.getState().loadCatalog(); printAgent.configure(useApp.getState().device?.id, c?.printers || []); }),
      on('printers:changed', async () => { const c = await usePos.getState().loadCatalog(); printAgent.configure(useApp.getState().device?.id, c?.printers || []); }),
      on('settings:changed', () => useApp.getState().loadMe()),
      on('shift:changed', () => usePos.getState().loadShift()),
      on('order:updated', async (e) => {
        const o = usePos.getState().order;
        if (!o || e.id !== o.id || o.dirty) return;
        if (e.version && e.version === o.version) return;
        try { const s = await api(`/orders/${o.id}`); if (!usePos.getState().order?.dirty) usePos.setState({ order: fromServer(s) }); } catch { /* ignore */ }
      }),
      on('queue:ready', () => playChime()),
      on('display:event', (e) => handleDisplayEvent(e)),
      onLocalDisplayEvent((e) => handleDisplayEvent(e)),
      onSynced((entry, res) => { if (entry.path.endsWith('/pay')) toast(`Sync สำเร็จ: ${res.receiptNo || ''}`, 'success'); }),
    ];
    return () => offs.forEach((f) => f());
  }, [ready]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleDisplayEvent = async (e) => {
    const o = usePos.getState().order;
    if (!o) return;
    try {
      if (e.type === 'member_attach' && e.memberId) {
        await usePos.getState().flushSave();
        const r = await api(`/orders/${o.id}/member`, { method: 'POST', body: { memberId: e.memberId, via: 'display' } });
        usePos.setState({ order: fromServer(r) });
        toast(`ลูกค้าเลือกสมาชิก: ${r.member?.name}`, 'success'); playBeep();
      } else if (e.type === 'reward_apply' && e.code) {
        await usePos.getState().flushSave();
        const r = await api(`/orders/${o.id}/redemptions`, { method: 'POST', body: { code: e.code } });
        usePos.setState({ order: fromServer(r.order) });
        toast(`ลูกค้าใช้สิทธิ์: ${r.redemption.reward_name}`, 'success'); playBeep();
      }
    } catch (err) { toast(err.message, 'error'); }
  };

  // ── totals + customer display ──
  const totals = useMemo(() => (order && settings ? usePos.getState().totals() : null), [order, settings, catalog]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (modal?.type === 'pay') return;
    pushDisplay(order ? cartForDisplay(order, totals, settings) : { stage: 'idle' }, true);
  }, [order, totals, modal, settings]);

  // ── barcode scanner (keyboard wedge) ──
  const scanBuf = useRef({ s: '', t: 0 });
  const onScan = useCallback(async (code) => {
    const p = usePos.getState().catalog.products.find((x) => x.barcode === code || x.sku === code || x.variants.some((v) => v.barcode === code || v.sku === code));
    if (p) { if (!usePos.getState().order) return toast('กรุณาเปิดบิลก่อน', 'warning'); pick(p, p.variants.find((v) => v.barcode === code || v.sku === code)); playBeep(); return; }
    const o = usePos.getState().order;
    if (!o) return;
    if (/^\d{6,10}$/.test(code)) {
      // member card (8 digits) or redemption code
      try {
        const m = await api(`/members?q=${code}`);
        if (m.length === 1 && m[0].member_code === code) { await usePos.getState().flushSave(); usePos.setState({ order: fromServer(await api(`/orders/${o.id}/member`, { method: 'POST', body: { memberId: m[0].id, via: 'scan' } })) }); toast(`สมาชิก ${m[0].name}`, 'success'); playBeep(); return; }
      } catch { /* not a member */ }
      setModal({ type: 'reward' });
      return;
    }
    toast(`ไม่พบสินค้า: ${code}`, 'error');
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const h = (e) => {
      const tag = document.activeElement?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || document.querySelector('.modal-bg')) return;
      const now = Date.now();
      const b = scanBuf.current;
      if (now - b.t > 60) b.s = '';
      b.t = now;
      if (e.key === 'Enter') { if (b.s.length >= 4) onScan(b.s); b.s = ''; return; }
      if (e.key.length === 1) b.s += e.key;
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onScan]);

  const pick = (p, variant = null) => {
    if (!usePos.getState().order) return;
    if (!can('pos.add_item')) return toast('ไม่มีสิทธิ์เพิ่มสินค้า', 'error');
    if (!variant && (p.variants.length > 0 || p.modifierGroupIds.length > 0)) { setOptionsFor({ product: p }); return; }
    usePos.getState().addItem(p, { variant });
  };

  const voidItem = async (item) => {
    setModal(null);
    if (item.status === 'draft') { usePos.getState().removeDraft(item.id); return; }
    const reason = await dialog.prompt({ title: `Void: ${item.name}`, message: 'รายการนี้ส่งครัวแล้ว ต้องระบุเหตุผล (จะพิมพ์ใบยกเลิกไปที่ครัว)', options: VOID_REASONS, required: true });
    if (!reason) return;
    let qty = item.qty;
    if (item.qty > 1) { const q = await dialog.prompt({ title: 'จำนวนที่ต้องการ Void', type: 'number', value: String(item.qty), required: true }); if (!q) return; qty = Math.min(item.qty, Math.max(1, Number(q))); }
    try {
      await usePos.getState().flushSave();
      usePos.setState({ order: fromServer(await api(`/orders/${usePos.getState().order.id}/items/${item.id}/void`, { method: 'POST', body: { qty, reason } })) });
      toast('Void รายการแล้ว', 'success');
    } catch (e) { if (e.code !== 'APPROVAL_CANCELLED') toast(e.message, 'error'); }
  };

  const onAction = async (a) => {
    const o = usePos.getState().order;
    try {
      if (a === 'hold') { setBusy(true); await holdOrder(); }
      else if (a === 'send') { setBusy(true); await sendKitchen(); }
      else if (a === 'pay') {
        if (shiftRequired && !shift && useApp.getState().online) { setModal({ type: 'openShift' }); return; }
        setBusy(true); await usePos.getState().flushSave();
        if (!usePos.getState().order?.items.some((i) => i.status !== 'voided')) return;
        setModal({ type: 'pay' });
      }
      else if (a === 'note') {
        const n = await dialog.prompt({ title: 'หมายเหตุบิล', value: o.note || '', multiline: true });
        if (n !== null) usePos.getState().update({ note: n });
      }
      else if (a === 'prebill') { await usePos.getState().flushSave(); await api(`/orders/${o.id}/print-bill`, { method: 'POST', body: {} }); toast('ส่งพิมพ์ใบแจ้งยอดแล้ว', 'success'); }
      else if (a === 'type') { usePos.getState().update(o.type === 'dine_in' ? { type: 'takeaway', tableId: null, tableNumber: null } : { type: 'dine_in' }); await usePos.getState().flushSave(); }
      else if (a === 'scExempt') { usePos.getState().update({ scExempt: !o.scExempt }); await usePos.getState().flushSave(); }
      else if (a === 'voidOrder') {
        if (!o.saved && !o.items.some((i) => i.status === 'sent')) { usePos.getState().closeOrder(); return; }
        const reason = await dialog.prompt({ title: 'Void ทั้งบิล', message: 'ระบุเหตุผล', options: VOID_REASONS, required: true });
        if (!reason) return;
        await usePos.getState().flushSave();
        await api(`/orders/${o.id}/void`, { method: 'POST', body: { reason } });
        toast('Void บิลแล้ว', 'success');
        usePos.getState().closeOrder();
      }
      else setModal({ type: a });
    } catch (e) { if (e.code !== 'APPROVAL_CANCELLED') toast(e.message, 'error'); } finally { setBusy(false); }
  };

  if (!ready || !staff) return <Loading />;
  const shop = settings?.shop;
  const needShift = shiftRequired && !shift && useApp.getState().online;

  return (
    <div className="pos">
      <div className="pos-top">
        <div className="brand">{shop?.logoUrl ? <img src={shop.logoUrl} alt="" /> : <Icon name="store" />}<span className="hide-mobile">{shop?.name}</span></div>
        <span className="badge hide-mobile">{device?.name}</span>
        <div className="grow" />
        {order && <Button size="sm" icon="plus" variant="soft" onClick={async () => { await usePos.getState().flushSave(); usePos.getState().closeOrder(); }}>บิลใหม่</Button>}
        <Button size="sm" icon="table" onClick={async () => { await usePos.getState().flushSave(); usePos.getState().closeOrder(); }} className="hide-mobile">โต๊ะ</Button>
        <Button size="sm" icon="receipt" onClick={() => setModal({ type: 'orders' })}>บิล</Button>
        <Button size="sm" icon="pause" onClick={() => setModal({ type: 'orders', tab: 'held' })} className="hide-mobile">พักบิล</Button>
        <ConnectivityBadge />
        <NotificationBell />
        <Button size="sm" variant="ghost" onClick={() => setMenu(true)}><Icon name="user" /><span className="hide-mobile">{staff.displayName}</span><Icon name="menu" /></Button>
      </div>

      {!order ? <StartOrder /> : (
        <div className="pos-body" data-tab={tab}>
          <CatalogPane onPick={(p) => { pick(p); if (window.innerWidth <= 860) playBeep(); }} />
          <CartPane totals={totals} busy={busy} onAction={onAction} onEditItem={(i) => setModal({ type: 'item', item: i })} onVoidItem={voidItem} />
        </div>
      )}
      {order && (
        <div className="mobile-tabs">
          <Button variant={tab === 'catalog' ? 'primary' : undefined} onClick={() => setTab('catalog')}>สินค้า</Button>
          <Button variant={tab === 'cart' ? 'primary' : undefined} onClick={() => setTab('cart')}>ตะกร้า ({order.items.filter((i) => i.status !== 'voided').reduce((a, i) => a + i.qty, 0)}) ฿{money(totals?.total || 0)}</Button>
        </div>
      )}

      {menu && (
        <Modal title={`${staff.displayName} (${staff.code}) · ${staff.role?.name}`} size="narrow" onClose={() => setMenu(false)}>
          <div className="col">
            <Button size="lg" icon="clock" onClick={() => { setMenu(false); setModal({ type: 'shift' }); }}>กะการขาย / Cash In-Out / ลิ้นชัก</Button>
            <Button size="lg" icon="print" onClick={() => { setMenu(false); setModal({ type: 'printers' }); }}>เครื่องพิมพ์ / ฮาร์ดแวร์</Button>
            <Button size="lg" icon="monitor" onClick={() => { setMenu(false); window.open('/display?local=1', 'customer-display', 'popup,width=1024,height=768'); }}>เปิดจอลูกค้า (หน้าต่างที่ 2)</Button>
            <Button size="lg" icon="list" onClick={() => { setMenu(false); window.open('/queue', '_blank'); }}>เปิดจอเรียกคิว</Button>
            <Button size="lg" icon="lock" onClick={() => { setMenu(false); useApp.setState({ locked: true }); }}>ล็อกหน้าจอ</Button>
            <Button size="lg" icon="users" onClick={async () => { await usePos.getState().flushSave(); await useApp.getState().logout(); nav('/login'); }}>สลับพนักงาน (Switch Staff)</Button>
            <Button size="lg" icon="settings" onClick={() => nav('/admin')}>หลังร้าน (Back Office)</Button>
            <Button size="lg" variant="ghost" icon="logout" onClick={async () => { await usePos.getState().flushSave(); await useApp.getState().logout(); nav('/login'); }}>ออกจากระบบ</Button>
          </div>
        </Modal>
      )}

      {optionsFor && (
        <ProductOptions product={optionsFor.product} groups={catalog.modifierGroups} initial={optionsFor.item} onClose={() => setOptionsFor(null)}
          onConfirm={({ variant, modifiers, note, qty }) => {
            if (optionsFor.item) usePos.getState().setItem(optionsFor.item.id, { variantId: variant?.id ?? null, variantName: variant?.name ?? null, variantPrice: variant?.priceDelta || 0, modifiers: modifiers.map((m) => ({ modifierId: m.id, groupId: m.groupId, name: m.name, price: m.price, qty: m.qty })), note: note || null, qty });
            else usePos.getState().addItem(optionsFor.product, { variant, modifiers, note, qty });
            setOptionsFor(null);
          }} />
      )}
      {modal?.type === 'item' && <ItemModal item={modal.item} onClose={() => setModal(null)} onVoid={() => voidItem(modal.item)}
        onEditOptions={() => { const p = usePos.getState().productById(modal.item.productId); setModal(null); setOptionsFor({ product: p, item: modal.item }); }} />}
      {modal?.type === 'pay' && <PaymentModal partialAmount={modal.partial ?? null} onClose={() => setModal(null)} onDone={(r) => {
        setModal(null);
        if (r?.partial) { usePos.getState().openOrder(usePos.getState().order.id); return; }
        usePos.getState().closeOrder(); usePos.getState().loadCatalog();
        setTimeout(() => pushDisplay({ stage: 'idle' }, true), 8000);
      }} />}
      {modal?.type === 'member' && <MemberModal onClose={() => setModal(null)} />}
      {modal?.type === 'reward' && <RewardCodeModal onClose={() => setModal(null)} />}
      {modal?.type === 'discount' && <DiscountModal onClose={() => setModal(null)} />}
      {modal?.type === 'split' && <SplitModal onClose={() => setModal(null)} onPayPart={(amt) => setModal({ type: 'pay', partial: amt })} />}
      {modal?.type === 'orders' && <OrdersModal initialTab={modal.tab} onClose={() => setModal(null)} />}
      {modal?.type === 'shift' && <ShiftModal onClose={() => setModal(null)} />}
      {modal?.type === 'printers' && <PrinterPanel onClose={() => setModal(null)} />}
      {(modal?.type === 'openShift' || (needShift && !modal)) && (can('shift.open_close')
        ? <OpenShift forced={needShift} onDone={() => setModal(null)} />
        : <Modal title="ยังไม่ได้เปิดกะ" size="narrow"><div className="col"><div>ต้องเปิดกะก่อนขาย กรุณาให้ผู้มีสิทธิ์เปิดกะ</div><Button onClick={async () => { await useApp.getState().logout(); nav('/login'); }}>สลับพนักงาน</Button></div></Modal>)}
      <PrintErrorWatcher />
      <LockScreen />
    </div>
  );
}
