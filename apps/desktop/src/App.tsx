import { useEffect, useMemo, useRef, useState } from 'react';
import { Folder, ScanLine, Settings as SettingsIcon, Play } from 'lucide-react';
import { open } from '@tauri-apps/plugin-dialog';
import { api } from './api';
import { isTauri } from './env';
import { useStore, buildWalkQueue } from './store';
import { TreeView } from './components/TreeView';
import { Treemap } from './components/Treemap';
import { AutoWalk } from './components/AutoWalk';
import { Settings } from './components/Settings';
import { formatBytes } from './format';

export default function App() {
  const root = useStore((s) => s.root);
  const setRoot = useStore((s) => s.setRoot);
  const setScaffolds = useStore((s) => s.setScaffolds);
  const scaffolds = useStore((s) => s.scaffolds);
  const selectedPath = useStore((s) => s.selectedPath);
  const select = useStore((s) => s.selectPath);
  const setWalk = useStore((s) => s.setWalk);
  const threshold = useStore((s) => s.walkThresholdGB);
  const setThreshold = useStore((s) => s.setThreshold);

  const [scanning, setScanning] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [pickedPath, setPickedPath] = useState<string>('');
  const [showSettings, setShowSettings] = useState(false);
  const treeWrap = useRef<HTMLDivElement>(null);
  const [treemapSize, setTreemapSize] = useState({ w: 800, h: 480 });

  useEffect(() => { api.listScaffolds().then(setScaffolds).catch(() => {}); }, [setScaffolds]);

  useEffect(() => {
    if (!treeWrap.current) return;
    const ro = new ResizeObserver(() => {
      const r = treeWrap.current!.getBoundingClientRect();
      setTreemapSize({ w: Math.max(300, r.width), h: Math.max(200, r.height) });
    });
    ro.observe(treeWrap.current);
    return () => ro.disconnect();
  }, []);

  const pickDirectory = async () => {
    if (!isTauri) {
      const p = window.prompt('浏览器预览模式：输入一个路径（任意值都可以）', 'C:\\');
      if (p) setPickedPath(p);
      return;
    }
    const picked = await open({ directory: true, multiple: false });
    if (typeof picked === 'string') setPickedPath(picked);
  };

  const scan = async () => {
    if (!pickedPath) return;
    setErr(null); setScanning(true);
    try {
      const node = await api.scan(pickedPath);
      // attach scaffold ids
      const tagged = await tagScaffolds(node);
      setRoot(tagged);
      select(tagged.path);
    } catch (e) {
      setErr(String(e));
    } finally {
      setScanning(false);
    }
  };

  const tagScaffolds = async (n: any): Promise<any> => {
    const id = await api.detectScaffold(n.path).catch(() => null);
    return {
      ...n,
      scaffold_id: id,
      children: await Promise.all((n.children ?? []).slice(0, 50).map(tagScaffolds)),
    };
  };

  const startWalk = () => {
    if (!root) return;
    const items = buildWalkQueue(root, threshold * 1024 ** 3);
    setWalk(items.map((it) => ({ node: it.node, scaffoldId: it.scaffoldId, status: 'pending' })));
  };

  const selectedNode = useMemo(() => {
    if (!root || !selectedPath) return root;
    const dfs = (n: any): any => n.path === selectedPath ? n : (n.children ?? []).map(dfs).find(Boolean);
    return dfs(root) ?? root;
  }, [root, selectedPath]);

  return (
    <div className="app">
      <header>
        <button className="ghost" onClick={pickDirectory}>
          <Folder size={14} /> {pickedPath || 'Pick a drive or folder'}
        </button>
        <button className="primary" onClick={scan} disabled={!pickedPath || scanning}>
          <ScanLine size={14} /> {scanning ? 'Scanning…' : 'Scan'}
        </button>
        <div className="grow" />
        <label className="threshold">
          Auto-walk threshold:
          <input type="number" min={0.05} step={0.05} value={threshold} onChange={(e) => setThreshold(Number(e.target.value))} />
          GB
        </label>
        <button className="primary" onClick={startWalk} disabled={!root}>
          <Play size={14} /> Start Auto-Walk
        </button>
        <button className="ghost icon" onClick={() => setShowSettings(true)}>
          <SettingsIcon size={16} />
        </button>
      </header>

      {!isTauri && (
        <div className="banner" style={{ background: 'rgba(91,141,239,0.15)', color: '#9bb6f5' }}>
          浏览器预览模式 · 数据是模拟的（C 盘的样子参考你截图） · 真实扫描需要在 Tauri 桌面 app 里跑
        </div>
      )}
      {err && <div className="banner error">{err}</div>}

      <main>
        <aside className="left">
          {root ? <TreeView root={root} selectedPath={selectedPath} onSelect={select} /> : <Empty />}
        </aside>

        <section className="center">
          <div className="breadcrumb">
            {selectedNode ? <><strong>{selectedNode.name}</strong> · {selectedNode.path}</> : 'No selection'}
            {selectedNode && <span className="size">{formatBytes(selectedNode.size)}</span>}
          </div>
          <div className="treemap-wrap" ref={treeWrap}>
            {selectedNode && selectedNode.children?.length > 0 && (
              <Treemap
                node={selectedNode}
                width={treemapSize.w}
                height={treemapSize.h}
                onSelect={select}
                selectedPath={selectedPath}
              />
            )}
          </div>
        </section>

        <aside className="right">
          <AutoWalk />
        </aside>
      </main>

      <footer>
        <span>Diskwise v0.1 · {scaffolds.length} scaffolds loaded</span>
        <span>{root ? `${formatBytes(root.size)} scanned · ${root.file_count.toLocaleString()} files` : 'No scan yet'}</span>
      </footer>

      {showSettings && <Settings onClose={() => setShowSettings(false)} />}
    </div>
  );
}

function Empty() {
  return (
    <div className="empty">
      <div className="empty-title">No scan yet</div>
      <div className="empty-sub">Pick a folder above and press Scan.</div>
    </div>
  );
}
