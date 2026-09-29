/** Fondo sintético del local (modo simulado o sin cuadro de cámara). */
export function drawBackground(ctx: CanvasRenderingContext2D, w: number, h: number) {
  const g = ctx.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, "#111114");
  g.addColorStop(1, "#0b0b0d");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);

  // Piso en perspectiva.
  ctx.strokeStyle = "rgba(255,255,255,0.035)";
  ctx.lineWidth = 1;
  for (let i = 0; i <= 16; i++) {
    const x = (i / 16) * w;
    ctx.beginPath();
    ctx.moveTo(w / 2 + (x - w / 2) * 0.55, h * 0.12);
    ctx.lineTo(x, h);
    ctx.stroke();
  }
  for (let i = 0; i <= 10; i++) {
    const y = h * 0.12 + (h * 0.88 * (i / 10)) ** 1.0;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(w, y);
    ctx.stroke();
  }

  // Góndolas.
  ctx.fillStyle = "rgba(255,255,255,0.045)";
  ctx.strokeStyle = "rgba(255,255,255,0.08)";
  const shelves: [number, number, number, number][] = [
    [0.06, 0.2, 0.38, 0.05],
    [0.06, 0.42, 0.38, 0.05],
    [0.06, 0.64, 0.38, 0.05],
  ];
  for (const [x, y, sw, sh] of shelves) {
    ctx.beginPath();
    ctx.roundRect(x * w, y * h, sw * w, sh * h, 4);
    ctx.fill();
    ctx.stroke();
  }

  // Mostrador / caja.
  ctx.fillStyle = "rgba(244,63,94,0.10)";
  ctx.strokeStyle = "rgba(244,63,94,0.35)";
  ctx.beginPath();
  ctx.roundRect(0.7 * w, 0.18 * h, 0.26 * w, 0.07 * h, 6);
  ctx.fill();
  ctx.stroke();

  ctx.font = "500 11px 'IBM Plex Sans', sans-serif";
  ctx.fillStyle = "rgba(228,228,231,0.45)";
  ctx.fillText("CAJA", 0.71 * w + 8, 0.18 * h + 18);
  ctx.fillText("ENTRADA", 0.04 * w, h - 10);

  // Puerta.
  ctx.strokeStyle = "rgba(228,228,231,0.25)";
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(0.03 * w, h - 2);
  ctx.lineTo(0.2 * w, h - 2);
  ctx.stroke();
}
