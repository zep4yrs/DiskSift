import { useMemo } from 'react';
import { hierarchy, treemap, treemapSquarify } from 'd3-hierarchy';
import type { Node } from '../types';
import { formatBytes } from '../format';
import { isFocusDimmed, VERDICT_META, type VerdictEntry } from '../triage-cache';

type Props = {
  node: Node;                       // 当前 treemap 根（可下钻后的子树）
  width: number;
  height: number;
  onSelect: (path: string) => void;
  selectedPath: string | null;
  onOpen: (path: string) => void;   // 双击目录块 = 下钻进该目录（单击让位给选中，spec §2.0）
  /** 分诊图层 O1（triage-overlay-spec §3）：path → 判定 */
  verdicts: Map<string, VerdictEntry>;
  /** 祖先聚合徽标数据源：path → 子树内可清理字节（spec §2.1.1） */
  cleanableUnder: Map<string, number>;
  /** 「只看可清理」聚焦模式（spec §2.1.2）：非可清理块淡至 12% 透明度 */
  focusClean?: boolean;
};

// slate 渐进中性色板（spec §1 废除粉色板）：--foreground 对 --card 的 10 档
// color-mix 深浅梯度（10%–48%），定义在 styles.css §1 令牌层。
// 梯度区间经过选择，保证两种明暗模式下瓦片与 --treemap-ink 文字都有可读对比。
const PALETTE = [
  'var(--tm-1)', 'var(--tm-2)', 'var(--tm-3)', 'var(--tm-4)', 'var(--tm-5)',
  'var(--tm-6)', 'var(--tm-7)', 'var(--tm-8)', 'var(--tm-9)', 'var(--tm-10)',
];

function colorFor(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) & 0xffffffff;
  return PALETTE[Math.abs(h) % PALETTE.length];
}

// SVG text 没有省略号机制：按块宽逐字估宽截断补 …
// 宽度模型：CJK/全角 = 1×fontSize，西文/数字 ≈ 0.55×fontSize（此前纯西文估算
// 对中文目录名溢出——中文用户的主场景，不能只按西文算）。
function fit(s: string, maxW: number, fontSize: number): string {
  const budget = maxW - 12;
  if (budget <= 0) return '';
  const charW = (ch: string) => (/[\u2E80-\u9FFF\uF900-\uFAFF\uFF00-\uFFEF]/.test(ch) ? fontSize : fontSize * 0.55);
  let w = 0;
  let cut = -1;
  for (let i = 0; i < s.length; i++) {
    w += charW(s[i]);
    if (w > budget) { cut = i; break; }
  }
  if (cut === -1) return s;
  // 截断点留一个字符给省略号
  let end = cut;
  let ew = fontSize * 1.4;
  while (end > 0 && ew > 0) {
    end--;
    ew -= charW(s[end]);
  }
  return s.slice(0, Math.max(1, end)) + '…';
}

