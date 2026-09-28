import { useEffect, useRef, useState } from 'react';
import {
  ArrowRightLeft, CircleCheck, CircleHelp, FileCode, Flame, FolderOpen, Package, Shield, Trash2, X,
  type LucideIcon,
} from 'lucide-react';
import type { Node } from '../types';
import { api } from '../api';
import { useStore } from '../store';
import { formatBytes, formatCount } from '../format';
import { VERDICT_META, type Verdict, type VerdictEntry } from '../triage-cache';
import { DraftScaffoldModal } from './DraftScaffoldModal';
import { MigrateModal } from './MigrateModal';

// 详情卡（triage-overlay-spec §2.0：单击块 → 选中 → 详情卡浮于地图角落，不遮挡）。
// 动作闭环（spec §2 流程图 + §3 表 + §5）：
// - [清理]：有脚本覆盖 → 跳对应清理脚本 tab；无脚本覆盖的 safe 目录 → 一键回收
//   （两步确认，armed 纪律与 TriageView/TreeView 同款，禁 window.confirm）；
// - [忽略此判定]：AI 判定的反馈闭环（spec §5.3）；
// - [让 AI 起草脚本]：可清理但无脚本覆盖（spec §5.1，起草 + 红线门禁）；
// - 迁移判定给 v1 纯文案建议（spec §7 决策 3，BlueTidy 深链在 v2）。
// 无 overlay 时同一套语义也成立：无判定条目则显示「未判定」，节点信息照常可读。

const VERDICT_ICONS: Record<Verdict, LucideIcon> = {
  safe: CircleCheck,
  decide: Flame,
  migrate: ArrowRightLeft,
  system: Shield,
  uncertain: CircleHelp,
};

const MIGRATE_NOTE = '此类目录适合用搬家工具整体迁移到其他磁盘，为 C 盘腾出空间。迁移比删除更安全：程序与数据都保留。';

type Props = {
  node: Node;
  /** null = 该路径无判定（未命中规则且未过阈值 / 文件） */
  entry: VerdictEntry | null;
  /** 子树内可清理字节聚合（祖先聚合徽标同源，spec §2.1.1） */
  cleanableBytes: number;
  /** 「进入目录」可用性：目录且还有子项可下钻 */
  canEnter: boolean;
  /** AI 判定才可忽略（spec §5.3 反馈入库；规则判定不可忽略） */
  canIgnore: boolean;
  onIgnore: () => void;
  /** 有脚本覆盖的 safe 目录：跳对应清理脚本 tab（spec §3「跳清理 tab」） */
  scriptName: string | null;
  onJumpToScript: (scaffoldName: string) => void;
  onEnter: () => void;
  onClose: () => void;
};

