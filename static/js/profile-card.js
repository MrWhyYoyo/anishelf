// "Download card": draws the profile as a 1200x630 PNG on a <canvas> and downloads it.
// Every picture is loaded through /img (same origin), so the canvas stays "clean" and
// toBlob() is allowed. A picture from another site would "taint" the canvas and block the export.
import { imgUrl, displayTitle } from './ui.js';

const W = 1200;
const H = 630;
const BANNER_H = 260;
const FONT = 'Inter, system-ui, -apple-system, "Segoe UI", sans-serif';
const IMAGE_TIMEOUT_MS = 8000;

/** Load one picture. Resolves to the <img>, or null if it fails or takes too long. */
function loadImage(url) {
  const src = imgUrl(url);
  if (!src) return Promise.resolve(null);
  return new Promise((resolve) => {
    const img = new Image();
    const timer = setTimeout(() => resolve(null), IMAGE_TIMEOUT_MS);
    img.onload = () => { clearTimeout(timer); resolve(img); };
    img.onerror = () => { clearTimeout(timer); resolve(null); };
    img.src = src;
  });
}

/**
 * Draw `img` so it covers the box completely (like CSS object-fit: cover).
 * posY (0-100) picks which part shows vertically, like object-position: 50% posY%.
 */
function drawCover(ctx, img, x, y, w, h, posY = 50) {
  const scale = Math.max(w / img.naturalWidth, h / img.naturalHeight);
  const drawW = img.naturalWidth * scale;
  const drawH = img.naturalHeight * scale;
  const offsetX = (w - drawW) / 2;
  const offsetY = (h - drawH) * (posY / 100);
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.clip();
  ctx.drawImage(img, x + offsetX, y + offsetY, drawW, drawH);
  ctx.restore();
}

function roundedRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** Shorten text with an ellipsis until it fits maxWidth (with a hard stop on the loop). */
function fitText(ctx, text, maxWidth) {
  let value = String(text || '');
  if (ctx.measureText(value).width <= maxWidth) return value;
  let guard = 0;
  while (value.length > 1 && ctx.measureText(`${value}…`).width > maxWidth && guard < 200) {
    value = value.slice(0, -1);
    guard += 1;
  }
  return `${value.trimEnd()}…`;
}

function fmt(n, digits = 0) {
  const value = Number(n);
  if (!Number.isFinite(value)) return '—';
  return value.toLocaleString(undefined, { maximumFractionDigits: digits, minimumFractionDigits: 0 });
}

/**
 * Builds the card and starts the download.
 * data: { me, level (/api/profile), stats (/api/stats), top5: [Entry], accent: '#rrggbb' }
 */