export function Treemap({ node, width, height, onSelect, selectedPath, onOpen, verdicts, cleanableUnder, focusClean = false }: Props) {
  const layout = useMemo(() => {
    // 性能关键：先把树剪到 2 层再 hierarchy。否则 hierarchy 会遍历整棵扫描树
    // （几十万节点），每次尺寸变化全量重建 = 渲染后持续卡顿的根因。
    // depth>=2 的目录按其自身 size 作为叶子计值（渲染也只画到第 2 层）。
    const prune = (n: Node, depth: number): Node => ({
      ...n,
      children:
        depth >= 2
          ? []
          : n.children
              ?.filter((c) => c.size > 0)
              .slice(0, 200)
              .map((c) => prune(c, depth + 1)) ?? [],
    });
    const pruned = prune({ ...node, children: node.children?.slice(0, 200) }, 0);
    // 空根兜底：图根没有可显示子块（mock 的 ProgramData/Eastmoney 叶子、真实
    // 空目录、子块全被 size>0 滤掉）时，hierarchy 只产出 depth 0 自身、被下方
    // depth>=1 过滤 = 换根后整块画布空白。合成自身为唯一子块（depth 1 整幅），
    // 保证「树→图跟随换根」在空目录上也看得见：面包屑之外还有一块占满的瓦片。
    // 合成子块 size 抬到 ≥1：下方 children accessor 会滤掉 size=0 的子块
    // （真实 0 字节空目录场景），视觉是单块整幅不受影响，tooltip 显示 1 B。
    const withTile =
      pruned.children && pruned.children.length > 0
        ? pruned
        : { ...pruned, children: [{ ...pruned, size: Math.max(pruned.size, 1), children: [] }] };
    const root = hierarchy<Node>(withTile, (d) => d.children?.filter((c) => c.size > 0))
      .sum((d) => (d.children && d.children.length ? 0 : Math.max(1, d.size)))
      .sort((a, b) => (b.value ?? 0) - (a.value ?? 0));
    // paddingTop(16)：父块顶部保留 16px 标题条，父标签画在条内、子块从条下排布——
    // 修复父/子标签同位叠加的重影（旧实现父块与子块标签都画在各自 y0+16）。
    return treemap<Node>()
      .size([width, height])
      .tile(treemapSquarify)
      .paddingOuter(2)
      .paddingInner(1)
      .paddingTop(16)(root)
      .descendants()
      .filter((n) => n.depth >= 1 && n.depth <= 2);
  }, [node, width, height]);

  return (
    <svg width={width} height={height} className="treemap">
      {layout.map((d) => {
        const x = d.x0;
        const y = d.y0;
        const w = d.x1 - d.x0;
        const h = d.y1 - d.y0;
        if (w <= 0 || h <= 0) return null;
        const isDir = d.data.is_dir || !!(d.data.children && d.data.children.length);
        const isSelected = d.data.path === selectedPath;
        const fill = colorFor(d.data.name);
        // ── 分诊图层 O1（triage-overlay-spec §3/§2.1.1）─────────────────
        const entry = verdicts.get(d.data.path) ?? null;
        const cleanable = cleanableUnder.get(d.data.path) ?? 0;
        // 祖先聚合徽标：块自身是 safe 时左缘色条已表意，不再重复挂 pill；
        // 块太窄放不下也省略（标签优先）。v26.1.2 复核 ① 单子链同值去重改锚
        // 「只最上层挂」：渲染出的父块（d.parent.depth>=1）聚合值与本块相等 =
        // 可清理量全部压在本块的子链上，本块让位，徽标由链顶（视图内渲染的
        // 最高块）挂——旧逻辑锚在链底（逐层查子块同值），纯单链 + safe 叶子
        // 时链上谁都挂不出徽标。父块是视图根（depth 0，徽标本就不渲染）时
        // 本块即链顶，照常挂。
        const pillLabel = formatBytes(cleanable);
        const pillW = 22 + pillLabel.length * 5.6;
        const parentSame =
          cleanable > 0 &&
          !!d.parent &&
          d.parent.depth >= 1 &&
          (cleanableUnder.get(d.parent.data.path) ?? 0) === cleanable;
        const showPill = cleanable > 0 && entry?.verdict !== 'safe' && !parentSame && w > pillW + 14;
        // 「只看可清理」聚焦（spec §2.1.2）：非可清理块淡至 12% 透明度，可清理块不变。
        // 祖先块（cleanableUnder>0，挂 🟢 徽标）与当前选中块保持可见——徽标是深层
        // 可清理目录的发现面（§2.1.1），压暗祖先链等于关掉发现路径；选中块淡显会
        // 连带吞掉选中描边，选中上下文优先。
        const dimmed = focusClean && isFocusDimmed(entry, cleanable) && !isSelected;
        return (
          <g
            key={d.data.path}
            onClick={() => onSelect(d.data.path)}
            onDoubleClick={() => {
              if (isDir) onOpen(d.data.path);
            }}
            style={{ cursor: isDir ? 'pointer' : 'default', opacity: dimmed ? 0.12 : undefined }}
          >
            {/* 原生 tooltip：完整路径 + 精确大小（截断标签的补偿）+ 判定理由 */}
            <title>
              {`${d.data.path}\n${formatBytes(d.data.size)} · ${d.data.file_count.toLocaleString()} 文件${
                entry ? `\n${VERDICT_META[entry.verdict].label} · ${entry.reason}` : ''
              }`}
            </title>
            <rect
              x={x}
              y={y}
              width={w}
              height={h}
              fill={fill}
              fillOpacity={d.depth === 1 ? 0.35 : 0.72}
              stroke={isSelected ? 'var(--treemap-stroke-selected)' : 'var(--treemap-stroke)'}
              strokeWidth={isSelected ? 2 : 1}
            />
            {/* 判定染色（spec §3）：uncertain = 白 + 虚线边；其余 = 左缘 4px 判定色条
                （不替换尺寸语义；语义色 CSS 变量暗色自适应） */}
            {entry && entry.verdict === 'uncertain' ? (
              <rect
                x={x + 1} y={y + 1} width={Math.max(1, w - 2)} height={Math.max(1, h - 2)}
                fill="none" stroke={VERDICT_META.uncertain.color} strokeWidth={1.5} strokeDasharray="4 3"
              />
            ) : entry ? (
              /* §2b-12 选中态差异化：选中描边 2px 画在块缘，判定条内缩 2px，
                 两者同现时左缘不互相覆盖（外圈 accent 描边 + 内侧判定条都可见） */
              <rect
                x={isSelected ? x + 2 : x}
                y={y}
                width={4}
                height={h}
                fill={VERDICT_META[entry.verdict].color}
              />
            ) : null}
            {/* 祖先聚合徽标「🟢 X GB」：depth1 画在标题条内右端，depth2 画在块右上角 */}
            {showPill && (
              <g className="tm-pill">
                <rect
                  className="tm-pill-bg"
                  x={x + w - pillW - 4}
                  y={y + (d.depth === 1 ? 2 : 3)}
                  width={pillW}
                  height={13}
                  rx={6.5}
                />
                <circle className="tm-pill-dot" cx={x + w - pillW + 3.5} cy={y + (d.depth === 1 ? 8.5 : 9.5)} r={2.8} />
                <text
                  className="tm-pill-text"
                  x={x + w - pillW + 8.5}
                  y={y + (d.depth === 1 ? 11.8 : 12.8)}
                >
                  {pillLabel}
                </text>
              </g>
            )}
            {/* 父块标签：画在 16px 标题条内（paddingTop 保证子块不侵入）；挂徽标时右侧让位 */}
            {d.depth === 1 && w > 56 && (
              <text x={x + 6} y={y + 12} fill="var(--treemap-ink)" fontSize={10.5} fontWeight={700}>
                {fit(d.data.name, showPill ? w - pillW - 12 : w, 10.5)}
              </text>
            )}
            {/* 子块标签 */}
            {d.depth === 2 && w > 62 && h > 19 && (
              <text x={x + 6} y={y + 14} fill="var(--treemap-ink)" fontSize={11} fontWeight={700}>
                {fit(d.data.name, showPill ? w - pillW - 12 : w, 11)}
              </text>
            )}
            {d.depth === 2 && w > 62 && h > 33 && (
              <text x={x + 6} y={y + 27} fill="var(--treemap-ink-soft)" fontSize={10}>
                {fit(formatBytes(d.data.size), w, 10)}
              </text>
            )}
          </g>
        );
      })}
    </svg>
  );
}
