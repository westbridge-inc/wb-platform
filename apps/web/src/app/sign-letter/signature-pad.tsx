'use client';

import { useEffect, useRef, useState } from 'react';

/**
 * [COMPANY-DOCS PART 2] A signature drawn with a finger (or a mouse, or a pen): a plain canvas, no library. The
 * canvas keeps the page from scrolling while the finger draws (touch-action: none). It reports the drawing as a PNG
 * data URL after every stroke, or null once cleared; the server checks it is a real, non-blank PNG and re-encodes it.
 */
export function SignaturePad({ label, onChange }: { label: string; onChange: (_png: string | null) => void }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const drawing = useRef(false);
  const last = useRef<{ x: number; y: number } | null>(null);
  const [inked, setInked] = useState(false);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    // The backing store follows the screen's density (sharp lines), capped so the picture stays small.
    const ratio = Math.min(3, typeof window !== 'undefined' && window.devicePixelRatio ? window.devicePixelRatio : 1);
    const width = canvas.clientWidth || 480;
    const height = canvas.clientHeight || 180;
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.scale(ratio, ratio);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.lineWidth = 2.5;
    ctx.strokeStyle = '#111827';
  }, []);

  const point = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };

  const stroke = (to: { x: number; y: number }) => {
    const ctx = canvasRef.current?.getContext('2d');
    const from = last.current ?? to;
    if (ctx) {
      ctx.beginPath();
      ctx.moveTo(from.x, from.y);
      ctx.lineTo(to.x + (from === to ? 0.01 : 0), to.y);
      ctx.stroke();
    }
    last.current = to;
  };

  const finish = () => {
    if (!drawing.current) return;
    drawing.current = false;
    last.current = null;
    setInked(true);
    onChange(canvasRef.current?.toDataURL('image/png') ?? null);
  };

  const clear = () => {
    const canvas = canvasRef.current;
    canvas?.getContext('2d')?.clearRect(0, 0, canvas.width, canvas.height);
    setInked(false);
    onChange(null);
  };

  return (
    <div className="flex flex-col gap-2">
      <canvas
        ref={canvasRef}
        role="img"
        aria-label={label}
        data-signature-pad
        className="h-44 w-full rounded-xl border-2 border-dashed border-[var(--swift-border)] bg-white"
        style={{ touchAction: 'none' }}
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture?.(e.pointerId);
          drawing.current = true;
          stroke(point(e));
        }}
        onPointerMove={(e) => { if (drawing.current) stroke(point(e)); }}
        onPointerUp={finish}
        onPointerCancel={finish}
        onPointerLeave={finish}
      />
      <div className="flex items-center justify-between text-xs text-[var(--swift-muted)]">
        <span>{inked ? 'Signed above.' : 'Sign above with your finger.'}</span>
        <button type="button" className="sw-link-btn" onClick={clear} disabled={!inked}>Clear</button>
      </div>
    </div>
  );
}
