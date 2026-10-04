import { useMemo } from 'react';
import { usePos } from './posStore.js';
import { useApp } from '../../lib/store.js';
import { Icon } from '../../components/ui.jsx';
import { money, cls } from '../../lib/util.js';

export default function CatalogPane({ onPick }) {
  const { catalog, selectedCategory, search } = usePos();
  const showStock = useApp((s) => s.settings?.pos?.showStock !== false);
  const products = useMemo(() => {
    const q = search.trim().toLowerCase();
    return catalog.products.filter((p) => {
      if (q) return p.name.toLowerCase().includes(q) || (p.nameEn || '').toLowerCase().includes(q) || (p.sku || '').toLowerCase() === q || (p.sku || '').toLowerCase().includes(q) || p.barcode === search.trim() || p.variants.some((v) => v.barcode === search.trim());
      return selectedCategory === 'all' || p.categoryId === selectedCategory;
    });
  }, [catalog.products, selectedCategory, search]);
  const cats = catalog.categories;
  return (
    <div className="pos-catalog">
      <div className="pos-search">
        <Icon name="search" style={{ position: 'absolute', left: 14, top: 14, color: 'var(--muted)' }} />
        <input className="input lg" placeholder="ค้นหาชื่อ / SKU / Barcode" value={search} onChange={(e) => usePos.setState({ search: e.target.value })}
          onKeyDown={(e) => { if (e.key === 'Enter' && products.length === 1) { onPick(products[0]); usePos.setState({ search: '' }); } }} />
        {search && <button type="button" className="btn ghost icon" style={{ position: 'absolute', right: 4, top: 4 }} onClick={() => usePos.setState({ search: '' })}><Icon name="x" /></button>}
      </div>
      <div className="pos-cats">
        <button type="button" className={cls('pos-cat', selectedCategory === 'all' && 'on')} onClick={() => usePos.setState({ selectedCategory: 'all', search: '' })}>ทั้งหมด</button>
        {cats.map((c) => (
          <button key={c.id} type="button" className={cls('pos-cat', selectedCategory === c.id && 'on')} style={{ '--cat': c.color || 'var(--primary)' }} onClick={() => usePos.setState({ selectedCategory: c.id, search: '' })}>{c.name}</button>
        ))}
      </div>
      <div className="pos-grid">
        {products.map((p) => {
          const off = p.status !== 'available';
          const low = p.trackStock && p.stock != null && p.minStock > 0 && p.stock <= p.minStock;
          return (
            <button key={p.id} type="button" className={cls('pos-prod', off && 'off')} onClick={() => !off && onPick(p)} disabled={off}>
              <div className="img" style={p.imageUrl ? { backgroundImage: `url("${p.imageUrl}")` } : { background: `linear-gradient(135deg, ${catalog.categories.find((c) => c.id === p.categoryId)?.color || 'var(--primary)'}22, var(--surface-2))` }}>
                {!p.imageUrl && <span className="initial">{p.name.slice(0, 2)}</span>}
                {off && <span className="soldout">{p.status === 'sold_out' ? 'SOLD OUT' : 'งดขายชั่วคราว'}</span>}
                {showStock && p.trackStock && !off && <span className={cls('stock', low && 'low')}>เหลือ {p.stock}</span>}
              </div>
              <div className="info">
                <div className="name">{p.name}</div>
                <div className="price num">฿{money(p.price)}{(p.variants.length > 0 || p.modifierGroupIds.length > 0) && <span className="muted xs"> +ตัวเลือก</span>}</div>
              </div>
            </button>
          );
        })}
        {!products.length && <div className="empty" style={{ gridColumn: '1/-1' }}>ไม่พบสินค้า</div>}
      </div>
    </div>
  );
}
