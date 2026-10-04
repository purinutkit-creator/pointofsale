import { usePos } from './posStore.js';
import { useApp } from '../../lib/store.js';
import { Button, Icon, Badge } from '../../components/ui.jsx';
import { money, cls, ORDER_TYPE_LABEL, KDS_LABEL } from '../../lib/util.js';

export default function CartPane({ totals, onEditItem, onVoidItem, onAction, busy }) {
  const order = usePos((s) => s.order);
  const can = useApp((s) => s.can);
  if (!order) return null;
  const items = order.items.filter((i) => i.status !== 'voided');
  const lineOf = (id) => totals?.lines.find((l) => l.key === id);
  const drafts = items.filter((i) => i.status === 'draft').length;
  const settings = useApp.getState().settings;
  return (
    <div className="pos-cart">
      <div className="cart-head">
        <div className="row between">
          <div className="row gap-s">
            <Badge tone={order.type === 'dine_in' ? 'info' : 'primary'}>{ORDER_TYPE_LABEL[order.type]}</Badge>
            {order.tableNumber && <b>โต๊ะ {order.tableNumber}</b>}
            {order.queueNo && <b className="num">คิว {order.queueNo}</b>}
            {order.guests ? <span className="muted small">· {order.guests} ท่าน</span> : null}
          </div>
          <div className="row gap-s">
            {order.offline && <Badge tone="danger">Offline</Badge>}
            {order.status === 'held' && <Badge tone="warning">พักบิล</Badge>}
            <span className="xs muted">{order.orderNo ? `#${order.orderNo}` : ''}</span>
          </div>
        </div>
        {order.customerName && <div className="small muted">ลูกค้า: {order.customerName} {order.customerPhone}</div>}
        <button type="button" className={cls('member-chip', order.member && 'on')} onClick={() => onAction('member')}>
          <Icon name={order.member ? 'crown' : 'user'} size={18} />
          {order.member ? (
            <span className="grow ellipsis"><b>{order.member.name}</b> · {order.member.tierName || 'Member'} · {Number(order.member.points).toLocaleString()} pts <span style={{ color: 'var(--success)' }}>+{totals?.earnPoints || 0}</span></span>
          ) : <span className="grow">สมาชิก / Membership</span>}
          <Icon name="chevron" size={16} />
        </button>
      </div>

      <div className="cart-items">
        {!items.length && <div className="empty"><Icon name="receipt" size={32} /><div className="mt">แตะสินค้าเพื่อเพิ่มลงบิล</div></div>}
        {items.map((i) => {
          const l = lineOf(i.id);
          const sent = i.status === 'sent';
          return (
            <div key={i.id} className={cls('cart-item', sent && 'sent')}>
              <div className="ci-main" onClick={() => onEditItem(i)}>
                <div className="row between" style={{ alignItems: 'flex-start' }}>
                  <div className="grow">
                    <div className="ci-name">{i.name}{i.variantName ? ` (${i.variantName})` : ''}</div>
                    {i.modifiers.length > 0 && <div className="ci-mods">{i.modifiers.map((m) => `${m.name}${m.qty > 1 ? ` x${m.qty}` : ''}${m.price ? ` +${money(m.price)}` : ''}`).join(', ')}</div>}
                    {i.note && <div className="ci-note">» {i.note}</div>}
                    {(l?.discountDetail || []).map((d, k) => <div key={k} className="ci-disc">{d.label} -{money(d.amount)}</div>)}
                    {i.rewardRedemptionId && <div className="ci-disc">Reward Redemption</div>}
                  </div>
                  <div className="right">
                    <div className="bold num">{money(l ? l.gross - l.itemDiscount : i.unitPrice * i.qty)}</div>
                    <div className="xs muted num">{money(i.unitPrice)} × {i.qty}</div>
                  </div>
                </div>
                {sent && <div className="xs" style={{ color: 'var(--accent)' }}><Icon name="chef" size={12} /> ส่งครัวแล้ว · {KDS_LABEL[i.kitchenStatus] || ''}</div>}
              </div>
              <div className="ci-actions">
                {!sent && !i.rewardRedemptionId ? (
                  <>
                    <Button size="sm" icon="minus" onClick={() => (i.qty > 1 ? usePos.getState().setItem(i.id, { qty: i.qty - 1 }) : usePos.getState().removeDraft(i.id))} disabled={!can('pos.edit_qty') && i.qty > 1} />
                    <span className="bold num" style={{ minWidth: 28, textAlign: 'center' }}>{i.qty}</span>
                    <Button size="sm" icon="plus" onClick={() => usePos.getState().setItem(i.id, { qty: i.qty + 1 })} disabled={!can('pos.edit_qty')} />
                    <Button size="sm" variant="ghost" icon="edit" onClick={() => onEditItem(i)} />
                    <Button size="sm" variant="ghost" icon="trash" onClick={() => onVoidItem(i)} disabled={!can('pos.remove_item')} />
                  </>
                ) : (
                  <>
                    <span className="xs muted grow">×{i.qty}</span>
                    <Button size="sm" variant="ghost" icon="trash" onClick={() => onVoidItem(i)}>Void</Button>
                  </>
                )}
              </div>
            </div>
          );
        })}
      </div>

      <div className="cart-sum">
        {totals && (
          <>
            <div className="row between"><span>Subtotal</span><span className="num">{money(totals.subtotal)}</span></div>
            {totals.discount > 0 && <div className="row between" style={{ color: 'var(--danger)' }}><span>Discount{totals.promotions.length ? ` (${totals.promotions.map((p) => p.name).join(', ')})` : ''}</span><span className="num">-{money(totals.discount)}</span></div>}
            {totals.serviceCharge > 0 && <div className="row between"><span>Service Charge {totals.serviceChargeRate}%</span><span className="num">{money(totals.serviceCharge)}</span></div>}
            {totals.vatRate > 0 && <div className="row between muted small"><span>VAT {totals.vatRate}% {totals.vatMode === 'inclusive' ? '(รวมในราคา)' : ''}</span><span className="num">{money(totals.vat)}</span></div>}
            {order.paidTotal > 0 && <div className="row between" style={{ color: 'var(--success)' }}><span>ชำระแล้ว</span><span className="num">-{money(order.paidTotal)}</span></div>}
            <div className="row between total"><span>Grand Total</span><span className="num">฿{money(order.paidTotal > 0 ? totals.remaining : totals.total)}</span></div>
          </>
        )}
        <div className="cart-actions">
          <Button size="lg" icon="pause" onClick={() => onAction('hold')} disabled={!items.length || busy || !can('pos.hold_bill')}>พักบิล</Button>
          <Button size="lg" variant="accent" icon="chef" onClick={() => onAction('send')} disabled={!drafts || busy || !can('pos.send_kitchen')}>ส่งครัว{drafts ? ` (${drafts})` : ''}</Button>
          <Button size="lg" variant="success" icon="cash" onClick={() => onAction('pay')} disabled={!items.length || busy} style={{ gridColumn: 'span 2', minHeight: 60, fontSize: 21 }}>
            ชำระเงิน ฿{money(totals ? (order.paidTotal > 0 ? totals.remaining : totals.total) : 0)}
          </Button>
        </div>
        <div className="cart-more">
          <Button size="sm" icon="percent" onClick={() => onAction('discount')}>ส่วนลด</Button>
          <Button size="sm" icon="gift" onClick={() => onAction('reward')}>ใช้สิทธิ์ / Reward</Button>
          <Button size="sm" icon="split" onClick={() => onAction('split')} disabled={!items.length}>แยก/รวม</Button>
          <Button size="sm" icon="note" onClick={() => onAction('note')}>หมายเหตุ</Button>
          {order.type === 'dine_in' && <Button size="sm" icon="print" onClick={() => onAction('prebill')} disabled={!order.saved}>ใบแจ้งยอด</Button>}
          <Button size="sm" icon="swap" onClick={() => onAction('type')} disabled={!can('pos.change_type')}>{order.type === 'dine_in' ? 'เปลี่ยนเป็นกลับบ้าน' : 'เปลี่ยนเป็นทานที่ร้าน'}</Button>
          {settings?.serviceCharge?.enabled && <Button size="sm" icon="tag" onClick={() => onAction('scExempt')}>{order.scExempt ? 'คิด SC' : 'ยกเว้น SC'}</Button>}
          <Button size="sm" variant="danger" icon="trash" onClick={() => onAction('voidOrder')} disabled={!items.length}>Void บิล</Button>
        </div>
      </div>
    </div>
  );
}
