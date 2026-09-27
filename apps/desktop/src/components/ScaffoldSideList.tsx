import { useMemo } from 'react';
import { useStore } from '../store';
import { buildScaffoldCards } from './Studio';
import { formatBytes } from '../format';
import type { Scaffold } from '../types';
import { Icon } from './Icon';

/// 清理脚本视图的 Side Bar：脚手架卡片精简列表（检测态 / 大小）。
/// 检测口径与编辑区大卡片共用 buildScaffoldCards（Studio 拆解时抽出，逻辑不动）；
/// 展开、CleanupModal、问 AI 等交互都留在编辑区卡片里，这里只做概览。
/// v2 工作台（spec §3 侧栏联动）：可选 onOpen —— 点脚本卡片打开对应脚本详情 tab。
/// 行样式 = 资源管理器同款 .side-line（图标 Lucide，无 emoji、无框）。
export function ScaffoldSideList({ onOpen }: { onOpen?: (sc: Scaffold) => void }) {
  const root = useStore((s) => s.root);
  const scaffolds = useStore((s) => s.scaffolds);
  const cards = useMemo(() => buildScaffoldCards(root, scaffolds), [root, scaffolds]);

  if (!root) {
    return (
      <div className="side-info">
        <p className="muted">扫描之后，这里会按检测状态列出各清理脚本。</p>
      </div>
    );
  }

  // 检测到的排前，组内按大小降序（与编辑区卡片排序口径一致）
  const sorted = [...cards].sort((a, b) => {
    const da = a.matches.length > 0 ? 1 : 0;
    const db = b.matches.length > 0 ? 1 : 0;
    if (da !== db) return db - da;
    return b.totalSize - a.totalSize;
  });

  return (
    <div className="side-list">
      {sorted.map((c) => {
        const detected = c.matches.length > 0;
        return (
          <div
            key={c.scaffold.id}
            className={'side-line' + (detected ? ' detected' : '')}
            title={c.scaffold.disclaimer}
            role={onOpen ? 'button' : undefined}
            tabIndex={onOpen ? 0 : undefined}
            onClick={onOpen ? () => onOpen(c.scaffold) : undefined}
            onKeyDown={
              onOpen
                ? (e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      onOpen(c.scaffold);
                    }
                  }
                : undefined
            }
          >
            <Icon name="package" size={14} />
            <span className="side-line-name">{c.scaffold.name}</span>
            <span className="side-line-meta">
              {detected
                ? `${formatBytes(c.totalSize)}${c.matches.length > 1 ? ` · ${c.matches.length}处` : ''}`
                : '未扫到'}
            </span>
          </div>
        );
      })}
      <div className="side-actions">
        <button className="btn ghost" onClick={() => onOpen?.(sorted[0]?.scaffold ?? scaffolds[0])}>
          <Icon name="puzzle" size={13} /> 在标签页中管理
        </button>
      </div>
    </div>
  );
}
