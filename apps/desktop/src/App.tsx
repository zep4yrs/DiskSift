import { useEffect, useMemo, useRef, useState } from 'react';
import { Folder, ScanLine, Settings as SettingsIcon, Play, LayoutGrid, BarChart3 } from 'lucide-react';
import { open } from '@tauri-apps/plugin-dialog';
import { api } from './api';
import { isTauri } from './env';
import { useStore, buildWalkQueue } from './store';
import { TreeView } from './components/TreeView';
import { Treemap } from './components/Treemap';
import { AutoWalk } from './components/AutoWalk';
import { Settings } from './components/Settings';
import { TriageView } from './components/TriageView';
import { formatBytes } from './format';
import type { Triaged } from './triage';

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
  const [centerView, setCenterView] = useState<'triage' | 'treemap'>('triage');
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

  const jumpToWalkFromTriage = (it: Triaged) => {
    setWalk([{ node: it.node, scaffoldId: it.scaffoldId, status: 'pending' }]);
  };

  const selectedNode = useMemo(() => {
    if (!root || !selectedPath) return root;
    const dfs = (n: any): any => n.path === selectedPath ? n : (n.children ?? []).map(dfs).find(Boolean);
    return dfs(root) ?? root;
  }, [root, selectedPath]);

  return (
    <div className="app">
      <header>
        <span className="brand"><span className="dot" /> Diskwise</span>
        <button className="ghost" onClick={pickDirectory}>
          <Folder size={14} /> {pickedPath || '选择磁盘或文件夹'}
        </button>
        <button className="primary" onClick={scan} disabled={!pickedPath || scanning}>
          <ScanLine size={14} /> {scanning ? '扫描中…' : '扫描'}
        </button>
        <div className="grow" />
        <label className="threshold">
          阈值
          <input type="number" min={0.05} step={0.05} value={threshold} onChange={(e) => setThreshold(Number(e.target.value))} />
          GB
        </label>
        <button className="primary" onClick={startWalk} disabled={!root}>
          <Play size={14} /> 开始巡查
        </button>
        <button className="ghost icon" onClick={() => setShowSettings(true)}>
          <SettingsIcon size={16} />
        </button>
      </header>

      {!isTauri && (
        <div className="banner preview">
          浏览器预览模式 · 扫描数据是模拟的 · <strong>右上角设置里填 AI Key，AI 卡片就会调真实接口</strong>
        </div>
      )}
      {err && <div className="banner error">{err}</div>}

      <main>
        <aside className="left">
          {root ? <TreeView root={root} selectedPath={selectedPath} onSelect={select} /> : <Empty />}
        </aside>

        <section className="center">
          <div className="breadcrumb">
            <button className={'tab' + (centerView === 'triage' ? ' active' : '')} onClick={() => setCenterView('triage')}>
              <LayoutGrid size={13} /> 诊断
            </button>
            <button className={'tab' + (centerView === 'treemap' ? ' active' : '')} onClick={() => setCenterView('treemap')}>
              <BarChart3 size={13} /> 树图
            </button>
            <div className="grow" />
            {selectedNode && (
              <span style={{ color: 'var(--ink-2)', fontSize: 11, fontWeight: 600 }}>
                {selectedNode.path}
              </span>
            )}
            {selectedNode && <span className="size">{formatBytes(selectedNode.size)}</span>}
          </div>
          <div className="center-body" ref={treeWrap}>
            {centerView === 'triage' && root && (
              <TriageView
                root={root}
                thresholdBytes={threshold * 1024 ** 3}
                onJumpToWalk={jumpToWalkFromTriage}
                onSelect={select}
              />
            )}
            {centerView === 'treemap' && selectedNode && selectedNode.children?.length > 0 && (
              <div className="treemap-wrap">
                <Treemap
                  node={selectedNode}
                  width={treemapSize.w}
                  height={treemapSize.h}
                  onSelect={select}
                  selectedPath={selectedPath}
                />
              </div>
            )}
            {!root && <Empty />}
          </div>
        </section>

        <aside className="right">
          <AutoWalk />
        </aside>
      </main>

      <footer>
        <span>Diskwise v0.1 · 已加载 {scaffolds.length} 个清理脚本</span>
        <span>{root ? `已扫描 ${formatBytes(root.size)} · ${root.file_count.toLocaleString()} 文件` : '还没扫描'}</span>
      </footer>

      {showSettings && <Settings onClose={() => setShowSettings(false)} />}
    </div>
  );
}

function Empty() {
  return (
    <div className="empty">
      <div className="empty-title">还没扫描</div>
      <div className="empty-sub">在顶栏选一个文件夹，然后点「扫描」。</div>
    </div>
  );
}
