import { useCallback, useEffect, useRef, useState } from 'react';

type RunState = 'idle' | 'running' | 'over';

type Obstacle = {
  x: number;
  width: number;
  height: number;
  lean: number;
};

type Coin = {
  x: number;
  y: number;
  radius: number;
  phase: number;
};

type PowerUpKind = 'magnet' | 'shield' | 'slow' | 'invincible';

type PowerUp = {
  kind: PowerUpKind;
  x: number;
  y: number;
  size: number;
  phase: number;
};

type DustParticle = {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  maxLife: number;
  size: number;
};

type EffectParticle = {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  maxLife: number;
  size: number;
  color: string;
};

type ActivePowerUps = {
  magnet: number;
  shield: boolean;
  slow: number;
  invincible: number;
};

type GameEvent =
  | { type: 'land' }
  | { type: 'hit' }
  | { type: 'coin' }
  | { type: 'powerup'; kind: PowerUpKind }
  | { type: 'shieldBreak' }
  | { type: 'expire'; kind: 'slow' | 'invincible' }
  | null;

type GameData = {
  width: number;
  height: number;
  groundY: number;
  playerX: number;
  playerY: number;
  playerW: number;
  playerH: number;
  velocityY: number;
  playerOnGround: boolean;
  elapsed: number;
  score: number;
  best: number;
  runCoins: number;
  totalCoins: number;
  spawnClock: number;
  nextSpawn: number;
  coinSpawnClock: number;
  nextCoinSpawn: number;
  powerUpSpawnClock: number;
  nextPowerUpSpawn: number;
  obstacles: Obstacle[];
  coins: Coin[];
  powerUps: PowerUp[];
  dust: DustParticle[];
  effects: EffectParticle[];
  activePowerUps: ActivePowerUps;
  slowBlend: number;
  collisionGrace: number;
  collisionFlash: number;
  landingPulse: number;
  impactPulse: number;
  impactX: number;
  impactY: number;
  worldFrom: number;
  worldTo: number;
  worldTransition: number;
};

type DifficultyProfile = {
  level: number;
  speed: number;
  minSpawnGap: number;
  maxSpawnGap: number;
};

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));

const GRAVITY = 2250;
const JUMP_VELOCITY = 825;
const JUMP_FLIGHT_TIME = (JUMP_VELOCITY * 2) / GRAVITY;
const MAGNET_DURATION = 7;
const SLOW_DURATION = 5;
const INVINCIBLE_DURATION = 5;
const WORLD_SCORE_INTERVAL = 150;
const MIN_REACTION_TIME = 0.24;
const LANDING_RECOVERY_TIME = 0.16;
const AIRBORNE_MARGIN = 0.11;
const MAX_PATTERN_ATTEMPTS = 8;
const BEST_SCORE_KEY = 'fork-runner-best';
const TOTAL_COINS_KEY = 'fork-runner-coins';

const POWER_UP_META: Record<
  PowerUpKind,
  { label: string; symbol: string; color: string; duration: number }
> = {
  magnet: { label: 'Magnet', symbol: 'M', color: '#9be5cc', duration: MAGNET_DURATION },
  shield: { label: 'Shield', symbol: 'S', color: '#90c8ff', duration: 0 },
  slow: { label: 'Slow motion', symbol: 'T', color: '#c7a6ee', duration: SLOW_DURATION },
  invincible: { label: 'Invincible', symbol: '✦', color: '#ffd579', duration: INVINCIBLE_DURATION },
};

const readStoredNumber = (key: string) => {
  if (typeof window === 'undefined') return 0;
  try {
    const value = Number(window.localStorage.getItem(key) ?? 0);
    return Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
  } catch {
    return 0;
  }
};

const writeStoredNumber = (key: string, value: number) => {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(key, String(Math.max(0, Math.floor(value))));
  } catch {
    // Gameplay continues if storage is unavailable.
  }
};

const getSafeAirborneWindow = (obstacleHeight: number) => {
  // Collision uses the player's feet, so this is the amount of vertical
  // clearance needed before the fork's collision height is reached.
  const clearance = Math.max(5, obstacleHeight - 5);
  const discriminant = Math.max(
    0,
    JUMP_VELOCITY ** 2 - 2 * GRAVITY * clearance,
  );
  const root = Math.sqrt(discriminant);
  return {
    start: (JUMP_VELOCITY - root) / GRAVITY,
    end: (JUMP_VELOCITY + root) / GRAVITY,
  };
};

const getMinimumSafeForkGap = (
  speed: number,
  forkWidth: number,
  playerW: number,
) => {
  // The gap is derived from the effective obstacle speed and the actual
  // collision widths, rather than being a visual spacing guess. This is the
  // minimum edge-to-edge room needed before a new jump window can be trusted.
  const collisionWidth = forkWidth * 0.46 + playerW * 0.65;
  const motionBuffer = speed * 0.075;
  return Math.max(28, Math.ceil(collisionWidth * 0.18 + motionBuffer));
};

const isPatternAchievable = (
  offsets: number[],
  speed: number,
  forkWidth: number,
  obstacleHeight: number,
  firstX: number,
  playerX: number,
  playerW: number,
) => {
  if (!offsets.length || speed <= 0) return false;

  const safeWindow = getSafeAirborneWindow(obstacleHeight);
  const airborneDuration = safeWindow.end - safeWindow.start - AIRBORNE_MARGIN;
  const minimumGap = getMinimumSafeForkGap(speed, forkWidth, playerW);
  const firstApproachTime =
    (firstX - (playerX + playerW * 0.83)) / speed;

  // A pattern must leave a real human reaction window before its first fork.
  if (firstApproachTime < MIN_REACTION_TIME) return false;

  for (let index = 1; index < offsets.length; index += 1) {
    const edgeGap = offsets[index] - (offsets[index - 1] + forkWidth);
    if (edgeGap < minimumGap) return false;
  }

  // Prefer one normal jump for a pattern. This proves that every fork in the
  // chain fits inside the player's real airborne clearance window.
  const lastOffset = offsets[offsets.length - 1] ?? 0;
  const patternTime = (lastOffset + forkWidth) / speed;
  if (patternTime <= airborneDuration) return true;

  // If a future pattern needs multiple jumps, explicitly require enough
  // landing and reaction time between jump windows. Current candidates usually
  // fail the single-jump test first, but this keeps the validator complete.
  let jumpGroupStart = offsets[0];
  for (let index = 1; index < offsets.length; index += 1) {
    const groupTime =
      (offsets[index] + forkWidth - jumpGroupStart) / speed;
    if (groupTime <= airborneDuration) continue;

    const previousEnd = offsets[index - 1] + forkWidth;
    const recoveryTime = (offsets[index] - previousEnd) / speed;
    if (recoveryTime < LANDING_RECOVERY_TIME + MIN_REACTION_TIME) {
      return false;
    }
    jumpGroupStart = offsets[index];
  }

  return (lastOffset + forkWidth - jumpGroupStart) / speed <= airborneDuration;
};

const getDifficulty = (score: number): DifficultyProfile => {
  const level = score < 60 ? 1 : score < 140 ? 2 : score < 240 ? 3 : score < 380 ? 4 : 5;
  const speed = 290 + 235 * (1 - Math.exp(-score / 390));
  const spawnGaps: Array<[number, number]> = [
    [1.5, 2.3],
    [1.32, 2.08],
    [1.18, 1.88],
    [1.06, 1.7],
    [0.96, 1.58],
  ];
  const [minSpawnGap, maxSpawnGap] = spawnGaps[level - 1] ?? spawnGaps[0];
  return {
    level,
    speed,
    minSpawnGap,
    maxSpawnGap,
  };
};

