import { useEffect, useRef } from 'react';
import { ExternalLink } from 'lucide-react';

export interface ContextMenuItem {
  label: string;
  icon?: React.ReactNode;
  onClick: () => void;
  danger?: boolean;
}

export interface ContextMenuState {
  x: number;
  y: number;
  items: ContextMenuItem[];
}

type Props = {
  state: ContextMenuState | null;
  onClose: () => void;
};

export function ContextMenu({ state, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!state) return;
    const handleDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const handleEsc = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    const handleScroll = () => onClose();
    window.addEventListener('mousedown', handleDown, true);
    window.addEventListener('keydown', handleEsc);
    window.addEventListener('scroll', handleScroll, true);
    window.addEventListener('blur', onClose);
    return () => {
      window.removeEventListener('mousedown', handleDown, true);
      window.removeEventListener('keydown', handleEsc);
      window.removeEventListener('scroll', handleScroll, true);
      window.removeEventListener('blur', onClose);
    };
  }, [state, onClose]);

  if (!state) return null;

  const W = 220;
  const H = state.items.length * 30 + 8;
  const x = Math.min(state.x, window.innerWidth - W - 4);
  const y = Math.min(state.y, window.innerHeight - H - 4);

  return (
    <div
      ref={ref}
      className="ctxmenu"
      style={{ left: x, top: y, width: W }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {state.items.map((it, i) => (
        <button
          key={i}
          className={'ctxmenu-item' + (it.danger ? ' danger' : '')}
          onClick={() => { it.onClick(); onClose(); }}
        >
          <span className="ctxmenu-icon">{it.icon ?? <ExternalLink size={12} />}</span>
          <span>{it.label}</span>
        </button>
      ))}
    </div>
  );
}
