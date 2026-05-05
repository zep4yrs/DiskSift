import { useState } from 'react';
import { ChevronRight, ChevronDown, FolderOpen, Copy } from 'lucide-react';
import type { Node } from '../types';
import { formatBytes, formatCount } from '../format';
import { api } from '../api';
import { ContextMenu, type ContextMenuState } from './ContextMenu';

type Props = {
  root: Node;
  selectedPath: string | null;
  onSelect: (p: string) => void;
};

export function TreeView({ root, selectedPath, onSelect }: Props) {
  const [ctx, setCtx] = useState<ContextMenuState | null>(null);

  const openCtx = (e: React.MouseEvent, node: Node) => {
    e.preventDefault();
    setCtx({
      x: e.clientX,
      y: e.clientY,
      items: [
        {
          label: '在文件管理器中打开',
          icon: <FolderOpen size={12} />,
          onClick: () => { api.revealInExplorer(node.path).catch(() => { /* path may have been deleted */ }); },
        },
        {
          label: '复制路径',
          icon: <Copy size={12} />,
          onClick: () => { navigator.clipboard?.writeText(node.path).catch(() => { /* ignore */ }); },
        },
      ],
    });
  };

  return (
    <div className="treeview">
      <div className="tree-headrow">
        <div className="col-name">文件夹</div>
        <div className="col-pct">父级 %</div>
        <div className="col-size">大小</div>
        <div className="col-count">项目</div>
      </div>
      <div className="tree-body">
        <Row
          node={root}
          parentSize={root.size || 1}
          depth={0}
          selectedPath={selectedPath}
          onSelect={onSelect}
          onCtx={openCtx}
          initialOpen
        />
      </div>
      <ContextMenu state={ctx} onClose={() => setCtx(null)} />
    </div>
  );
}

function FolderGlyph({ open }: { open: boolean }) {
  // Windows-style yellow folder (closed/open variants).
  if (open) {
    return (
      <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden>
        <path d="M1.5 4.5 A1 1 0 0 1 2.5 3.5 H6 L7.5 5 H13.5 A1 1 0 0 1 14.5 6 V6.8 H3.6 L1.5 12.5 Z" fill="#f5c75e" stroke="#9c7c2a" strokeWidth="0.7" />
        <path d="M3.6 6.8 H15.2 L13.2 12.5 H1.5 Z" fill="#ffd97a" stroke="#9c7c2a" strokeWidth="0.7" strokeLinejoin="round" />
      </svg>
    );
  }
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden>
      <path d="M1.5 4.5 A1 1 0 0 1 2.5 3.5 H6 L7.5 5 H13.5 A1 1 0 0 1 14.5 6 V12.5 A1 1 0 0 1 13.5 13.5 H2.5 A1 1 0 0 1 1.5 12.5 Z" fill="#f5c75e" stroke="#9c7c2a" strokeWidth="0.8" strokeLinejoin="round" />
      <path d="M1.5 6 H14.5" stroke="#9c7c2a" strokeWidth="0.5" opacity="0.5" />
    </svg>
  );
}

function FileGlyph({ ext }: { ext: string }) {
  // Pick a tint by file family — keeps the tree visually grep-able like Explorer.
  const fill =
    /^(exe|msi|cmd|bat|com)$/i.test(ext) ? '#cfe6ff' :
    /^(dll|sys|drv|ocx)$/i.test(ext) ? '#dfd6f7' :
    /^(zip|rar|7z|tar|gz|xz)$/i.test(ext) ? '#ffd6c0' :
    /^(png|jpg|jpeg|gif|bmp|webp|svg|ico)$/i.test(ext) ? '#ffd0e6' :
    /^(mp3|wav|flac|m4a|ogg)$/i.test(ext) ? '#d0f0d8' :
    /^(mp4|mov|mkv|avi|webm)$/i.test(ext) ? '#c8eaef' :
    /^(txt|md|log)$/i.test(ext) ? '#fff1bd' :
    /^(json|toml|yaml|yml|xml|ini|conf)$/i.test(ext) ? '#e6f0ff' :
    /^(pdf)$/i.test(ext) ? '#ffc5c5' :
    '#ffffff';
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden>
      <path d="M3.5 2 H10 L13 5 V13.5 A0.5 0.5 0 0 1 12.5 14 H3.5 A0.5 0.5 0 0 1 3 13.5 V2.5 A0.5 0.5 0 0 1 3.5 2 Z"
        fill={fill} stroke="#5b4d57" strokeWidth="0.7" strokeLinejoin="round" />
      <path d="M10 2 V5 H13" fill="none" stroke="#5b4d57" strokeWidth="0.7" strokeLinejoin="round" />
    </svg>
  );
}

function extOf(name: string): string {
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(i + 1).toLowerCase() : '';
}

function Row({
  node,
  parentSize,
  depth,
  selectedPath,
  onSelect,
  onCtx,
  initialOpen = false,
}: {
  node: Node;
  parentSize: number;
  depth: number;
  selectedPath: string | null;
  onSelect: (p: string) => void;
  onCtx: (e: React.MouseEvent, node: Node) => void;
  initialOpen?: boolean;
}) {
  const [open, setOpen] = useState(initialOpen);
  const hasKids = (node.children?.length ?? 0) > 0;
  const sel = node.path === selectedPath;
  const pct = parentSize > 0 ? (node.size / parentSize) * 100 : 0;

  return (
    <>
      <div
        className={'tree-row' + (sel ? ' selected' : '') + (node.is_dir ? '' : ' is-file')}
        onClick={() => onSelect(node.path)}
        onContextMenu={(e) => onCtx(e, node)}
        draggable
        onDragStart={(e) => {
          e.dataTransfer.setData('application/x-pinkbin-path', node.path);
          e.dataTransfer.setData('application/x-pinkbin-name', node.name);
          e.dataTransfer.effectAllowed = 'copy';
        }}
        title={node.path + '  ·  右键查看选项'}
      >
        <div className="col-name" style={{ paddingLeft: 4 + depth * 14 }}>
          <span
            className="caret"
            onClick={(e) => { e.stopPropagation(); if (hasKids) setOpen((v) => !v); }}
          >
            {hasKids
              ? (open ? <ChevronDown size={11} /> : <ChevronRight size={11} />)
              : <span className="caret-stub" />}
          </span>
          <span className="glyph">
            {node.is_dir ? <FolderGlyph open={open} /> : <FileGlyph ext={extOf(node.name)} />}
          </span>
          <span className="name">{node.name || node.path}</span>
          {node.scaffold_id && <span className="badge">{node.scaffold_id}</span>}
        </div>
        <div className="col-pct">
          <span className="pct-bar"><span style={{ width: `${Math.min(100, pct)}%` }} /></span>
          <span className="pct-num">{pct.toFixed(1)}%</span>
        </div>
        <div className="col-size">{formatBytes(node.size)}</div>
        <div className="col-count">{formatCount(node.file_count)}</div>
      </div>
      {open && hasKids && node.children.slice(0, 500).map((c) => (
        <Row
          key={c.path}
          node={c}
          parentSize={node.size || 1}
          depth={depth + 1}
          selectedPath={selectedPath}
          onSelect={onSelect}
          onCtx={onCtx}
        />
      ))}
    </>
  );
}