const makeGame = (best = 0, totalCoins = 0): GameData => ({
  width: 0,
  height: 0,
  groundY: 0,
  playerX: 0,
  playerY: 0,
  playerW: 35,
  playerH: 52,
  velocityY: 0,
  playerOnGround: true,
  elapsed: 0,
  score: 0,
  best,
  runCoins: 0,
  totalCoins,
  spawnClock: 0,
  nextSpawn: 1.48,
  coinSpawnClock: 0,
  nextCoinSpawn: 0.95,
  powerUpSpawnClock: 0,
  nextPowerUpSpawn: 9.5,
  obstacles: [],
  coins: [],
  powerUps: [],
  dust: [],
  effects: [],
  activePowerUps: {
    magnet: 0,
    shield: false,
    slow: 0,
    invincible: 0,
  },
  slowBlend: 1,
  collisionGrace: 0,
  collisionFlash: 0,
  landingPulse: 0,
  impactPulse: 0,
  impactX: 0,
  impactY: 0,
  worldFrom: 0,
  worldTo: 0,
  worldTransition: 1,
});

const roundedRect = (
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
) => {
  const r = Math.min(radius, width / 2, height / 2);
  context.beginPath();
  context.moveTo(x + r, y);
  context.lineTo(x + width - r, y);
  context.quadraticCurveTo(x + width, y, x + width, y + r);
  context.lineTo(x + width, y + height - r);
  context.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
  context.lineTo(x + r, y + height);
  context.quadraticCurveTo(x, y + height, x, y + height - r);
  context.lineTo(x, y + r);
  context.quadraticCurveTo(x, y, x + r, y);
  context.closePath();
};

const drawCloud = (
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  scale: number,
  color = '#fff1d5',
) => {
  context.save();
  context.globalAlpha = 0.13;
  context.fillStyle = color;
  context.beginPath();
  context.ellipse(x, y, 46 * scale, 10 * scale, 0, 0, Math.PI * 2);
  context.ellipse(x - 25 * scale, y + 4 * scale, 25 * scale, 8 * scale, 0, 0, Math.PI * 2);
  context.ellipse(x + 19 * scale, y + 1 * scale, 31 * scale, 11 * scale, 0, 0, Math.PI * 2);
  context.fill();
  context.restore();
};

type WorldTheme = {
  name: string;
  top: string;
  middle: string;
  horizon: string;
  ground: string;
  accent: string;
  atmosphere: string;
};

const WORLD_THEMES: WorldTheme[] = [
  {
    name: 'Sunset Desert',
    top: '#33234a',
    middle: '#a86683',
    horizon: '#67466a',
    ground: '#2b1d3c',
    accent: '#f5bc62',
    atmosphere: '#ffdda0',
  },
  {
    name: 'Night Desert',
    top: '#10182f',
    middle: '#394774',
    horizon: '#293457',
    ground: '#141c35',
    accent: '#90c8ff',
    atmosphere: '#c7d9ff',
  },
  {
    name: 'Moonlit Forest',
    top: '#122d35',
    middle: '#34706b',
    horizon: '#28534f',
    ground: '#142d2f',
    accent: '#a6d3bf',
    atmosphere: '#d2f1ce',
  },
  {
    name: 'Neon City',
    top: '#1d163d',
    middle: '#633c78',
    horizon: '#30224f',
    ground: '#17162d',
    accent: '#ff7ab6',
    atmosphere: '#f6a8ff',
  },
  {
    name: 'Storm Front',
    top: '#111525',
    middle: '#3b405a',
    horizon: '#292d43',
    ground: '#161925',
    accent: '#8fe4e8',
    atmosphere: '#d7e9ef',
  },
];

const hexToRgb = (hex: string) => {
  const value = hex.replace('#', '');
  return {
    r: Number.parseInt(value.slice(0, 2), 16),
    g: Number.parseInt(value.slice(2, 4), 16),
    b: Number.parseInt(value.slice(4, 6), 16),
  };
};

const mixHex = (from: string, to: string, amount: number) => {
  const a = hexToRgb(from);
  const b = hexToRgb(to);
  const t = clamp(amount, 0, 1);
  return `rgb(${Math.round(a.r + (b.r - a.r) * t)}, ${Math.round(
    a.g + (b.g - a.g) * t,
  )}, ${Math.round(a.b + (b.b - a.b) * t)})`;
};

const withAlpha = (rgbColor: string, alpha: number) =>
  rgbColor.replace('rgb(', 'rgba(').replace(')', `, ${alpha})`);

const drawWorldBackdrop = (
  context: CanvasRenderingContext2D,
  game: GameData,
  theme: WorldTheme,
  visualSpeed: number,
) => {
  const { width, height, groundY } = game;
  const detailShift = (game.elapsed * (34 + visualSpeed * 0.07)) % 180;
  const horizon = groundY * 0.7;

  if (theme.name === 'Moonlit Forest') {
    context.save();
    context.globalAlpha = 0.5;
    context.fillStyle = '#183f40';
    for (let index = -1; index < width / 105 + 2; index += 1) {
      const x = index * 105 - detailShift * 0.65;
      const treeHeight = 45 + ((index * 19) % 42);
      context.beginPath();
      context.moveTo(x, groundY);
      context.lineTo(x + 24, groundY - treeHeight);
      context.lineTo(x + 48, groundY);
      context.closePath();
      context.fill();
    }
    context.globalAlpha = 0.28;
    context.fillStyle = '#a6d3bf';
    context.beginPath();
    context.arc(width * 0.78, height * 0.22, 31, 0, Math.PI * 2);
    context.fill();
    context.restore();
  }

  if (theme.name === 'Neon City') {
    context.save();
    context.globalAlpha = 0.55;
    const buildingColors = ['#312255', '#412761', '#542b68'];
    for (let index = -1; index < width / 76 + 2; index += 1) {
      const x = index * 76 - detailShift * 0.4;
      const buildingHeight = 36 + ((index * 31) % 75);
      context.fillStyle = buildingColors[Math.abs(index) % buildingColors.length];
      context.fillRect(x, horizon - buildingHeight, 58, buildingHeight);
      context.fillStyle = index % 2 === 0 ? '#ff7ab6' : '#8fe4e8';
      context.globalAlpha = 0.28;
      for (let row = 0; row < 3; row += 1) {
        context.fillRect(x + 10, horizon - buildingHeight + 12 + row * 17, 7, 3);
        context.fillRect(x + 28, horizon - buildingHeight + 12 + row * 17, 7, 3);
      }
      context.globalAlpha = 0.55;
    }
    context.restore();
  }

  if (theme.name === 'Storm Front') {
    context.save();
    context.globalAlpha = 0.18;
    context.fillStyle = '#c9d8e0';
    for (let index = -1; index < width / 180 + 2; index += 1) {
      const x = index * 180 - detailShift * 0.35;
      context.beginPath();
      context.ellipse(x, height * 0.22 + (index % 2) * 14, 90, 18, 0, 0, Math.PI * 2);
      context.fill();
    }
    if (Math.sin(game.elapsed * 2.1) > 0.92) {
      context.globalAlpha = 0.5;
      context.strokeStyle = '#d7e9ef';
      context.lineWidth = 2;
      context.beginPath();
      context.moveTo(width * 0.62, height * 0.18);
      context.lineTo(width * 0.58, height * 0.34);
      context.lineTo(width * 0.65, height * 0.29);
      context.lineTo(width * 0.61, height * 0.45);
      context.stroke();
    }
    context.restore();
  }
};

