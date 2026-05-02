import { useEffect, useRef } from 'react';

type Props = {
  onDrag: (deltaPx: number) => void;
  onDoubleClick?: () => void;
};

export function Splitter({ onDrag, onDoubleClick }: Props) {
  const startX = useRef(0);
  const dragging = useRef(false);

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!dragging.current) return;
      const dx = e.clientX - startX.current;
      startX.current = e.clientX;
      onDrag(dx);
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
  }, [onDrag]);

  return (
    <div
      className="splitter"
      onMouseDown={(e) => {
        dragging.current = true;
        startX.current = e.clientX;
        document.body.style.cursor = 'col-resize';
        document.body.style.userSelect = 'none';
      }}
      onDoubleClick={onDoubleClick}
      title="拖动调整 · 双击重置"
    >
      <span />
    </div>
  );
}
