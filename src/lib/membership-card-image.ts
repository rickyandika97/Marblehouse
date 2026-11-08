/** Shared canvas artwork: the on-screen card and saved PNG use the same image. */
export interface MembershipCardArtwork {
  name: string;
  memberNumber: string;
}

function nameLines(ctx: CanvasRenderingContext2D, name: string): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of name.trim().split(/\s+/)) {
    if (line && ctx.measureText(`${line} ${word}`).width > 760) {
      lines.push(line);
      line = "";
    }
    for (const character of Array.from(`${line ? " " : ""}${word}`)) {
      if (ctx.measureText(line + character).width > 760) {
        lines.push(line);
        line = "";
      }
      line += character;
    }
  }
  if (line) lines.push(line);
  return lines.length ? lines : [name];
}

/** Brand only the dark finder centers; the 7-module locating rings stay intact. */
function drawRobotFinders(ctx: CanvasRenderingContext2D, x: number, y: number) {
  const { data } = ctx.getImageData(x, y, 600, 600);
  const dark = (px: number, py: number) => data[(py * 600 + px) * 4]! < 32;
  let top = 0;
  while (
    top < 600 &&
    !Array.from({ length: 600 }, (_, px) => dark(px, top)).some(Boolean)
  )
    top++;
  if (top === 600) return;
  let left = 0;
  while (left < 600 && !dark(left, top)) left++;
  let end = left;
  while (end < 600 && dark(end, top)) end++;
  let right = 599;
  while (right > left && !dark(right, top)) right--;
  let bottom = 599;
  while (bottom > top && !dark(left, bottom)) bottom--;
  const size = end - left;
  const moduleSize = size / 7;
  const corners: [number, number][] = [
    [left, top],
    [right - size + 1, top],
    [left, bottom - size + 1],
  ];
  for (const [fx, fy] of corners) {
    ctx.save();
    ctx.translate(x + fx + moduleSize * 2, y + fy + moduleSize * 2);
    ctx.scale(moduleSize, moduleSize);
    ctx.beginPath();
    ctx.rect(0, 0, 3, 3);
    ctx.clip();
    // Keep a solid black cross through each finder center for scan detection.
    ctx.fillStyle = "#000000";
    ctx.fillRect(0, 0, 3, 3);
    ctx.fillStyle = "#cad3dc";
    ctx.beginPath();
    ctx.moveTo(0.35, 0.75);
    ctx.lineTo(0.72, 0.32);
    ctx.lineTo(1.05, 0.25);
    ctx.lineTo(1.05, 1.16);
    ctx.lineTo(0.66, 1.04);
    ctx.closePath();
    ctx.moveTo(2.65, 0.75);
    ctx.lineTo(2.28, 0.32);
    ctx.lineTo(1.95, 0.25);
    ctx.lineTo(1.95, 1.16);
    ctx.lineTo(2.34, 1.04);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = "#ffcf00";
    ctx.beginPath();
    ctx.moveTo(0.5, 1.86);
    ctx.lineTo(1.04, 2.02);
    ctx.lineTo(0.97, 2.5);
    ctx.quadraticCurveTo(0.5, 2.68, 0.5, 1.86);
    ctx.moveTo(2.5, 1.86);
    ctx.lineTo(1.96, 2.02);
    ctx.lineTo(2.03, 2.5);
    ctx.quadraticCurveTo(2.5, 2.68, 2.5, 1.86);
    ctx.fill();
    // Preserve both diagonal locator runs as well as the central cross.
    ctx.strokeStyle = "#000000";
    ctx.lineWidth = 0.32;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(3, 3);
    ctx.moveTo(3, 0);
    ctx.lineTo(0, 3);
    ctx.stroke();
    ctx.restore();
  }
}

export function drawMembershipCard(
  canvas: HTMLCanvasElement,
  logo: CanvasImageSource,
  qr: CanvasImageSource,
  card: MembershipCardArtwork,
): void {
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Card canvas unavailable");
  ctx.font = "700 54px Arial, sans-serif";
  const lines = nameLines(ctx, card.name);
  const extraHeight = (lines.length - 1) * 64;
  canvas.width = 960;
  canvas.height = 1320 + extraHeight;

  // A transparent outer margin preserves rounded corners in the saved PNG.
  const rounded = (
    x: number,
    y: number,
    width: number,
    height: number,
    radius: number,
  ) => {
    ctx.beginPath();
    ctx.roundRect(x, y, width, height, radius);
  };
  ctx.save();
  rounded(16, 16, 928, canvas.height - 32, 48);
  ctx.clip();
  ctx.fillStyle = "#f7f6f3";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, 960, 318);
  // Preserve the supplied logo's proportions; white blends into the header.
  ctx.drawImage(logo, 310, 46, 340, 249);
  ctx.fillStyle = "#e8e6e1";
  ctx.fillRect(72, 318, 816, 1);

  ctx.textAlign = "center";
  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = "#bd2925";
  ctx.font = "700 19px Arial, sans-serif";
  ctx.fillText("M E M B E R S H I P", 480, 371);
  ctx.fillStyle = "#1c1c1c";
  ctx.font = "700 54px Arial, sans-serif";
  lines.forEach((line, index) => ctx.fillText(line, 480, 436 + index * 64));

  // Round the surrounding frame while preserving the QR's full quiet zone.
  ctx.save();
  ctx.shadowColor = "rgba(28, 28, 28, 0.07)";
  ctx.shadowBlur = 32;
  ctx.shadowOffsetY = 10;
  rounded(160, 480 + extraHeight, 640, 700, 36);
  ctx.fillStyle = "#ffffff";
  ctx.fill();
  ctx.restore();
  ctx.strokeStyle = "#e8e6e1";
  ctx.lineWidth = 1;
  rounded(160, 480 + extraHeight, 640, 700, 36);
  ctx.stroke();
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(qr, 180, 500 + extraHeight, 600, 600);
  drawRobotFinders(ctx, 180, 500 + extraHeight);

  ctx.font = "400 21px Arial, sans-serif";
  const memberLabel = `MEMBER  ${card.memberNumber}`;
  const pillWidth = ctx.measureText(memberLabel).width + 44;
  rounded(480 - pillWidth / 2, 1114 + extraHeight, pillWidth, 42, 21);
  ctx.fillStyle = "#eeece7";
  ctx.fill();
  ctx.fillStyle = "#686760";
  ctx.fillText(memberLabel, 480, 1142 + extraHeight);

  ctx.fillStyle = "#494943";
  ctx.font = "400 23px Arial, sans-serif";
  ctx.fillText("Present this card when you visit.", 480, 1230 + extraHeight);
  ctx.fillStyle = "#8a8982";
  ctx.font = "400 20px Arial, sans-serif";
  ctx.fillText("Keep your QR private.", 480, 1267 + extraHeight);
  ctx.restore();
  ctx.strokeStyle = "#e4e2dc";
  ctx.lineWidth = 2;
  rounded(17, 17, 926, canvas.height - 34, 47);
  ctx.stroke();
}

export async function createMembershipCardImage(
  card: MembershipCardArtwork & { qr: string },
): Promise<string> {
  const load = (src: string) =>
    new Promise<HTMLImageElement>((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = reject;
      image.src = src;
    });
  const [logo, qr] = await Promise.all([
    load("/redlight-pinball.png"),
    load(card.qr),
  ]);
  const canvas = document.createElement("canvas");
  drawMembershipCard(canvas, logo, qr, card);
  return canvas.toDataURL("image/png");
}