const drawFork = (
  context: CanvasRenderingContext2D,
  obstacle: Obstacle,
  groundY: number,
) => {
  const { x, width, height, lean } = obstacle;
  const forkX = x + width * 0.5;
  const forkTop = groundY - height;
  const stemBottom = groundY - 1;
  context.save();
  context.translate(forkX, groundY);
  context.rotate(lean);
  context.translate(-forkX, -groundY);

  context.globalAlpha = 0.24;
  context.fillStyle = '#191329';
  context.beginPath();
  context.ellipse(forkX, groundY + 3, width * 0.72, 4, 0, 0, Math.PI * 2);
  context.fill();

  context.lineCap = 'round';
  context.lineJoin = 'round';
  context.strokeStyle = '#d95f58';
  context.lineWidth = Math.max(5, width * 0.19);
  context.beginPath();
  context.moveTo(forkX, stemBottom);
  context.lineTo(forkX + 1, forkTop + 21);
  context.stroke();

  context.strokeStyle = '#f5bc62';
  context.lineWidth = Math.max(3, width * 0.1);
  context.beginPath();
  context.moveTo(forkX, stemBottom - 1);
  context.lineTo(forkX + 1, forkTop + 19);
  context.stroke();

  context.strokeStyle = '#f5bc62';
  context.lineWidth = Math.max(4, width * 0.12);
  context.beginPath();
  context.moveTo(forkX, forkTop + 24);
  context.lineTo(forkX - width * 0.3, forkTop + 7);
  context.moveTo(forkX, forkTop + 24);
  context.lineTo(forkX + width * 0.3, forkTop + 7);
  context.stroke();

  context.strokeStyle = '#f5bc62';
  context.lineWidth = Math.max(3, width * 0.075);
  for (let index = -1; index <= 1; index += 1) {
    const tineX = forkX + index * width * 0.19;
    context.beginPath();
    context.moveTo(tineX, forkTop + 12);
    context.lineTo(tineX + index * width * 0.025, forkTop - 2);
    context.stroke();
  }

  context.restore();
};

const drawCactus = (
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  scale: number,
) => {
  context.save();
  context.globalAlpha = 0.35;
  context.strokeStyle = '#332445';
  context.lineWidth = 7 * scale;
  context.lineCap = 'round';
  context.beginPath();
  context.moveTo(x, y);
  context.lineTo(x, y - 27 * scale);
  context.moveTo(x, y - 13 * scale);
  context.lineTo(x - 9 * scale, y - 18 * scale);
  context.lineTo(x - 9 * scale, y - 25 * scale);
  context.moveTo(x, y - 7 * scale);
  context.lineTo(x + 10 * scale, y - 13 * scale);
  context.lineTo(x + 10 * scale, y - 20 * scale);
  context.stroke();
  context.restore();
};

const drawCoin = (
  context: CanvasRenderingContext2D,
  coin: Coin,
  elapsed: number,
) => {
  const shimmer = Math.abs(Math.cos(elapsed * 7 + coin.phase));
  const radius = coin.radius;
  context.save();
  context.translate(coin.x, coin.y);
  context.rotate(Math.sin(elapsed * 3.5 + coin.phase) * 0.12);
  context.globalAlpha = 0.18;
  context.fillStyle = '#f5bc62';
  context.beginPath();
  context.arc(0, 0, radius + 7 + shimmer * 3, 0, Math.PI * 2);
  context.fill();
  context.globalAlpha = 1;
  context.scale(0.68 + shimmer * 0.32, 1);
  context.fillStyle = '#f5bc62';
  context.beginPath();
  context.arc(0, 0, radius, 0, Math.PI * 2);
  context.fill();
  context.lineWidth = 2;
  context.strokeStyle = '#fff1d5';
  context.stroke();
  context.fillStyle = '#d95f58';
  context.beginPath();
  context.moveTo(0, -radius * 0.55);
  context.lineTo(radius * 0.28, 0);
  context.lineTo(0, radius * 0.55);
  context.lineTo(-radius * 0.28, 0);
  context.closePath();
  context.fill();
  context.restore();
};

const drawPowerUp = (
  context: CanvasRenderingContext2D,
  powerUp: PowerUp,
  elapsed: number,
) => {
  const meta = POWER_UP_META[powerUp.kind];
  const pulse = 0.88 + Math.sin(elapsed * 5 + powerUp.phase) * 0.12;
  const size = powerUp.size * pulse;
  context.save();
  context.translate(powerUp.x, powerUp.y);
  context.rotate(Math.sin(elapsed * 2.5 + powerUp.phase) * 0.08);
  context.globalAlpha = 0.18;
  context.fillStyle = meta.color;
  context.beginPath();
  context.arc(0, 0, size + 9, 0, Math.PI * 2);
  context.fill();
  context.globalAlpha = 1;
  context.fillStyle = '#2b1d3c';
  context.strokeStyle = meta.color;
  context.lineWidth = 2.5;
  context.beginPath();
  context.arc(0, 0, size, 0, Math.PI * 2);
  context.fill();
  context.stroke();
  context.fillStyle = meta.color;
  context.font = `700 ${Math.max(11, size * 0.78)}px ${'Space Mono'}`;
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  context.fillText(meta.symbol, 0, 1);
  context.restore();
};

const drawRunner = (context: CanvasRenderingContext2D, game: GameData) => {
  const { playerX: x, playerY: y, playerW: width, playerH: height } = game;
  const runCycle = Math.sin(game.elapsed * 18);
  const airborne = !game.playerOnGround;
  const legSwing = airborne ? 0.2 : runCycle * 5;

  context.save();
  context.translate(x, y);

  const effectCenterX = width * 0.5;
  const effectCenterY = height * 0.48;
  if (game.activePowerUps.magnet > 0) {
    context.globalAlpha = 0.28 + Math.sin(game.elapsed * 9) * 0.06;
    context.strokeStyle = '#9be5cc';
    context.lineWidth = 2;
    context.beginPath();
    context.arc(effectCenterX, effectCenterY, width * 0.74, game.elapsed * 2, game.elapsed * 2 + Math.PI * 1.45);
    context.stroke();
    context.beginPath();
    context.arc(effectCenterX, effectCenterY, width * 0.9, -game.elapsed * 1.7, -game.elapsed * 1.7 + Math.PI * 1.15);
    context.stroke();
  }
  if (game.activePowerUps.shield) {
    context.globalAlpha = 0.3 + Math.sin(game.elapsed * 7) * 0.05;
    context.strokeStyle = '#90c8ff';
    context.lineWidth = 2.5;
    context.beginPath();
    context.arc(effectCenterX, effectCenterY, width * 0.88, 0, Math.PI * 2);
    context.stroke();
  }
  if (game.activePowerUps.slow > 0) {
    context.globalAlpha = 0.22;
    context.strokeStyle = '#c7a6ee';
    context.lineWidth = 2;
    context.beginPath();
    context.arc(effectCenterX, effectCenterY, width * (0.8 + Math.sin(game.elapsed * 4) * 0.08), 0, Math.PI * 2);
    context.stroke();
  }
  if (game.activePowerUps.invincible > 0) {
    const flashing = game.activePowerUps.invincible < 1 && Math.sin(game.elapsed * 20) > 0;
    context.globalAlpha = flashing ? 0.16 : 0.42;
    context.fillStyle = '#ffd579';
    context.beginPath();
    context.arc(effectCenterX, effectCenterY, width * 0.86, 0, Math.PI * 2);
    context.fill();
    context.globalAlpha = flashing ? 0.35 : 0.7;
    context.strokeStyle = '#fff1d5';
    context.lineWidth = 2;
    context.beginPath();
    context.arc(effectCenterX, effectCenterY, width * 1.03, game.elapsed * 4, game.elapsed * 4 + Math.PI * 1.6);
    context.stroke();
  }
  context.globalAlpha = 1;

  context.globalAlpha = 0.24;
  context.fillStyle = '#191329';
  context.beginPath();
  context.ellipse(width * 0.5, height + 6, width * 0.62, 5, 0, 0, Math.PI * 2);
  context.fill();

  context.strokeStyle = '#221827';
  context.lineWidth = Math.max(4, width * 0.15);
  context.lineCap = 'round';
  context.beginPath();
  context.moveTo(width * 0.42, height * 0.76);
  context.lineTo(width * 0.35 - legSwing * 0.23, height + 2);
  context.moveTo(width * 0.66, height * 0.76);
  context.lineTo(width * 0.75 + legSwing * 0.23, height + 1);
  context.stroke();

  context.fillStyle = '#e4675a';
  roundedRect(context, width * 0.2, height * 0.3, width * 0.61, height * 0.49, 8);
  context.fill();

  context.fillStyle = '#f08a66';
  roundedRect(context, width * 0.25, height * 0.38, width * 0.1, height * 0.25, 4);
  context.fill();

  context.fillStyle = '#f5bc62';
  context.beginPath();
  context.arc(width * 0.51, height * 0.24, width * 0.27, 0, Math.PI * 2);
  context.fill();

  context.fillStyle = '#2c1d3c';
  context.beginPath();
  context.arc(width * 0.56, height * 0.2, width * 0.27, Math.PI * 1.05, Math.PI * 2.04);
  context.fill();

  context.fillStyle = '#221827';
  context.beginPath();
  context.arc(width * 0.63, height * 0.26, 1.8, 0, Math.PI * 2);
  context.fill();

  context.strokeStyle = '#a6d3bf';
  context.lineWidth = Math.max(3, width * 0.11);
  context.beginPath();
  context.moveTo(width * 0.27, height * 0.43);
  context.quadraticCurveTo(-width * 0.07, height * 0.38, -width * 0.2, height * 0.5);
  context.stroke();

  context.fillStyle = '#f5bc62';
  context.beginPath();
  context.arc(width * 0.22, height * 0.55, width * 0.1, 0, Math.PI * 2);
  context.fill();

  context.strokeStyle = '#a6d3bf';
  context.lineWidth = Math.max(2, width * 0.07);
  context.beginPath();
  context.moveTo(width * 0.3, height * 0.67);
  context.lineTo(width * 0.65, height * 0.67);
  context.stroke();
  context.restore();
};