export async function downloadProfileCard({ me, level, stats, top5 = [], accent = '#ff5a36' }) {
  // Make sure Inter is ready, otherwise the canvas silently falls back to another font.
  try {
    await Promise.all([document.fonts.load(`600 40px ${FONT}`), document.fonts.load(`400 18px ${FONT}`)]);
  } catch { /* fonts API missing: the fallback font is fine */ }

  // Load every picture at the same time (at most 1 banner + 1 avatar + 5 covers).
  const banner = me && me.banner ? me.banner : null;
  const [bannerImg, avatarImg, ...coverImgs] = await Promise.all([
    banner ? loadImage(banner.image) : Promise.resolve(null),
    me && me.avatar ? loadImage(me.avatar.image) : Promise.resolve(null),
    ...top5.slice(0, 5).map((entry) => loadImage(entry.meta.image)),
  ]);

  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');

  // ground
  ctx.fillStyle = '#000000';
  ctx.fillRect(0, 0, W, H);

  // banner: a flat, dimmed picture with the one neutral scrim
  if (bannerImg) {
    drawCover(ctx, bannerImg, 0, 0, W, BANNER_H, banner.position_y ?? 50);
    ctx.fillStyle = 'rgba(0, 0, 0, 0.45)';
    ctx.fillRect(0, 0, W, BANNER_H);
  } else {
    ctx.fillStyle = '#111111';
    ctx.fillRect(0, 0, W, BANNER_H);
  }

  // avatar: a circle overlapping the banner edge, with a black ring like the cover on the detail page
  const ax = 64;
  const ay = BANNER_H - 84;
  const size = 168;
  ctx.fillStyle = '#000000';
  ctx.beginPath();
  ctx.arc(ax + size / 2, ay + size / 2, size / 2 + 6, 0, Math.PI * 2);
  ctx.fill();
  ctx.save();
  ctx.beginPath();
  ctx.arc(ax + size / 2, ay + size / 2, size / 2, 0, Math.PI * 2);
  ctx.clip();
  if (avatarImg) {
    drawCover(ctx, avatarImg, ax, ay, size, size, 22);
  } else {
    ctx.fillStyle = '#2a2a2a';
    ctx.fillRect(ax, ay, size, size);
    ctx.fillStyle = '#ffffff';
    ctx.font = `600 64px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const initial = Array.from(String((me && me.display_name) || '?').trim() || '?')[0].toUpperCase();
    ctx.fillText(initial, ax + size / 2, ay + size / 2 + 2);
  }
  ctx.restore();
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';

  // name, title, level bar
  const tx = 264;
  ctx.fillStyle = '#ffffff';
  ctx.font = `600 40px ${FONT}`;
  ctx.fillText(fitText(ctx, (me && me.display_name) || 'Anime Fan', 520), tx, BANNER_H + 52);
  ctx.fillStyle = '#b4b4b4';
  ctx.font = `400 20px ${FONT}`;
  const titleLine = level ? `${level.title} · Level ${level.level}` : '';
  ctx.fillText(fitText(ctx, titleLine, 520), tx, BANNER_H + 86);
  const pct = level ? Math.min(1, Math.max(0, Number(level.progress) || 0)) : 0;
  ctx.fillStyle = '#2a2a2a';
  ctx.fillRect(tx, BANNER_H + 104, 360, 4);
  ctx.fillStyle = accent; // the data hue marks the level progress, like in the app
  ctx.fillRect(tx, BANNER_H + 104, 360 * pct, 4);

  // two numbers on the right
  const kpis = [
    { value: fmt(stats && stats.hours_watched, 1), label: 'hours watched' },
    { value: fmt(stats && stats.status_counts ? stats.status_counts.completed : null), label: 'completed' },
  ];
  kpis.forEach((kpi, i) => {
    const kx = 860 + i * 170;
    ctx.fillStyle = '#ffffff';
    ctx.font = `600 36px ${FONT}`;
    ctx.fillText(kpi.value, kx, BANNER_H + 56);
    ctx.fillStyle = '#949494';
    ctx.font = `400 16px ${FONT}`;
    ctx.fillText(kpi.label, kx, BANNER_H + 82);
  });

  // Top 5 shelf: numbered covers
  const shelfY = BANNER_H + 150;
  const coverW = 128;
  const coverH = 192; // 2:3
  ctx.fillStyle = '#ffffff';
  ctx.font = `600 18px ${FONT}`;
  ctx.fillText('Top 5', 64, shelfY - 14);
  for (let i = 0; i < 5; i += 1) {
    const cx = 64 + i * (coverW + 16);
    const entry = top5[i];
    const img = coverImgs[i];
    ctx.save();
    roundedRect(ctx, cx, shelfY, coverW, coverH, 8);
    ctx.clip();
    ctx.fillStyle = entry ? '#111111' : '#0b0b0b';
    ctx.fillRect(cx, shelfY, coverW, coverH);
    if (img) drawCover(ctx, img, cx, shelfY, coverW, coverH, 50);
    else if (entry) {
      ctx.fillStyle = '#949494';
      ctx.font = `500 14px ${FONT}`;
      ctx.fillText(fitText(ctx, displayTitle(entry.meta), coverW - 20), cx + 10, shelfY + coverH - 14);
    }
    ctx.restore();
    if (!entry) {
      ctx.strokeStyle = '#2a2a2a';
      ctx.lineWidth = 1;
      roundedRect(ctx, cx + 0.5, shelfY + 0.5, coverW - 1, coverH - 1, 8);
      ctx.stroke();
    }
    // rank number on a small black tab in the corner
    ctx.fillStyle = '#000000';
    roundedRect(ctx, cx + 6, shelfY + 6, 28, 28, 6);
    ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.font = `600 16px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.fillText(String(i + 1), cx + 20, shelfY + 26);
    ctx.textAlign = 'left';
  }

  // featured badges as plain text marks, and the app name
  const showcase = Array.isArray(level && level.badges) && Array.isArray(me && me.showcase)
    ? me.showcase.map((id) => level.badges.find((b) => b.id === id && b.earned)).filter(Boolean)
    : [];
  let by = shelfY + 10;
  showcase.slice(0, 3).forEach((badge) => {
    ctx.fillStyle = accent;
    ctx.beginPath();
    ctx.arc(864, by - 6, 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.font = `500 18px ${FONT}`;
    ctx.fillText(fitText(ctx, badge.name, 260), 878, by);
    by += 34;
  });
  ctx.fillStyle = '#949494';
  ctx.font = `600 16px ${FONT}`;
  ctx.textAlign = 'right';
  ctx.fillText('AniShelf', W - 64, H - 36);
  ctx.textAlign = 'left';

  // Turn the canvas into a PNG file and click a temporary download link.
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
  if (!blob) throw new Error("Couldn't create the image");
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  const safeName = String((me && me.display_name) || 'profile').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'profile';
  link.download = `anishelf-${safeName}.png`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