export function BlockDetailCard({
  node, entry, cleanableBytes, canEnter, canIgnore, onIgnore, scriptName, onJumpToScript, onEnter, onClose,
}: Props) {
  const addReclaimed = useStore((s) => s.addReclaimed);
  const meta = entry ? VERDICT_META[entry.verdict] : null;
  const IconCmp: LucideIcon = entry ? VERDICT_ICONS[entry.verdict] : CircleHelp;

  // ── [清理] 一键回收（无脚本覆盖分支）：两步确认纪律（CLAUDE.md 硬规则 3）──
  const [armed, setArmed] = useState(false);
  const [recycleBusy, setRecycleBusy] = useState(false);
  const [recycleErr, setRecycleErr] = useState<string | null>(null);
  const [recycleDone, setRecycleDone] = useState(false);
  const armTimer = useRef<number | null>(null);
  useEffect(() => () => {
    if (armTimer.current !== null) window.clearTimeout(armTimer.current);
  }, []);

  const canCleanup = entry?.verdict === 'safe' && node.is_dir && !recycleDone;
  const recycle = async () => {
    if (recycleBusy) return;
    if (!armed) {
      setRecycleErr(null);
      setArmed(true);
      if (armTimer.current !== null) window.clearTimeout(armTimer.current);
      armTimer.current = window.setTimeout(() => {
        armTimer.current = null;
        setArmed(false);
      }, 5000);
      return;
    }
    if (armTimer.current !== null) {
      window.clearTimeout(armTimer.current);
      armTimer.current = null;
    }
    setArmed(false);
    setRecycleBusy(true);
    try {
      await api.execute(
        { action: 'recycle', paths: [node.path], reason: `详情卡清理：${entry?.reason ?? '判定为可清理'}` },
        false,
      );
      addReclaimed(node.size);
      setRecycleDone(true);
    } catch (e) {
      setRecycleErr(String(e));
    } finally {
      setRecycleBusy(false);
    }
  };

  // ── [让 AI 起草脚本]（spec §5.1）：可清理但无脚本覆盖 ──
  const canDraft = entry?.verdict === 'safe' && node.is_dir && !node.scaffold_id && !recycleDone;
  const [draftOpen, setDraftOpen] = useState(false);

  // ── [迁移到…]（v26.1.4.0 §2.2）：migrate 判定行内置化，目标盘选择 + 进度 ──
  const canMigrate = entry?.verdict === 'migrate' && node.is_dir && !recycleDone;
  const [migrateOpen, setMigrateOpen] = useState(false);

  return (
    <div className="block-detail-card" role="dialog" aria-label="目录详情卡">
      <div className="bdc-head">
        <span
          className="bdc-verdict"
          style={{ color: meta ? meta.color : 'var(--fg-muted)' }}
          title={meta ? meta.description : '未命中规则，也未达到决策阈值'}
        >
          <IconCmp size={15} />
          {meta ? meta.label : '未判定'}
        </span>
        {entry?.source === 'ai' && <span className="bdc-src" title="AI 批量分诊判定 · 理由见下">AI</span>}
        <span className="grow" />
        <button className="bdc-close" aria-label="关闭详情卡" title="关闭" onClick={onClose}>
          <X size={13} />
        </button>
      </div>
      <div className="bdc-name" title={node.name}>{node.name || node.path}</div>
      <div className="bdc-path path-clip" title={node.path}>{node.path}</div>
      <div className="bdc-stats">
        <span>{formatBytes(node.size)}</span>
        <span>{formatCount(node.file_count)} 文件</span>
      </div>
      {entry ? (
        <div className="bdc-reason">{entry.reason}</div>
      ) : (
        node.is_dir && <div className="bdc-reason">未命中规则 — 可用工具行「AI 分诊」让 AI 判定</div>
      )}
      {entry?.verdict === 'migrate' && (
        <div className="bdc-migrate" title="建议迁移（v1 纯文案）">{MIGRATE_NOTE}</div>
      )}
      {cleanableBytes > 0 && entry?.verdict !== 'safe' && (
        <div className="bdc-cleanable" title="子树内可清理字节的聚合">
          <span className="bdc-dot" aria-hidden />
          内含可清理 {formatBytes(cleanableBytes)}
        </div>
      )}
      {recycleDone && (
        <div className="bdc-recycled">已移入回收站（可还原）· 条目等下次扫描后消失</div>
      )}
      {recycleErr && <div className="error">{recycleErr}</div>}
      <div className="bdc-actions">
        {canCleanup && (scriptName ? (
          <button
            className="btn primary bdc-clean"
            title={`打开清理脚本「${scriptName}」，按 scope 细选清理`}
            onClick={() => onJumpToScript(scriptName)}
          >
            <Package size={13} /> 清理
          </button>
        ) : (
          <button
            className={'btn danger bdc-clean' + (armed ? ' armed' : '')}
            disabled={recycleBusy}
            title={armed ? '5 秒内再点一次执行' : '点一次进入预备状态，再点一次才执行（移入回收站，可还原）'}
            onClick={() => void recycle()}
          >
            <Trash2 size={13} /> {armed ? '再点一次确认回收' : recycleBusy ? '回收中…' : '一键回收'}
          </button>
        ))}
        {canDraft && (
          <button className="btn ghost bdc-draft" title="AI 按 14-phase 裁剪版起草清理脚本，自动跑红线检查" onClick={() => setDraftOpen(true)}>
            <FileCode size={13} /> 让 AI 起草脚本
          </button>
        )}
        {canMigrate && (
          <button
            className="btn ghost bdc-migrate"
            title="选一个目标盘整体迁移（同盘改名瞬时 / 跨盘复制+校验，通过才删源）"
            onClick={() => setMigrateOpen(true)}
          >
            <ArrowRightLeft size={13} /> 迁移到…
          </button>
        )}
        {canIgnore && (
          <button
            className="btn ghost bdc-ignore"
            title="不认可这条 AI 判定？忽略后此目录不再上 AI 色，反馈会记入本地缓存，下次 AI 判定时会带上「用户曾忽略」提示"
            onClick={onIgnore}
          >
            忽略此判定
          </button>
        )}
        {node.is_dir && (
          <button
            className="btn ghost bdc-enter"
            disabled={!canEnter}
            title={canEnter ? '下钻进该目录' : '没有可进入的子目录'}
            onClick={onEnter}
          >
            <FolderOpen size={13} /> 进入目录
          </button>
        )}
      </div>
      {draftOpen && <DraftScaffoldModal node={node} onClose={() => setDraftOpen(false)} />}
      {migrateOpen && <MigrateModal paths={[node.path]} onClose={() => setMigrateOpen(false)} />}
    </div>
  );
}