const drawWorld = (game: GameData, context: CanvasRenderingContext2D) => {
  const { width, height, groundY } = game;
  if (!width || !height) return;
  const difficulty = getDifficulty(game.score);
  const visualSpeed = difficulty.speed * game.slowBlend;
  const fromTheme = WORLD_THEMES[game.worldFrom % WORLD_THEMES.length];
  const toTheme = WORLD_THEMES[game.worldTo % WORLD_THEMES.length];
  const transition = game.worldTransition * game.worldTransition * (3 - game.worldTransition * 2);
  const topColor = mixHex(fromTheme.top, toTheme.top, transition);
  const middleColor = mixHex(fromTheme.middle, toTheme.middle, transition);
  const horizonColor = mixHex(fromTheme.horizon, toTheme.horizon, transition);
  const groundColor = mixHex(fromTheme.ground, toTheme.ground, transition);
  const accentColor = mixHex(fromTheme.accent, toTheme.accent, transition);
  const atmosphereColor = mixHex(fromTheme.atmosphere, toTheme.atmosphere, transition);

  context.clearRect(0, 0, width, height);

  const sky = context.createLinearGradient(0, 0, 0, groundY);
  sky.addColorStop(0, topColor);
  sky.addColorStop(0.55, middleColor);
  sky.addColorStop(1, horizonColor);
  context.fillStyle = sky;
  context.fillRect(0, 0, width, height);

  const sunX = width * 0.78;
  const sunY = height * 0.255;
  const sun = context.createRadialGradient(sunX, sunY, 5, sunX, sunY, Math.max(95, width * 0.15));
  sun.addColorStop(0, withAlpha(atmosphereColor, 0.82));
  sun.addColorStop(0.25, withAlpha(atmosphereColor, 0.25));
  sun.addColorStop(1, 'rgba(255, 208, 132, 0)');
  context.fillStyle = sun;
  context.fillRect(sunX - 170, sunY - 170, 340, 340);
  context.fillStyle = atmosphereColor;
  context.globalAlpha = 0.88;
  context.beginPath();
  context.arc(sunX, sunY, clamp(width * 0.045, 24, 57), 0, Math.PI * 2);
  context.fill();
  context.globalAlpha = 1;

  for (let index = 0; index < 22; index += 1) {
    const starX = ((index * 137 + 31) % 1000) / 1000 * width;
    const starY = (((index * 71 + 17) % 430) / 430) * groundY * 0.53;
    const starSize = index % 4 === 0 ? 1.5 : 0.8;
    context.globalAlpha = (0.28 + (index % 3) * 0.08) * (0.7 + transition * 0.3);
    context.fillStyle = atmosphereColor;
    context.fillRect(starX, starY, starSize, starSize);
  }
  context.globalAlpha = 1;

  const cloudShift = (game.elapsed * (10 + visualSpeed * 0.025)) % (width + 220);
  drawCloud(context, width * 0.13 - cloudShift, height * 0.2, 0.8, atmosphereColor);
  drawCloud(context, width * 0.66 - (cloudShift * 0.65), height * 0.14, 0.55, atmosphereColor);
  drawCloud(context, width + 110 - (cloudShift * 0.36), height * 0.33, 0.68, atmosphereColor);

  const farHorizon = groundY * 0.7;
  context.fillStyle = horizonColor;
  context.globalAlpha = 0.68;
  context.beginPath();
  context.moveTo(0, farHorizon + 18);
  for (let index = 0; index <= 10; index += 1) {
    const mountainX = (index / 10) * width;
    const mountainY = farHorizon - (index % 3 === 1 ? height * 0.11 : height * 0.04);
    context.lineTo(mountainX, mountainY);
  }
  context.lineTo(width, groundY);
  context.lineTo(0, groundY);
  context.closePath();
  context.fill();
  context.globalAlpha = 1;

  const nearHorizon = groundY * 0.77;
  context.fillStyle = groundColor;
  context.globalAlpha = 0.72;
  context.beginPath();
  context.moveTo(0, nearHorizon + 19);
  for (let index = 0; index <= 13; index += 1) {
    const hillX = (index / 13) * width;
    const hillY = nearHorizon - (index % 4 === 2 ? height * 0.08 : height * 0.025);
    context.lineTo(hillX, hillY);
  }
  context.lineTo(width, groundY);
  context.lineTo(0, groundY);
  context.closePath();
  context.fill();
  context.globalAlpha = 1;

  context.save();
  context.globalAlpha = 1 - transition;
  const detailShift = (game.elapsed * (34 + visualSpeed * 0.07)) % 180;
  for (let index = -1; index < width / 180 + 2; index += 1) {
    drawCactus(context, index * 180 - detailShift + 52, groundY - 4, index % 2 === 0 ? 0.8 : 0.55);
  }
  context.restore();
  context.save();
  context.globalAlpha = transition;
  drawWorldBackdrop(context, game, toTheme, visualSpeed);
  context.restore();

  context.fillStyle = groundColor;
  context.fillRect(0, groundY, width, height - groundY);
  context.fillStyle = accentColor;
  context.globalAlpha = 0.22;
  context.fillRect(0, groundY, width, 2);
  context.fillStyle = atmosphereColor;
  context.globalAlpha = 0.2;
  const dashShift = (game.elapsed * (visualSpeed * 0.88)) % 98;
  for (let index = -1; index < width / 98 + 2; index += 1) {
    context.fillRect(index * 98 - dashShift, groundY + 29, 43, 2);
  }
  context.fillStyle = accentColor;
  context.globalAlpha = 0.12;
  for (let index = 0; index < width / 58 + 2; index += 1) {
    context.fillRect(index * 58 - ((game.elapsed * (52 + visualSpeed * 0.04)) % 58), groundY + 52, 21, 1);
  }
  context.globalAlpha = 1;

  for (const particle of game.dust) {
    context.globalAlpha = clamp(particle.life / particle.maxLife, 0, 1) * 0.55;
    context.fillStyle = '#f5bc62';
    context.beginPath();
    context.arc(particle.x, particle.y, particle.size, 0, Math.PI * 2);
    context.fill();
  }
  context.globalAlpha = 1;

  for (const coin of game.coins) drawCoin(context, coin, game.elapsed);
  for (const powerUp of game.powerUps) drawPowerUp(context, powerUp, game.elapsed);

  if (game.landingPulse > 0) {
    const radius = 16 + (1 - game.landingPulse) * 27;
    context.globalAlpha = game.landingPulse * 0.48;
    context.strokeStyle = '#f5bc62';
    context.lineWidth = 2;
    context.beginPath();
    context.ellipse(game.playerX + game.playerW * 0.5, groundY + 2, radius, radius * 0.22, 0, 0, Math.PI * 2);
    context.stroke();
    context.globalAlpha = 1;
  }

  if (game.impactPulse > 0) {
    const radius = 18 + (1 - game.impactPulse) * 80;
    context.globalAlpha = game.impactPulse * 0.42;
    context.strokeStyle = '#fff1d5';
    context.lineWidth = 2;
    context.beginPath();
    context.arc(game.impactX, game.impactY, radius, 0, Math.PI * 2);
    context.stroke();
    context.globalAlpha = 1;
  }

  for (const obstacle of game.obstacles) drawFork(context, obstacle, groundY);
  for (const particle of game.effects) {
    context.globalAlpha = clamp(particle.life / particle.maxLife, 0, 1) * 0.8;
    context.fillStyle = particle.color;
    context.beginPath();
    context.arc(particle.x, particle.y, particle.size, 0, Math.PI * 2);
    context.fill();
  }
  context.globalAlpha = 1;
  drawRunner(context, game);
};

