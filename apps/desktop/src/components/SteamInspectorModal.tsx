import { useEffect } from 'react';
import { X } from 'lucide-react';
import { SteamInspector } from './SteamInspector';
import { ErrorBoundary } from './ErrorBoundary';

/// Modal wrapper for the Steam Inspector. Click backdrop or press Esc to
/// close. The Inspector itself owns its three-column layout, keyboard
/// shortcuts, and lifecycle — this wrapper only provides the dialog chrome.
export function SteamInspectorModal({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      // Inspector swallows Esc when its detail rail or search input has
      // focus; that close gets handled inside. The window-level Esc here
      // fires when nothing inside the inspector consumed it.
      if (e.key === 'Escape') {
        const inEditable =
          e.target instanceof HTMLInputElement ||
          e.target instanceof HTMLTextAreaElement ||
          ((e.target as HTMLElement | null)?.isContentEditable ?? false);
        if (!inEditable) onClose();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      className="steam-modal-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="steam-modal-dialog" role="dialog" aria-modal="true" aria-label="Steam Inspector">
        <div className="steam-modal-head">
          <div className="steam-modal-title">🎮 Steam Inspector</div>
          <div className="steam-modal-subtitle">查看你的 Steam 库 · 哪些游戏占地大、好久没玩</div>
          <button className="steam-modal-close" onClick={onClose} title="关闭 (Esc)">
            <X size={16} />
          </button>
        </div>
        <div className="steam-modal-body">
          <ErrorBoundary fallbackLabel="Steam Inspector 渲染失败">
            <SteamInspector />
          </ErrorBoundary>
        </div>
      </div>
    </div>
  );
}
