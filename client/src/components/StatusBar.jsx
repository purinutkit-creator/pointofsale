import { useEffect, useState } from 'react';
import { useApp } from '../lib/store.js';
import { connectivity, retryEntry, discardEntry } from '../lib/sync.js';
import { api } from '../lib/api.js';
import { on } from '../lib/socket.js';
import { Icon, Modal, Button, Badge, Empty } from './ui.jsx';
import { fmtDateTime, cls } from '../lib/util.js';
import { playError } from '../lib/sound.js';

export function ConnectivityBadge() {
  const s = useApp();
  const c = connectivity(s);
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className="chip" onClick={() => setOpen(true)} title="สถานะการเชื่อมต่อ">
        <span className={cls('dot', c.color)} />{c.label}{s.syncErrors.length ? <Badge tone="danger">{s.syncErrors.length}</Badge> : null}
      </button>
      {open && (
        <Modal title="สถานะการเชื่อมต่อ / Sync" onClose={() => setOpen(false)}>
          <div className="col">
            <div className="row"><span className={cls('dot', c.color)} /><b>{c.key === 'online' ? '🟢 Online' : c.key === 'syncing' ? '🟠 Syncing' : '🔴 Offline'}</b></div>
            <div className="small muted">รายการรอ Sync: {s.outboxCount} · Real-time: {s.socketConnected ? 'เชื่อมต่อ' : 'ไม่เชื่อมต่อ'}</div>
            {s.syncErrors.length > 0 && <h3 className="mt">Sync Error</h3>}
            {s.syncErrors.map((e) => (
              <div key={e.seq} className="card pad">
                <div className="bold">{e.label || e.path}</div>
                <div className="small" style={{ color: 'var(--danger)' }}>{e.error}</div>
                <div className="row mt"><Button size="sm" onClick={() => retryEntry(e.seq)}>ลองใหม่</Button><Button size="sm" variant="ghost" onClick={() => discardEntry(e.seq)}>ยกเลิกรายการนี้</Button></div>
              </div>
            ))}
          </div>
        </Modal>
      )}
    </>
  );
}

export function NotificationBell() {
  const [list, setList] = useState([]);
  const [open, setOpen] = useState(false);
  const staff = useApp((s) => s.staff);
  useEffect(() => {
    if (!staff) return undefined;
    api('/notifications').then(setList).catch(() => {});
    return on('notification', (n) => {
      setList((l) => [n, ...l].slice(0, 100));
      useApp.getState().toast(n.title, n.level === 'error' ? 'error' : n.level === 'warning' ? 'warning' : n.level === 'success' ? 'success' : 'info', 5000);
      if (n.level === 'error') playError();
    });
  }, [staff]);
  const unread = list.filter((n) => !n.read_at).length;
  return (
    <>
      <Button variant="ghost" onClick={() => setOpen(true)} aria-label="การแจ้งเตือน" style={{ position: 'relative' }}>
        <Icon name="bell" />{unread > 0 && <span className="badge danger" style={{ position: 'absolute', top: 2, right: 0, padding: '0 6px' }}>{unread}</span>}
      </Button>
      {open && (
        <Modal title="การแจ้งเตือน" onClose={() => setOpen(false)} footer={<Button onClick={async () => { await api('/notifications/read', { method: 'POST', body: {} }); setList((l) => l.map((n) => ({ ...n, read_at: n.read_at || new Date().toISOString() }))); }}>อ่านทั้งหมด</Button>}>
          {!list.length && <Empty icon="bell">ไม่มีการแจ้งเตือน</Empty>}
          <div className="col">
            {list.map((n) => (
              <div key={n.id} className="row" style={{ alignItems: 'flex-start', opacity: n.read_at ? 0.6 : 1 }}>
                <Icon name={n.level === 'error' ? 'alert' : n.kind?.includes('stock') ? 'box' : n.kind?.includes('printer') || n.kind?.includes('print') ? 'print' : 'info'} style={{ color: n.level === 'error' ? 'var(--danger)' : n.level === 'warning' ? 'var(--warning)' : 'var(--info)' }} />
                <div className="grow"><div className="bold">{n.title}</div>{n.body && <div className="small muted">{n.body}</div>}<div className="xs muted">{fmtDateTime(n.created_at)}</div></div>
              </div>
            ))}
          </div>
        </Modal>
      )}
    </>
  );
}