const spawnDust = (game: GameData, count: number) => {
  for (let index = 0; index < count; index += 1) {
    game.dust.push({
      x: game.playerX + game.playerW * (0.1 + Math.random() * 0.8),
      y: game.groundY - 2 - Math.random() * 4,
      vx: -25 - Math.random() * 45,
      vy: -20 - Math.random() * 38,
      life: 0.35 + Math.random() * 0.2,
      maxLife: 0.55,
      size: 1.5 + Math.random() * 2.8,
    });
  }
};

const spawnEffectParticles = (
  game: GameData,
  color: string,
  count: number,
  originX = game.playerX + game.playerW * 0.5,
  originY = game.playerY + game.playerH * 0.45,
) => {
  for (let index = 0; index < count; index += 1) {
    game.effects.push({
      x: originX + (Math.random() - 0.5) * game.playerW,
      y: originY + (Math.random() - 0.5) * game.playerH,
      vx: (Math.random() - 0.5) * 150,
      vy: (Math.random() - 0.5) * 150,
      life: 0.35 + Math.random() * 0.4,
      maxLife: 0.75,
      size: 1.5 + Math.random() * 2.6,
      color,
    });
  }
};

const getSafeSpawnX = (game: GameData, desiredX: number, padding: number) => {
  let x = desiredX;
  for (let pass = 0; pass < game.obstacles.length + 1; pass += 1) {
    const blockingFork = game.obstacles.find(
      (obstacle) =>
        x + padding > obstacle.x - padding &&
        x - padding < obstacle.x + obstacle.width + padding,
    );
    if (!blockingFork) break;
    x = blockingFork.x + blockingFork.width + padding * 2;
  }
  return x;
};

const spawnCoin = (game: GameData) => {
  if (game.coins.length >= 40) return;
  const radius = clamp(game.width * 0.018, 8, 11);
  const x = getSafeSpawnX(game, game.width + 90 + Math.random() * 100, radius + 16);
  const nearFork = game.obstacles.some(
    (obstacle) => x + radius > obstacle.x - 12 && x - radius < obstacle.x + obstacle.width + 12,
  );
  const jumpCoin = Math.random() < 0.36;
  const y = nearFork
    ? game.groundY - 118
    : jumpCoin
      ? game.groundY - (78 + Math.random() * 38)
      : game.groundY - 27;
  game.coins.push({
    x,
    y,
    radius,
    phase: Math.random() * Math.PI * 2,
  });
};

const spawnPowerUp = (game: GameData) => {
  if (game.powerUps.length > 2) return;
  const roll = Math.random();
  const kind: PowerUpKind =
    roll < 0.36
      ? 'magnet'
      : roll < 0.7
        ? 'shield'
        : roll < 0.91
          ? 'slow'
          : 'invincible';
  const size = clamp(game.width * 0.026, 15, 20);
  const x = getSafeSpawnX(game, game.width + 120 + Math.random() * 90, size + 20);
  const nearFork = game.obstacles.some(
    (obstacle) => x + size > obstacle.x - 16 && x - size < obstacle.x + obstacle.width + 16,
  );
  game.powerUps.push({
    kind,
    x,
    y: nearFork
      ? game.groundY - 124
      : game.groundY - (Math.random() < 0.32 ? 31 : 76 + Math.random() * 20),
    size,
    phase: Math.random() * Math.PI * 2,
  });
};

const isPlayerNearPoint = (game: GameData, x: number, y: number, radius: number) => {
  const playerCenterX = game.playerX + game.playerW * 0.5;
  const playerCenterY = game.playerY + game.playerH * 0.48;
  return Math.hypot(playerCenterX - x, playerCenterY - y) < radius + Math.max(game.playerW, game.playerH) * 0.36;
};

const activatePowerUp = (game: GameData, kind: PowerUpKind): GameEvent => {
  if (kind === 'magnet') game.activePowerUps.magnet = MAGNET_DURATION;
  if (kind === 'shield') game.activePowerUps.shield = true;
  if (kind === 'slow') game.activePowerUps.slow = SLOW_DURATION;
  if (kind === 'invincible') game.activePowerUps.invincible = INVINCIBLE_DURATION;
  spawnEffectParticles(game, POWER_UP_META[kind].color, 18);
  return { type: 'powerup', kind };
};

const isColliding = (game: GameData, obstacle: Obstacle) => {
  const playerLeft = game.playerX + game.playerW * 0.18;
  const playerRight = game.playerX + game.playerW * 0.83;
  const playerTop = game.playerY + game.playerH * 0.1;
  const playerBottom = game.playerY + game.playerH;
  const obstacleLeft = obstacle.x + obstacle.width * 0.27;
  const obstacleRight = obstacle.x + obstacle.width * 0.73;
  const obstacleTop = game.groundY - obstacle.height;
  return (
    playerRight > obstacleLeft &&
    playerLeft < obstacleRight &&
    playerBottom > obstacleTop + 5 &&
    playerTop < game.groundY
  );
};

