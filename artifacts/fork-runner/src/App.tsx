import { useCallback, useEffect, useRef, useState } from 'react';

type RunState = 'idle' | 'running' | 'over';

type Obstacle = {
  x: number;
  width: number;
  height: number;
  lean: number;
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

type GameEvent = 'land' | 'hit' | null;

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
  spawnClock: number;
  nextSpawn: number;
  obstacles: Obstacle[];
  dust: DustParticle[];
  landingPulse: number;
  impactPulse: number;
  impactX: number;
  impactY: number;
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
const PATTERN_MARGIN = 0.055;

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

const isPatternAchievable = (
  offsets: number[],
  speed: number,
  forkWidth: number,
  obstacleHeight: number,
) => {
  const safeWindow = getSafeAirborneWindow(obstacleHeight);
  const lastOffset = offsets[offsets.length - 1] ?? 0;
  const patternTime = (lastOffset + forkWidth) / speed;
  const minimumSeparation = forkWidth + 18;

  return (
    offsets.every(
      (offset, index) =>
        index === 0 || offset - offsets[index - 1] >= minimumSeparation,
    ) &&
    patternTime <= safeWindow.end - safeWindow.start - PATTERN_MARGIN
  );
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

const makeGame = (best = 0): GameData => ({
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
  spawnClock: 0,
  nextSpawn: 1.48,
  obstacles: [],
  dust: [],
  landingPulse: 0,
  impactPulse: 0,
  impactX: 0,
  impactY: 0,
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
) => {
  context.save();
  context.globalAlpha = 0.13;
  context.fillStyle = '#fff1d5';
  context.beginPath();
  context.ellipse(x, y, 46 * scale, 10 * scale, 0, 0, Math.PI * 2);
  context.ellipse(x - 25 * scale, y + 4 * scale, 25 * scale, 8 * scale, 0, 0, Math.PI * 2);
  context.ellipse(x + 19 * scale, y + 1 * scale, 31 * scale, 11 * scale, 0, 0, Math.PI * 2);
  context.fill();
  context.restore();
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

const drawRunner = (context: CanvasRenderingContext2D, game: GameData) => {
  const { playerX: x, playerY: y, playerW: width, playerH: height } = game;
  const runCycle = Math.sin(game.elapsed * 18);
  const airborne = !game.playerOnGround;
  const legSwing = airborne ? 0.2 : runCycle * 5;

  context.save();
  context.translate(x, y);

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

  context.clearRect(0, 0, width, height);

  const sky = context.createLinearGradient(0, 0, 0, groundY);
  sky.addColorStop(0, '#33234a');
  sky.addColorStop(0.55, '#a86683');
  sky.addColorStop(1, '#ed9a78');
  context.fillStyle = sky;
  context.fillRect(0, 0, width, height);

  const sunX = width * 0.78;
  const sunY = height * 0.255;
  const sun = context.createRadialGradient(sunX, sunY, 5, sunX, sunY, Math.max(95, width * 0.15));
  sun.addColorStop(0, 'rgba(255, 239, 187, .82)');
  sun.addColorStop(0.25, 'rgba(255, 208, 132, .25)');
  sun.addColorStop(1, 'rgba(255, 208, 132, 0)');
  context.fillStyle = sun;
  context.fillRect(sunX - 170, sunY - 170, 340, 340);
  context.fillStyle = '#ffdda0';
  context.globalAlpha = 0.88;
  context.beginPath();
  context.arc(sunX, sunY, clamp(width * 0.045, 24, 57), 0, Math.PI * 2);
  context.fill();
  context.globalAlpha = 1;

  for (let index = 0; index < 22; index += 1) {
    const starX = ((index * 137 + 31) % 1000) / 1000 * width;
    const starY = (((index * 71 + 17) % 430) / 430) * groundY * 0.53;
    const starSize = index % 4 === 0 ? 1.5 : 0.8;
    context.globalAlpha = 0.28 + (index % 3) * 0.08;
    context.fillStyle = '#fff1d5';
    context.fillRect(starX, starY, starSize, starSize);
  }
  context.globalAlpha = 1;

  const cloudShift = (game.elapsed * (10 + difficulty.speed * 0.025)) % (width + 220);
  drawCloud(context, width * 0.13 - cloudShift, height * 0.2, 0.8);
  drawCloud(context, width * 0.66 - (cloudShift * 0.65), height * 0.14, 0.55);
  drawCloud(context, width + 110 - (cloudShift * 0.36), height * 0.33, 0.68);

  const farHorizon = groundY * 0.7;
  context.fillStyle = '#67466a';
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
  context.fillStyle = '#3f3151';
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

  const detailShift = (game.elapsed * (34 + difficulty.speed * 0.07)) % 180;
  for (let index = -1; index < width / 180 + 2; index += 1) {
    drawCactus(context, index * 180 - detailShift + 52, groundY - 4, index % 2 === 0 ? 0.8 : 0.55);
  }

  context.fillStyle = '#2b1d3c';
  context.fillRect(0, groundY, width, height - groundY);
  context.fillStyle = 'rgba(245, 188, 98, .22)';
  context.fillRect(0, groundY, width, 2);
  context.fillStyle = 'rgba(166, 211, 191, .2)';
  const dashShift = (game.elapsed * (difficulty.speed * 0.88)) % 98;
  for (let index = -1; index < width / 98 + 2; index += 1) {
    context.fillRect(index * 98 - dashShift, groundY + 29, 43, 2);
  }
  context.fillStyle = 'rgba(245, 188, 98, .12)';
  for (let index = 0; index < width / 58 + 2; index += 1) {
    context.fillRect(index * 58 - ((game.elapsed * (52 + difficulty.speed * 0.04)) % 58), groundY + 52, 21, 1);
  }

  for (const particle of game.dust) {
    context.globalAlpha = clamp(particle.life / particle.maxLife, 0, 1) * 0.55;
    context.fillStyle = '#f5bc62';
    context.beginPath();
    context.arc(particle.x, particle.y, particle.size, 0, Math.PI * 2);
    context.fill();
  }
  context.globalAlpha = 1;

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

const stepGame = (game: GameData, delta: number): GameEvent => {
  const dt = Math.min(delta, 0.034);
  game.elapsed += dt;
  const scoreRate = 9.5 + Math.min(1.6, game.elapsed / 70);
  game.score = Math.floor(game.elapsed * scoreRate);
  const difficulty = getDifficulty(game.score);
  const speed = difficulty.speed;
  game.landingPulse = Math.max(0, game.landingPulse - dt * 3.8);
  game.impactPulse = Math.max(0, game.impactPulse - dt * 2.8);

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
    const patternRoll = Math.random();
    const candidates: number[][] = [[0]];

    if (difficulty.level === 2 && patternRoll < 0.24) {
      candidates.unshift([0, 112 + Math.random() * 18]);
    } else if (difficulty.level === 3) {
      if (patternRoll < 0.2) {
        candidates.unshift([0, 68 + Math.random() * 10, 138 + Math.random() * 14]);
      } else if (patternRoll < 0.52) {
        candidates.unshift([0, 112 + Math.random() * 18]);
      }
    } else if (difficulty.level === 4) {
      if (patternRoll < 0.2) {
        candidates.unshift([0, 72 + Math.random() * 12, 145 + Math.random() * 15]);
      } else if (patternRoll < 0.55) {
        candidates.unshift([0, 108 + Math.random() * 18]);
      }
    } else if (difficulty.level === 5) {
      if (patternRoll < 0.13) {
        candidates.unshift([
          0,
          56 + Math.random() * 8,
          114 + Math.random() * 12,
          171 + Math.random() * 14,
        ]);
      } else if (patternRoll < 0.36) {
        candidates.unshift([0, 76 + Math.random() * 12, 153 + Math.random() * 16]);
      } else if (patternRoll < 0.65) {
        candidates.unshift([0, 106 + Math.random() * 18]);
      }
    }

    const validationHeight = Math.min(96, obstacleHeight + 5);
    const offsets =
      candidates.find((candidate) =>
        isPatternAchievable(candidate, speed, forkWidth, validationHeight),
      ) ?? [0];

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
      0.7,
      JUMP_FLIGHT_TIME - safeWindow.start + 0.12,
    );
    const clearTime = patternEnd / speed + landingBuffer;
    const randomGap =
      difficulty.minSpawnGap +
      Math.random() * (difficulty.maxSpawnGap - difficulty.minSpawnGap);
    // Keep a landing window after every pattern so a close sequence is
    // demanding but never requires a double-jump or an impossible landing.
    game.nextSpawn = Math.max(randomGap, clearTime);
  }

  game.velocityY += GRAVITY * dt;
  game.playerY += game.velocityY * dt;
  const floorY = game.groundY - game.playerH;
  let event: GameEvent = null;
  if (game.playerY >= floorY) {
    if (!game.playerOnGround) {
      spawnDust(game, 7);
      game.landingPulse = 1;
      event = 'land';
    }
    game.playerY = floorY;
    game.velocityY = 0;
    game.playerOnGround = true;
  } else {
    game.playerOnGround = false;
  }

  for (const obstacle of game.obstacles) obstacle.x -= speed * dt;
  game.obstacles = game.obstacles.filter((obstacle) => obstacle.x + obstacle.width > -30);

  for (const particle of game.dust) {
    particle.life -= dt;
    particle.x += particle.vx * dt;
    particle.y += particle.vy * dt;
    particle.vy += 90 * dt;
  }
  game.dust = game.dust.filter((particle) => particle.life > 0);
  if (game.playerOnGround && Math.random() < dt * 5.5) spawnDust(game, 1);

  const hitObstacle = game.obstacles.find((obstacle) => isColliding(game, obstacle));
  if (hitObstacle) {
    game.impactPulse = 1;
    game.impactX = game.playerX + game.playerW * 0.7;
    game.impactY = game.playerY + game.playerH * 0.45;
    spawnDust(game, 10);
    return 'hit';
  }
  return event;
};

function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const gameRef = useRef<GameData>(makeGame());
  const audioRef = useRef<AudioContext | null>(null);
  const shownScoreRef = useRef(0);
  const [runState, setRunState] = useState<RunState>('idle');
  const [score, setScore] = useState(0);
  const [bestScore, setBestScore] = useState(() => {
    if (typeof window === 'undefined') return 0;
    const stored = Number(window.localStorage.getItem('fork-runner-best') ?? 0);
    return Number.isFinite(stored) ? stored : 0;
  });

  const playSound = useCallback((kind: 'jump' | 'land' | 'hit' | 'ui') => {
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
    const fresh = makeGame(Math.max(current.best, bestScore));
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
    setRunState('running');
    playSound('ui');
  }, [bestScore, playSound]);

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
    const animate = (now: number) => {
      const game = gameRef.current;
      if (document.hidden) {
        previousTime = now;
        animationFrame = requestAnimationFrame(animate);
        return;
      }
       const event = stepGame(game, (now - previousTime) / 1000);
      previousTime = now;
      drawWorld(game, context);
      if (game.score !== shownScoreRef.current) {
        shownScoreRef.current = game.score;
        setScore(game.score);
      }
       if (event === 'land') playSound('land');
       if (event === 'hit') {
         playSound('hit');
        game.best = Math.max(game.best, game.score);
        setBestScore(game.best);
        window.localStorage.setItem('fork-runner-best', String(game.best));
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
        </div>
      </header>

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
            </div>
             <p className="game-over-note">Ready for another run?</p>
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