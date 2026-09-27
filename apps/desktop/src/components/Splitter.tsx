import { useEffect, useRef } from 'react';

type Props = {
  onDrag: (deltaPx: number) => void;
  onDoubleClick?: () => void;
  /** horizontal=左右拖（Side Bar↔Editor，默认，兼容旧用法）；vertical=上下拖（Bottom Panel 高度）。 */
  orientation?: 'horizontal' | 'vertical';
};

export function Splitter({ onDrag, onDoubleClick, orientation = 'horizontal' }: Props) {
  const start = useRef(0);
  const dragging = useRef(false);
  const vertical = orientation === 'vertical';

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!dragging.current) return;
      const delta = vertical ? e.clientY - start.current : e.clientX - start.current;
      start.current = vertical ? e.clientY : e.clientX;
      onDrag(delta);
    };
    const onUp = () => {
      if (!dragging.current) return;
      dragging.current = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [onDrag, vertical]);

  return (
    <div
      className={'splitter' + (vertical ? ' splitter-v' : '')}
      onMouseDown={(e) => {
        dragging.current = true;
        start.current = vertical ? e.clientY : e.clientX;
        document.body.style.cursor = vertical ? 'row-resize' : 'col-resize';
        document.body.style.userSelect = 'none';
      }}
      onDoubleClick={onDoubleClick}
      title="拖动调整 · 双击重置"
    >
      <span />
    </div>
  );
}