const stepGame = (game: GameData, delta: number): GameEvent[] => {
  const dt = Math.min(delta, 0.034);
  game.elapsed += dt;
  const scoreRate = 9.5 + Math.min(1.6, game.elapsed / 70);
  game.score = Math.floor(game.elapsed * scoreRate);
  const difficulty = getDifficulty(game.score);
  const baseSpeed = difficulty.speed;
  const targetWorld = Math.floor(game.score / WORLD_SCORE_INTERVAL);
  if (targetWorld !== game.worldTo) {
    game.worldFrom = game.worldTo;
    game.worldTo = targetWorld;
    game.worldTransition = 0;
  }
  game.worldTransition = Math.min(1, game.worldTransition + dt * 0.9);
  const targetSlowBlend = game.activePowerUps.slow > 0 ? 0.56 : 1;
  game.slowBlend += (targetSlowBlend - game.slowBlend) * Math.min(1, dt * 6);
  const effectiveSpeed = baseSpeed * game.slowBlend;
  const speed = effectiveSpeed;
  const events: GameEvent[] = [];
  game.landingPulse = Math.max(0, game.landingPulse - dt * 3.8);
  game.impactPulse = Math.max(0, game.impactPulse - dt * 2.8);
  game.collisionGrace = Math.max(0, game.collisionGrace - dt);
  game.collisionFlash = Math.max(0, game.collisionFlash - dt);

  if (game.activePowerUps.magnet > 0) {
    game.activePowerUps.magnet = Math.max(0, game.activePowerUps.magnet - dt);
  }
  if (game.activePowerUps.slow > 0) {
    game.activePowerUps.slow = Math.max(0, game.activePowerUps.slow - dt);
    if (game.activePowerUps.slow === 0) events.push({ type: 'expire', kind: 'slow' });
  }
  if (game.activePowerUps.invincible > 0) {
    game.activePowerUps.invincible = Math.max(0, game.activePowerUps.invincible - dt);
    if (game.activePowerUps.invincible === 0) {
      events.push({ type: 'expire', kind: 'invincible' });
    }
  }

  game.spawnClock += dt;
  if (game.spawnClock >= game.nextSpawn) {
    const largeFork =
      difficulty.level >= 4 &&
      Math.random() < 0.045 + (difficulty.level - 4) * 0.035;
    const forkWidth = clamp(game.width * 0.045, 33, 50) + (largeFork ? 5 : 0);
    const obstacleHeight = clamp(
      55 + Math.random() * 23 + game.score * 0.025 + (largeFork ? 8 : 0),
      54,
      largeFork ? 96 : 88,
    );
    const firstX = game.width + 42;
    const validationHeight = Math.min(96, obstacleHeight + 5);
    const minimumGap = getMinimumSafeForkGap(speed, forkWidth, game.playerW);
    const previousObstacle = game.obstacles[game.obstacles.length - 1];
    const previousGap = previousObstacle
      ? firstX - (previousObstacle.x + previousObstacle.width)
      : Number.POSITIVE_INFINITY;

    // Validate the real gap to the previous surviving obstacle as well as the
    // new pattern. If the previous fork has not moved far enough away yet,
    // defer this spawn instead of creating a chained sequence.
    if (previousGap < minimumGap) {
      game.spawnClock = 0;
      game.nextSpawn = Math.max(0.18, (minimumGap - previousGap) / speed);
    } else {
      const makeCandidate = () => {
        const patternRoll = Math.random();
        if (difficulty.level === 2 && patternRoll < 0.24) {
          return [0, 112 + Math.random() * 18];
        }
        if (difficulty.level === 3) {
          if (patternRoll < 0.2) {
            return [0, 68 + Math.random() * 10, 138 + Math.random() * 14];
          }
          if (patternRoll < 0.52) {
            return [0, 112 + Math.random() * 18];
          }
        }
        if (difficulty.level === 4) {
          if (patternRoll < 0.2) {
            return [0, 72 + Math.random() * 12, 145 + Math.random() * 15];
          }
          if (patternRoll < 0.55) {
            return [0, 108 + Math.random() * 18];
          }
        }
        if (difficulty.level === 5) {
          if (patternRoll < 0.13) {
            return [
              0,
              56 + Math.random() * 8,
              114 + Math.random() * 12,
              171 + Math.random() * 14,
            ];
          }
          if (patternRoll < 0.36) {
            return [0, 76 + Math.random() * 12, 153 + Math.random() * 16];
          }
          if (patternRoll < 0.65) {
            return [0, 106 + Math.random() * 18];
          }
        }
        return [0];
      };

      let offsets: number[] | null = null;
      for (let attempt = 0; attempt < MAX_PATTERN_ATTEMPTS; attempt += 1) {
        const candidate = makeCandidate();
        if (
          isPatternAchievable(
            candidate,
            speed,
            forkWidth,
            validationHeight,
            firstX,
            game.playerX,
            game.playerW,
          )
        ) {
          offsets = candidate;
          break;
        }
      }
      // A simple fork is still validated through the same path. It is the
      // only acceptable fallback when no complex candidate proves safe.
      offsets =
        offsets ??
        (isPatternAchievable(
          [0],
          speed,
          forkWidth,
          validationHeight,
          firstX,
          game.playerX,
          game.playerW,
        )
          ? [0]
          : null);

      if (!offsets) {
        game.spawnClock = 0;
        game.nextSpawn = 0.3;
      } else {
        offsets.forEach((offset, index) => {
          game.obstacles.push({
            x: firstX + offset,
            width: forkWidth,
            height: clamp(
              obstacleHeight - (index % 2 === 1 ? 7 : 0) + Math.random() * 5,
              50,
              96,
            ),
            lean: (Math.random() - 0.5) * 0.08,
          });
        });

        game.spawnClock = 0;
        const patternEnd = offsets[offsets.length - 1] + forkWidth;
        const safeWindow = getSafeAirborneWindow(validationHeight);
        const landingBuffer = Math.max(
          LANDING_RECOVERY_TIME + MIN_REACTION_TIME,
          JUMP_FLIGHT_TIME - safeWindow.start + 0.12,
        );
        const clearTime = patternEnd / speed + landingBuffer;
        const randomGap =
          difficulty.minSpawnGap +
          Math.random() * (difficulty.maxSpawnGap - difficulty.minSpawnGap);
        // The next spawn is still governed by V3's difficulty gaps, while the
        // real previous-fork gap is checked again when insertion occurs.
        game.nextSpawn = Math.max(
          randomGap,
          clearTime,
          (patternEnd + minimumGap) / speed,
        );
      }
    }
  }

  game.coinSpawnClock += dt;
  if (game.coinSpawnClock >= game.nextCoinSpawn) {
    spawnCoin(game);
    game.coinSpawnClock = 0;
    game.nextCoinSpawn = 0.95 + Math.random() * 1.25;
  }

  game.powerUpSpawnClock += dt;
  if (game.powerUpSpawnClock >= game.nextPowerUpSpawn) {
    spawnPowerUp(game);
    game.powerUpSpawnClock = 0;
    game.nextPowerUpSpawn = 10 + Math.random() * 7;
  }

  game.velocityY += GRAVITY * dt;
  game.playerY += game.velocityY * dt;
  const floorY = game.groundY - game.playerH;
  if (game.playerY >= floorY) {
    if (!game.playerOnGround) {
      spawnDust(game, 7);
      game.landingPulse = 1;
      events.push({ type: 'land' });
    }
    game.playerY = floorY;
    game.velocityY = 0;
    game.playerOnGround = true;
  } else {
    game.playerOnGround = false;
  }

  for (const obstacle of game.obstacles) obstacle.x -= effectiveSpeed * dt;
  game.obstacles = game.obstacles.filter((obstacle) => obstacle.x + obstacle.width > -30);

  for (const coin of game.coins) {
    coin.x -= effectiveSpeed * dt;
    if (game.activePowerUps.magnet > 0) {
      const targetX = game.playerX + game.playerW * 0.5;
      const targetY = game.playerY + game.playerH * 0.45;
      const dx = targetX - coin.x;
      const dy = targetY - coin.y;
      const distance = Math.hypot(dx, dy);
      if (distance < 280 && distance > 1) {
        const pull = clamp(940 - distance * 2, 260, 900);
        coin.x += (dx / distance) * pull * dt;
        coin.y += (dy / distance) * pull * dt;
      }
    }
  }
  game.coins = game.coins.filter((coin) => coin.x + coin.radius > -30);
  for (const powerUp of game.powerUps) powerUp.x -= effectiveSpeed * dt;
  game.powerUps = game.powerUps.filter((powerUp) => powerUp.x + powerUp.size > -30);

  for (const particle of game.dust) {
    particle.life -= dt;
    particle.x += particle.vx * dt;
    particle.y += particle.vy * dt;
    particle.vy += 90 * dt;
  }
  game.dust = game.dust.filter((particle) => particle.life > 0);
  if (game.playerOnGround && Math.random() < dt * 5.5) spawnDust(game, 1);

  for (const particle of game.effects) {
    particle.life -= dt;
    particle.x += particle.vx * dt;
    particle.y += particle.vy * dt;
    particle.vy += 55 * dt;
  }
  game.effects = game.effects.filter((particle) => particle.life > 0);

  const remainingCoins: Coin[] = [];
  for (const coin of game.coins) {
    if (isPlayerNearPoint(game, coin.x, coin.y, coin.radius)) {
      game.runCoins += 1;
      game.totalCoins += 1;
      spawnEffectParticles(game, '#f5bc62', 7, coin.x, coin.y);
      events.push({ type: 'coin' });
    } else {
      remainingCoins.push(coin);
    }
  }
  game.coins = remainingCoins;

  const remainingPowerUps: PowerUp[] = [];
  for (const powerUp of game.powerUps) {
    if (isPlayerNearPoint(game, powerUp.x, powerUp.y, powerUp.size)) {
      const event = activatePowerUp(game, powerUp.kind);
      if (event) events.push(event);
    } else {
      remainingPowerUps.push(powerUp);
    }
  }
  game.powerUps = remainingPowerUps;

  const hitObstacle = game.obstacles.find((obstacle) => isColliding(game, obstacle));
  if (hitObstacle) {
    if (game.collisionGrace <= 0) {
      game.impactPulse = 1;
      game.impactX = game.playerX + game.playerW * 0.7;
      game.impactY = game.playerY + game.playerH * 0.45;
      if (game.activePowerUps.invincible > 0) {
        if (game.collisionFlash <= 0) {
          spawnEffectParticles(game, '#ffd579', 12);
          game.collisionFlash = 0.24;
        }
      } else if (game.activePowerUps.shield) {
        game.activePowerUps.shield = false;
        game.collisionGrace = 0.34;
        spawnEffectParticles(game, '#90c8ff', 20);
        events.push({ type: 'shieldBreak' });
      } else {
        spawnDust(game, 10);
        events.push({ type: 'hit' });
        return events;
      }
    }
  }
  return events;
};

