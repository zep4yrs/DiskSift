import { useEffect, useState } from 'react';
import { Folder, ScanLine, Settings as SettingsIcon } from 'lucide-react';
import { open } from '@tauri-apps/plugin-dialog';
import { listen } from '@tauri-apps/api/event';
import { api } from './api';
import { isTauri } from './env';
import { useStore } from './store';
import { TreeView } from './components/TreeView';
import { ChatPanel } from './components/ChatPanel';
import { Studio } from './components/Studio';
import { Settings } from './components/Settings';
import { Splitter } from './components/Splitter';
import { Logo } from './components/Logo';
import { formatBytes } from './format';
import { loadSettings, isConfigured } from './advisorClient';

function isDriveRoot(p: string): boolean {
  // C: / C:\ / C:/  — anything beyond is a subfolder
  return /^[A-Za-z]:[\\/]?$/.test(p);
}

const DEFAULT_LEFT = 620;
const DEFAULT_RIGHT = 320;
const MIN_LEFT = 320;
const MIN_RIGHT = 220;
const MIN_CENTER = 360;

export default function App() {
  const root = useStore((s) => s.root);
  const setRoot = useStore((s) => s.setRoot);
  const setScaffolds = useStore((s) => s.setScaffolds);
  const scaffolds = useStore((s) => s.scaffolds);
  const selectedPath = useStore((s) => s.selectedPath);
  const select = useStore((s) => s.selectPath);

  const [scanning, setScanning] = useState(false);
  const [scanProgress, setScanProgress] = useState<{ files: number; bytes: number; path: string } | null>(null);
  const [scanTotalBytes, setScanTotalBytes] = useState<number | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [pickedPath, setPickedPath] = useState<string>('');
  const [showSettings, setShowSettings] = useState(false);
  const [advisorTag, setAdvisorTag] = useState<{ provider: string } | null>(null);

  const refreshAdvisorTag = () => {
    const s = loadSettings();
    setAdvisorTag(isConfigured(s) ? { provider: s.provider } : null);
  };
  useEffect(() => { refreshAdvisorTag(); }, []);
  const [leftWidth, setLeftWidth] = useState<number>(() => {
    const v = Number(localStorage.getItem('diskwise.leftWidth'));
    return Number.isFinite(v) && v > MIN_LEFT ? v : DEFAULT_LEFT;
  });
  const [rightWidth, setRightWidth] = useState<number>(() => {
    const v = Number(localStorage.getItem('diskwise.rightWidth'));
    return Number.isFinite(v) && v > MIN_RIGHT ? v : DEFAULT_RIGHT;
  });

  useEffect(() => { localStorage.setItem('diskwise.leftWidth', String(leftWidth)); }, [leftWidth]);
  useEffect(() => { localStorage.setItem('diskwise.rightWidth', String(rightWidth)); }, [rightWidth]);

  const dragLeft = (dx: number) => {
    setLeftWidth((w) => {
      const winW = window.innerWidth;
      const maxLeft = Math.max(MIN_LEFT, winW - rightWidth - MIN_CENTER);
      return Math.max(MIN_LEFT, Math.min(maxLeft, w + dx));
    });
  };
  const dragRight = (dx: number) => {
    setRightWidth((w) => {
      const winW = window.innerWidth;
      const maxRight = Math.max(MIN_RIGHT, winW - leftWidth - MIN_CENTER);
      return Math.max(MIN_RIGHT, Math.min(maxRight, w - dx));
    });
  };

  useEffect(() => { api.listScaffolds().then(setScaffolds).catch(() => {}); }, [setScaffolds]);

  useEffect(() => {
    if (!isTauri) return;
    const unlisten = listen<{ files_seen: number; bytes_seen: number; current_path: string }>(
      'scan-progress',
      (e) => setScanProgress({ files: e.payload.files_seen, bytes: e.payload.bytes_seen, path: e.payload.current_path }),
    );
    return () => { unlisten.then((u) => u()); };
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
    setErr(null); setScanning(true); setScanProgress(null); setScanTotalBytes(null);
    if (isTauri) {
      if (isDriveRoot(pickedPath)) {
        // Drive root: ask the OS for used bytes — instant, exact.
        api.volumeInfo(pickedPath)
          .then((info) => { if (info) setScanTotalBytes(info.used_bytes); })
          .catch(() => {});
      } else {
        // Subfolder: run a fast size-only walk in parallel with the real scan.
        // The real scan is doing the same work either way; this just gives the
        // progress bar an exact denominator a bit ahead of completion.
        api.estimateSize(pickedPath)
          .then((bytes) => { if (bytes > 0) setScanTotalBytes(bytes); })
          .catch(() => {});
      }
    }
    try {
      const node = await api.scan(pickedPath);
      const tagged = await tagScaffolds(node);
      setRoot(tagged);
      select(tagged.path);
    } catch (e) {
      setErr(String(e));
    } finally {
      setScanning(false);
    }
  };

  const tagScaffolds = async (n: any, depth = 0): Promise<any> => {
    const id = n.is_dir ? await api.detectScaffold(n.path).catch(() => null) : null;
    const cap = depth < 2 ? 100 : depth < 4 ? 50 : 20;
    return {
      ...n,
      scaffold_id: id,
      children: await Promise.all(
        (n.children ?? []).slice(0, cap).map((c: any) => tagScaffolds(c, depth + 1)),
      ),
    };
  };

  return (
    <div className="app">
      <header>
        <span className="brand"><Logo size={22} /> Diskwise</span>
        <button className="ghost" onClick={pickDirectory}>
          <Folder size={14} /> {pickedPath || '选择磁盘或文件夹'}
        </button>
        <button className="primary" onClick={scan} disabled={!pickedPath || scanning}>
          <ScanLine size={14} /> {scanning ? '扫描中…' : '扫描'}
        </button>
        <div className="grow" />
        <span className="muted small">
          {root ? `${formatBytes(root.size)} · ${root.file_count.toLocaleString()} 文件` : '未扫描'}
        </span>
        <button
          className={'ghost icon settings-btn' + (advisorTag ? ' bound' : '')}
          onClick={() => setShowSettings(true)}
          title={advisorTag ? `已绑定 ${advisorTag.provider} · 点开管理` : 'AI 还没配置 · 点开设置'}
        >
          <SettingsIcon size={16} />
          {advisorTag && <span className="settings-dot" />}
        </button>
        {advisorTag && (
          <span className="provider-pill" title="当前 AI 提供商">
            {advisorTag.provider}
          </span>
        )}
      </header>

      {scanning && (
        <div className="scan-bar">
          <div
            className={'scan-bar-fill' + (scanTotalBytes && scanProgress ? ' determinate' : ' indeterminate')}
            style={
              scanTotalBytes && scanProgress
                ? { width: `${Math.min(99, (scanProgress.bytes / scanTotalBytes) * 100)}%` }
                : undefined
            }
          />
          <div className="scan-bar-label">
            {scanProgress
              ? `${scanProgress.files.toLocaleString()} 个文件 · ${formatBytes(scanProgress.bytes)}${scanTotalBytes ? ` / ${formatBytes(scanTotalBytes)}` : ''}`
              : '准备扫描…'}
          </div>
        </div>
      )}
      {err && <div className="banner error">{err}</div>}

      <main style={{ gridTemplateColumns: `${leftWidth}px 4px 1fr 4px ${rightWidth}px` }}>
        <aside className="left">
          {root ? <TreeView root={root} selectedPath={selectedPath} onSelect={select} /> : <EmptyLeft />}
        </aside>

        <Splitter onDrag={dragLeft} onDoubleClick={() => setLeftWidth(DEFAULT_LEFT)} />

        <section className="center">
          <ChatPanel />
        </section>

        <Splitter onDrag={dragRight} onDoubleClick={() => setRightWidth(DEFAULT_RIGHT)} />

        <aside className="right">
          <Studio />
        </aside>
      </main>

      <footer>
        <span>Diskwise v0.1 · {scaffolds.length} 个脚本</span>
        <span>{root?.path ?? '还没扫描'}</span>
      </footer>

      {showSettings && <Settings onClose={() => { setShowSettings(false); refreshAdvisorTag(); }} />}
    </div>
  );
}

function EmptyLeft() {
  return (
    <div className="empty">
      <div className="empty-title">还没扫描</div>
      <div className="empty-sub">在顶栏选一个文件夹，然后点「扫描」。<br />扫完之后，左侧会列出每个文件夹和文件。</div>
    </div>
  );
}