function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const gameRef = useRef<GameData>(makeGame());
  const audioRef = useRef<AudioContext | null>(null);
  const shownScoreRef = useRef(0);
  const [runState, setRunState] = useState<RunState>('idle');
  const [score, setScore] = useState(0);
  const [bestScore, setBestScore] = useState(() => readStoredNumber(BEST_SCORE_KEY));
  const [runCoins, setRunCoins] = useState(0);
  const [totalCoins, setTotalCoins] = useState(() => readStoredNumber(TOTAL_COINS_KEY));
  const [hudTick, setHudTick] = useState(0);

  const playSound = useCallback((
    kind:
      | 'jump'
      | 'land'
      | 'hit'
      | 'ui'
      | 'coin'
      | 'magnet'
      | 'shield'
      | 'slow'
      | 'invincible'
      | 'shieldBreak'
      | 'expire',
  ) => {
    if (typeof window === 'undefined') return;
    const AudioContextClass = window.AudioContext || (window as typeof window & {
      webkitAudioContext?: typeof AudioContext;
    }).webkitAudioContext;
    if (!AudioContextClass) return;
    const audio = audioRef.current ?? new AudioContextClass();
    audioRef.current = audio;
    if (audio.state === 'suspended') void audio.resume();

    const settings = {
      jump: { frequency: 410, endFrequency: 680, duration: 0.12, type: 'triangle' as OscillatorType, volume: 0.045 },
      land: { frequency: 150, endFrequency: 105, duration: 0.09, type: 'sine' as OscillatorType, volume: 0.035 },
      hit: { frequency: 125, endFrequency: 54, duration: 0.22, type: 'sawtooth' as OscillatorType, volume: 0.055 },
      ui: { frequency: 520, endFrequency: 650, duration: 0.07, type: 'sine' as OscillatorType, volume: 0.03 },
      coin: { frequency: 720, endFrequency: 1040, duration: 0.1, type: 'triangle' as OscillatorType, volume: 0.04 },
      magnet: { frequency: 280, endFrequency: 620, duration: 0.24, type: 'triangle' as OscillatorType, volume: 0.045 },
      shield: { frequency: 180, endFrequency: 440, duration: 0.2, type: 'sine' as OscillatorType, volume: 0.05 },
      slow: { frequency: 330, endFrequency: 180, duration: 0.3, type: 'square' as OscillatorType, volume: 0.032 },
      invincible: { frequency: 520, endFrequency: 880, duration: 0.28, type: 'sawtooth' as OscillatorType, volume: 0.038 },
      shieldBreak: { frequency: 240, endFrequency: 70, duration: 0.2, type: 'sawtooth' as OscillatorType, volume: 0.05 },
      expire: { frequency: 190, endFrequency: 110, duration: 0.16, type: 'sine' as OscillatorType, volume: 0.03 },
    }[kind];
    const oscillator = audio.createOscillator();
    const gain = audio.createGain();
    const now = audio.currentTime;
    oscillator.type = settings.type;
    oscillator.frequency.setValueAtTime(settings.frequency, now);
    oscillator.frequency.exponentialRampToValueAtTime(settings.endFrequency, now + settings.duration);
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(settings.volume, now + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + settings.duration);
    oscillator.connect(gain);
    gain.connect(audio.destination);
    oscillator.start(now);
    oscillator.stop(now + settings.duration + 0.02);
  }, []);

  const resetAndStart = useCallback(() => {
    const current = gameRef.current;
    const fresh = makeGame(
      Math.max(current.best, bestScore),
      Math.max(current.totalCoins, totalCoins),
    );
    fresh.width = current.width;
    fresh.height = current.height;
    fresh.groundY = current.groundY;
    fresh.playerW = current.playerW;
    fresh.playerH = current.playerH;
    fresh.playerX = current.playerX;
    fresh.playerY = fresh.groundY - fresh.playerH;
    gameRef.current = fresh;
    shownScoreRef.current = 0;
    setScore(0);
    setRunCoins(0);
    setRunState('running');
    playSound('ui');
  }, [bestScore, playSound, totalCoins]);

  const performJumpOrStart = useCallback(() => {
    if (runState !== 'running') {
      resetAndStart();
      return;
    }
    const game = gameRef.current;
    if (game.playerOnGround) {
      game.velocityY = -JUMP_VELOCITY;
      game.playerOnGround = false;
      spawnDust(game, 2);
      playSound('jump');
    }
  }, [playSound, resetAndStart, runState]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const context = canvas.getContext('2d');
    if (!context) return;
    const game = gameRef.current;

    const syncCanvas = () => {
      const bounds = canvas.getBoundingClientRect();
      const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.max(1, Math.floor(bounds.width * pixelRatio));
      canvas.height = Math.max(1, Math.floor(bounds.height * pixelRatio));
      context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
      const previousGround = game.groundY;
      game.width = bounds.width;
      game.height = bounds.height;
      game.groundY = bounds.height * (bounds.width < 580 ? 0.79 : 0.77);
      game.playerW = clamp(bounds.width * 0.043, 30, 43);
      game.playerH = game.playerW * 1.46;
      game.playerX = clamp(bounds.width * 0.18, 65, 210);
      if (!previousGround || game.playerOnGround) {
        game.playerY = game.groundY - game.playerH;
      } else {
        game.playerY += game.groundY - previousGround;
      }
      drawWorld(game, context);
    };

    syncCanvas();
    const resizeObserver = new ResizeObserver(syncCanvas);
    resizeObserver.observe(canvas);
    window.addEventListener('resize', syncCanvas);
    return () => {
      resizeObserver.disconnect();
      window.removeEventListener('resize', syncCanvas);
    };
  }, []);

  useEffect(() => {
    if (runState !== 'running') return;
    const canvas = canvasRef.current;
    const context = canvas?.getContext('2d');
    if (!canvas || !context) return;

    let animationFrame = 0;
    let previousTime = performance.now();
    let hudAccumulator = 0;
    const animate = (now: number) => {
      const game = gameRef.current;
      if (document.hidden) {
        previousTime = now;
        animationFrame = requestAnimationFrame(animate);
        return;
      }
      const frameDelta = (now - previousTime) / 1000;
      const events = stepGame(game, frameDelta);
      previousTime = now;
      hudAccumulator += frameDelta;
      drawWorld(game, context);
      if (game.score !== shownScoreRef.current) {
        shownScoreRef.current = game.score;
        setScore(game.score);
      }
      if (hudAccumulator >= 0.08) {
        hudAccumulator = 0;
        setHudTick((tick) => tick + 1);
      }

      let hit = false;
      for (const event of events) {
        if (!event) continue;
        if (event.type === 'land') playSound('land');
        if (event.type === 'coin') {
          playSound('coin');
          setRunCoins(game.runCoins);
          setTotalCoins(game.totalCoins);
          writeStoredNumber(TOTAL_COINS_KEY, game.totalCoins);
        }
        if (event.type === 'powerup') playSound(event.kind);
        if (event.type === 'shieldBreak') playSound('shieldBreak');
        if (event.type === 'expire') playSound('expire');
        if (event.type === 'hit') {
          playSound('hit');
          hit = true;
        }
      }
      if (hit) {
        game.best = Math.max(game.best, game.score);
        setBestScore(game.best);
        writeStoredNumber(BEST_SCORE_KEY, game.best);
        setRunState('over');
        return;
      }
      animationFrame = requestAnimationFrame(animate);
    };

    animationFrame = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(animationFrame);
   }, [playSound, runState]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.code === 'Space' || event.code === 'ArrowUp') {
        event.preventDefault();
        if (!event.repeat) performJumpOrStart();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [performJumpOrStart]);

  const activePowerUps = gameRef.current.activePowerUps;

  return (
    <main className="runner-app" data-testid="game-shell">
      <canvas
        ref={canvasRef}
        className="world-canvas"
        data-testid="game-canvas"
        aria-label="Fork Runner game field. Tap, click, or press space to jump."
        onPointerDown={performJumpOrStart}
      />

      <header className="hud" aria-label="Game status">
        <div className="brand-lockup" data-testid="text-brand">
          <span className="brand-mark" aria-hidden="true" />
          <span className="brand-name">Fork Runner</span>
        </div>
        <div className="score-panel">
          <div className="score-block">
            <span className="score-label">Distance</span>
            <span className="score-value" data-testid="text-score">
              {String(score).padStart(4, '0')}
            </span>
          </div>
          <div className="score-block best-block">
            <span className="score-label">Best</span>
            <span className="score-value" data-testid="text-best">
              {String(bestScore).padStart(4, '0')}
            </span>
          </div>
          <div className="score-block coin-block">
            <span className="score-label">Coins</span>
            <span className="coin-value" data-testid="text-coins">
              <span className="coin-glyph" aria-hidden="true">◆</span>
              {runCoins}
              <small>/ {totalCoins}</small>
            </span>
          </div>
        </div>
      </header>

      <div className="powerup-hud" data-hud-tick={hudTick} aria-live="polite">
        {activePowerUps.magnet > 0 && (
          <div className="powerup-chip magnet-chip">
            <span className="powerup-icon">M</span>
            <span className="powerup-copy">
              <strong>Magnet</strong>
              <small>{Math.ceil(activePowerUps.magnet)}s</small>
            </span>
            <span className="powerup-progress">
              <i style={{ width: `${(activePowerUps.magnet / MAGNET_DURATION) * 100}%` }} />
            </span>
          </div>
        )}
        {activePowerUps.shield && (
          <div className="powerup-chip shield-chip">
            <span className="powerup-icon">S</span>
            <span className="powerup-copy">
              <strong>Shield</strong>
              <small>1 hit</small>
            </span>
          </div>
        )}
        {activePowerUps.slow > 0 && (
          <div className="powerup-chip slow-chip">
            <span className="powerup-icon">T</span>
            <span className="powerup-copy">
              <strong>Slow</strong>
              <small>{Math.ceil(activePowerUps.slow)}s</small>
            </span>
            <span className="powerup-progress">
              <i style={{ width: `${(activePowerUps.slow / SLOW_DURATION) * 100}%` }} />
            </span>
          </div>
        )}
        {activePowerUps.invincible > 0 && (
          <div className={`powerup-chip invincible-chip${activePowerUps.invincible < 1 ? ' powerup-flashing' : ''}`}>
            <span className="powerup-icon">✦</span>
            <span className="powerup-copy">
              <strong>Invincible</strong>
              <small>{Math.ceil(activePowerUps.invincible)}s</small>
            </span>
            <span className="powerup-progress">
              <i style={{ width: `${(activePowerUps.invincible / INVINCIBLE_DURATION) * 100}%` }} />
            </span>
          </div>
        )}
      </div>

      {runState === 'idle' && (
        <>
          <div className="screen-scrim" aria-hidden="true" />
          <section className="center-prompt" aria-label="Start Fork Runner">
            <div className="eyebrow">A tiny sprint through dusk</div>
            <h1 className="game-title">
              Fork<br /><em>Runner</em>
            </h1>
            <p className="prompt-copy">
              Keep your feet light. The forks get faster, but the horizon stays warm.
            </p>
            <button
              className="start-button"
              type="button"
              data-testid="button-start"
              onClick={resetAndStart}
            >
              Tap to start
            </button>
            <div className="key-hint">
              <span className="key-cap">Space</span>
               <span>or tap to jump</span>
            </div>
          </section>
        </>
      )}

      {runState === 'running' && (
        <>
          <div className="bottom-hint">
            <strong>Space</strong>&nbsp; / &nbsp;<strong>Tap</strong>&nbsp; to jump
          </div>
          <div className="run-indicator">Running</div>
        </>
      )}

      {runState === 'over' && (
        <>
          <div className="screen-scrim" aria-hidden="true" />
          <section className="game-over-card" aria-live="polite" data-testid="game-over-overlay">
             <div className="game-over-kicker">The forks caught up</div>
             <h2 className="game-over-title">Game Over</h2>
            <div className="result-row">
              <div className="result-stat">
                <span className="result-number" data-testid="text-final-score">
                  {String(score).padStart(4, '0')}
                </span>
                 <span className="result-label">Score</span>
              </div>
              <div className="result-stat">
                <span className="result-number" data-testid="text-final-best">
                  {String(bestScore).padStart(4, '0')}
                </span>
                <span className="result-label">Best</span>
              </div>
              <div className="result-stat">
                <span className="result-number" data-testid="text-final-coins">
                  {runCoins}
                </span>
                <span className="result-label">Coins</span>
              </div>
            </div>
             <p className="game-over-note">You banked {runCoins} coin{runCoins === 1 ? '' : 's'} this run.</p>
            <button
              className="retry-button"
              type="button"
              data-testid="button-retry"
              onClick={resetAndStart}
            >
               Retry
            </button>
            <div className="key-hint">
              <span className="key-cap">Space</span>
              <span>to retry</span>
            </div>
          </section>
        </>
      )}
    </main>
  );
}

export default App;