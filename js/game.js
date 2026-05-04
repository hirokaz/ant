/* ====================================================================
   アント (ANT) - One-handed mobile commute game
   ==================================================================== */

// ---------- Constants ----------
// World dimensions are mutable to support runtime expansion (Issue #7).
// The world is large from the start; only the initial zone (around the nest)
// is accessible. Other tiles are rock and unlock when new zones appear.
// Zones form a 5x5 (or larger) spiral grid centred on the nest.
let WORLD_WIDTH = 4400;
let WORLD_HEIGHT = 4400;

// Nest position is fixed at the world centre, inside the initial zone.
let NEST_X = 2200;
let NEST_Y = 2200;
const NEST_RADIUS_BASE = 120;
const EGG_ROOM_RADIUS = 70;

// Square zone size (≈ 1/4 of the previous initial-area dimensions).
const ZONE_SIZE = 800;

const PLAYER_SPEED = 2.6;
const FRIEND_SPEED = 2.3;
const PLAYER_HP = 100;
const FRIEND_HP = 50;
const PLAYER_ATTACK = 7;
const FRIEND_ATTACK = 5;

const ENEMY_HP = 45;
const ENEMY_ATTACK = 8;
const ENEMY_SPEED = 1.4;
const ENEMY_DETECT_RANGE = 140;
const ENEMY_ATTACK_RANGE = 28;
const ENEMY_ATTACK_COOLDOWN = 1100;

const ATTACK_RANGE = 36;
const ATTACK_COOLDOWN = 500;

const FOOD_HATCH_TIME = 7000;

const WIN_ANT_COUNT = 1000;
// Friend-count thresholds for unlocking each expansion stage.
// The gap grows with each stage — colonies carry more food as they grow,
// so the bar for the next area should rise too.
//   stage 0 →   0 (initial)
//   stage 1 →  20 (gap 20)
//   stage 2 →  45 (gap 25)
//   stage 3 →  75 (gap 30)
//   ... gap grows by +5 each stage.
const EXPANSION_THRESHOLDS = (function () {
  const arr = [0];
  let total = 0, gap = 20;
  while (total < 1100) {
    total += gap;
    arr.push(total);
    gap += 5;
  }
  return arr;
})();
const FIRST_EXPANSION_AT = EXPANSION_THRESHOLDS[1]; // = 20
const MAX_EXPANSION_STAGE = EXPANSION_THRESHOLDS.length - 1;
const WORLD_EXPAND_AMOUNT = 350;
// Order in which biome regions appear. After the 6th unlock the cycle repeats.
const BIOME_SEQUENCE = ['mud', 'pond', 'flower', 'leaves', 'sand', 'concrete'];
// Short-duration power-ups. Dropped on enemy kills + on goal achievements.
const POWERUP_DEFS = {
  dash:    { icon: '⚡',  label: '猛ダッシュ', durationMs: 8000,  glowColor: 'rgba(255, 220, 80, 0.55)',  auraColor: '255, 220, 80'  },
  strong:  { icon: '🗡',  label: '強化アゴ',   durationMs: 10000, glowColor: 'rgba(255, 100, 100, 0.55)', auraColor: '255, 100, 100' },
  invuln:  { icon: '✨',  label: '無敵',       durationMs: 5000,  glowColor: 'rgba(160, 240, 255, 0.55)', auraColor: '160, 240, 255' },
  terrain: { icon: '🛡',  label: '地形無効',   durationMs: 12000, glowColor: 'rgba(140, 220, 200, 0.55)', auraColor: '140, 220, 200' },
  giant:   { icon: '🦣',  label: '巨大化',     durationMs: 10000, glowColor: 'rgba(220, 130, 255, 0.55)', auraColor: '220, 130, 255' },
  radar:   { icon: '🧭',  label: '餌レーダー', durationMs: 15000, glowColor: 'rgba(120, 220, 120, 0.55)', auraColor: '120, 220, 120' }
};
const POWERUP_TYPES = Object.keys(POWERUP_DEFS);

class PowerUp {
  constructor(x, y, type) {
    this.x = x; this.y = y;
    this.type = type;
    this.size = 16;
    this.bobble = Math.random() * Math.PI * 2;
    this.lifetime = 20000;
    this.collected = false;
  }
  update(dt) {
    this.bobble += dt * 0.005;
    this.lifetime -= dt;
    if (this.lifetime <= 0) this.collected = true;
  }
  draw(ctx) {
    if (this.collected) return;
    const bob = Math.sin(this.bobble * 2) * 3;
    const fade = Math.min(1, this.lifetime / 4000);
    const def = POWERUP_DEFS[this.type] || POWERUP_DEFS.dash;
    ctx.save();
    ctx.translate(this.x, this.y + bob);
    ctx.globalAlpha = fade;
    const glow = ctx.createRadialGradient(0, 0, 0, 0, 0, this.size * 1.8);
    glow.addColorStop(0, def.glowColor);
    glow.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(0, 0, this.size * 1.8, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = 'rgba(20, 20, 20, 0.85)';
    ctx.beginPath();
    ctx.arc(0, 0, this.size, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 18px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(def.icon, 0, 0);
    ctx.restore();
  }
}

// Nest base upgrade levels — gated on cumulative deposits across the run.
// These compound with colony levels (which gate on friend count).
const NEST_LEVELS = [
  { lv: 1, deposits: 30,  label: '卵の孵化が早くなった',
    apply: (g) => { g.bonuses.hatchTimeMul *= 0.80; } },
  { lv: 2, deposits: 80,  label: '巣の中で HP 回復',
    apply: (g) => { g.bonuses.nestRegenPerSec = 0.5; } },
  { lv: 3, deposits: 200, label: '仲間呼び出し +4',
    apply: (g) => { g.maxCallSize = (g.maxCallSize || 12) + 4; } }
];

// Cosmetic ant skins for the player. Unlocked via persistent stats so a
// player who has reached a milestone keeps the skin even after starting over.
const SKIN_DEFS = [
  { id: 'default', label: 'デフォルト', color: '#161616', highlight: '#3a3a3a', glow: false,
    unlock: () => true,
    requirement: '初期から使用可' },
  { id: 'red',     label: '赤アリ',     color: '#8b1a1a', highlight: '#d04646', glow: false,
    unlock: (s) => s && s.milestones && s.milestones['100'],
    requirement: '100匹達成' },
  { id: 'gold',    label: '金アリ',     color: '#9d7820', highlight: '#ffd84a', glow: true,
    unlock: (s) => s && s.milestones && s.milestones['500'],
    requirement: '500匹達成' },
  { id: 'blue',    label: '青アリ',     color: '#1a4488', highlight: '#5a98e0', glow: false,
    unlock: (s) => s && s.bestClearMs && s.bestClearMs > 0,
    requirement: '1000匹クリア' }
];

// Random mid-game events — fire every 90-180s once the colony is past 30 ants.
// Some are instant (a treasure pops), some run for ~30s with multipliers that
// feed back into spawn timers and movement speeds.
const RANDOM_EVENTS = [
  {
    id: 'giantFood', label: '🍰 巨大餌出現! 探そう',
    durationMs: 0,
    apply: (g) => {
      const zones = g.zones.filter(z => z.biome !== 'pond');
      const zone = pickRand(zones.length ? zones : g.zones);
      const x = rand(zone.x0 + 60, zone.x1 - 60);
      const y = rand(zone.y0 + 60, zone.y1 - 60);
      if (g.terrain && g.terrain.getAt(x, y) === 'rock') return;
      const f = new Food(x, y, 'giant');
      f.eggBonus = 1.3;
      g.foods.push(f);
    },
    revert: () => {}
  },
  {
    id: 'enemySwarm', label: '⚠️ 敵が集まってくる',
    durationMs: 25000,
    apply: (g) => { g._eventEnemyMul = 1.6; },
    revert: (g) => { g._eventEnemyMul = 1.0; }
  },
  {
    id: 'bonusTime', label: '✨ ボーナスタイム! 餌&ハート増加',
    durationMs: 25000,
    apply: (g) => {
      for (let i = 0; i < 3; i++) g.spawnHealItem();
      g._eventFoodMul = 1.7;
    },
    revert: (g) => { g._eventFoodMul = 1.0; }
  },
  {
    id: 'storm', label: '⚡ 嵐! みんな速度ダウン',
    durationMs: 25000,
    apply: (g) => { g._eventPlayerSpeedMul = 0.85; g._eventEnemySpeedMul = 1.15; },
    revert: (g) => { g._eventPlayerSpeedMul = 1.0; g._eventEnemySpeedMul = 1.0; }
  }
];

// Mini-goal celebration milestones — purely cosmetic, big "you did it" moments.
const MILESTONE_DEFS = [
  { n: 10,  label: '🥉 10匹達成!' },
  { n: 50,  label: '🥈 50匹達成! コロニー誕生' },
  { n: 100, label: '🥇 100匹達成! 一人前のコロニー' },
  { n: 200, label: '🌟 200匹達成!' },
  { n: 500, label: '🏆 500匹達成! 大コロニー' }
];

// Colony levels — passive bonuses unlocked as the colony grows.
// Each entry's `apply` mutates Game state. Levels are applied once, in order.
const COLONY_LEVELS = [
  { lv: 1, friends: 10,  label: 'プレイヤー HP +10',
    apply: (g) => { g.player.maxHp += 10; g.player.hp = g.player.maxHp; } },
  { lv: 2, friends: 25,  label: '仲間の攻撃力 +1',
    apply: (g) => {
      g.bonuses.friendAttack += 1;
      g.friends.forEach(f => { if (!f.dead) f.attackPower = g.bonuses.friendAttack; });
    } },
  { lv: 3, friends: 50,  label: '餌の運搬速度 +10%',
    apply: (g) => { g.bonuses.carrySpeedMul *= 1.10; } },
  { lv: 4, friends: 100, label: 'プレイヤー HP +20',
    apply: (g) => { g.player.maxHp += 20; g.player.hp = g.player.maxHp; } },
  { lv: 5, friends: 200, label: '仲間 HP +20',
    apply: (g) => {
      g.bonuses.friendMaxHp += 20;
      g.friends.forEach(f => { if (!f.dead) { f.maxHp = g.bonuses.friendMaxHp; f.hp = f.maxHp; } });
    } },
  { lv: 6, friends: 350, label: '卵の孵化時間 -20%',
    apply: (g) => { g.bonuses.hatchTimeMul *= 0.80; } },
  { lv: 7, friends: 500, label: '仲間の攻撃力 +2',
    apply: (g) => {
      g.bonuses.friendAttack += 2;
      g.friends.forEach(f => { if (!f.dead) f.attackPower = g.bonuses.friendAttack; });
    } },
  { lv: 8, friends: 750, label: 'プレイヤー攻撃力 +3',
    apply: (g) => { g.player.attackPower += 3; } }
];

const BIOME_UNLOCK_INFO = {
  mud:      { name: '🟫 泥',       intro: '体力じわじわ減・カブトムシ出現' },
  pond:     { name: '🟦 池',       intro: '大幅減速&HP減少・ハチ出現' },
  flower:   { name: '🌸 花畑',     intro: '餌が豊富&HP微回復' },
  leaves:   { name: '🍂 落ち葉',   intro: 'クモが多く隠れる' },
  sand:     { name: '🟨 砂',       intro: '歩きづらい' },
  concrete: { name: '⬜ コンクリ', intro: '強敵&大型餌 (人の落とし物)' }
};

const MAX_ENEMIES = 7;
const MAX_FOODS = 9;

// ---------- Utilities ----------
function dist(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}
function clamp(v, min, max) {
  return v < min ? min : v > max ? max : v;
}
function lerp(a, b, t) {
  return a + (b - a) * t;
}
function rand(min, max) {
  return min + Math.random() * (max - min);
}
function chance(p) {
  return Math.random() < p;
}
function pickRand(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}
function inNest(x, y) {
  return Math.hypot(x - NEST_X, y - NEST_Y) < NEST_RADIUS_BASE;
}
function inEggRoom(x, y) {
  return Math.hypot(x - NEST_X, y - NEST_Y) < EGG_ROOM_RADIUS;
}

// ---------- Entities ----------

class Ant {
  constructor(x, y, isPlayer = false) {
    this.x = x;
    this.y = y;
    this.angle = -Math.PI / 2;
    this.targetAngle = this.angle;
    this.isPlayer = isPlayer;
    this.maxHp = isPlayer ? PLAYER_HP : FRIEND_HP;
    this.hp = this.maxHp;
    this.attackPower = isPlayer ? PLAYER_ATTACK : FRIEND_ATTACK;
    this.speed = isPlayer ? PLAYER_SPEED : FRIEND_SPEED;
    this.size = isPlayer ? 14 : 18;
    this.state = isPlayer ? 'player' : 'idle';  // idle, follow, carrying, attacking
    this.target = null;
    this.carrying = null;
    this.attackCooldown = 0;
    this.invuln = 0;
    this.legPhase = Math.random() * Math.PI * 2;
    this.dead = false;
    this.wanderTarget = null;
    this.wanderTimer = 0;
    // Realistic blackened ant body. Player gets a slightly grayer cast plus
    // the gold crown to stand out from friends.
    this.color = isPlayer ? '#161616' : '#0c0a08';
    this.bodyHighlight = isPlayer ? '#3a3a3a' : '#3a2a18';
    this.callTimer = 0;  // for follow timeout
    this.helpTarget = null; // food they're going to help carry
  }

  update(dt, game) {
    if (this.dead) return;

    if (this.attackCooldown > 0) this.attackCooldown -= dt;
    if (this.invuln > 0) this.invuln -= dt;
    if (this.callTimer > 0) this.callTimer -= dt;

    // Terrain effects (slow/HP drain) — ground units only, ignored inside the nest.
    this._terrainSpeedMul = 1;
    // Terrain-immune power-up shields the player from speed/dps penalties.
    const terrainImmune = this.isPlayer && game.activePowerUp === 'terrain';
    if (game.terrain && !inNest(this.x, this.y) && !terrainImmune) {
      const t = game.terrain.getAt(this.x, this.y);
      // First-time terrain hints (player only).
      if (this.isPlayer && game._hintOnce) {
        if (t === 'mud')      game._hintOnce('terrain_mud',      '泥は歩きづらい+体力が減る');
        else if (t === 'pond') game._hintOnce('terrain_pond',     '池は危険! 大幅に減速&HP減少');
        else if (t === 'concrete') game._hintOnce('terrain_concrete','コンクリは強敵が多いが大型餌が落ちている');
        else if (t === 'flower')  game._hintOnce('terrain_flower',  '花畑は餌が多くHPが微回復');
      }
      const def = TERRAIN_DEFS[t];
      if (def) {
        this._terrainSpeedMul = def.speed;
        if (def.dpsOnGround !== 0) {
          this._terrainHpAcc = (this._terrainHpAcc || 0) + dt * 0.001 * def.dpsOnGround;
          if (this._terrainHpAcc >= 1) {
            const dmg = Math.floor(this._terrainHpAcc);
            this._terrainHpAcc -= dmg;
            this.hp = clamp(this.hp - dmg, 0, this.maxHp);
            if (this.hp <= 0) {
              this.hp = 0;
              this.dead = true;
              game.onAntDeath(this);
              return;
            }
          } else if (this._terrainHpAcc <= -1) {
            const heal = Math.floor(-this._terrainHpAcc);
            this._terrainHpAcc += heal;
            this.hp = clamp(this.hp + heal, 0, this.maxHp);
          }
        }
        // Footstep particle (occasional) for noticeable terrains
        if (def.footstepColor && this._moving && Math.random() < 0.04) {
          game.particles.push(new Particle(
            this.x + rand(-3, 3), this.y + 5,
            rand(-0.5, 0.5), rand(-0.4, 0.6),
            rand(250, 450), def.footstepColor, rand(1.5, 2.5)
          ));
        }
      }
    } else {
      this._terrainHpAcc = 0;
    }

    if (this.isPlayer) {
      this.updatePlayer(dt, game);
    } else {
      this.updateFriend(dt, game);
      // Spread out a bit. Skip carriers (their position is driven by Food
      // arrangement) and idle ants deep in the nest (visual cap handles them).
      if (!this.dead && this.state !== 'carrying') {
        const isOutside = !inNest(this.x, this.y);
        const isActive = this.state === 'follow' || this.state === 'attacking';
        if (isOutside || isActive) this._applySeparation(game);
      }
    }

    // Smoothly rotate toward targetAngle
    let da = this.targetAngle - this.angle;
    while (da > Math.PI) da -= Math.PI * 2;
    while (da < -Math.PI) da += Math.PI * 2;
    this.angle += da * Math.min(1, dt * 0.012);

    // Animate legs based on movement
    if (this._moving) {
      this.legPhase += dt * 0.022;
    }
  }

  updatePlayer(dt, game) {
    // Player input is suspended during cinematic camera sequences.
    const input = game.cinematic ? { moving: false, moveX: 0, moveY: 0 } : game.input;
    let moving = false;
    let speed = this.speed;

    // Slow down when carrying heavy food
    if (this.carrying) {
      const carriers = this.carrying.carriers.length;
      const required = this.carrying.required;
      if (required >= 5) speed *= 0.40;
      else if (required >= 3) speed *= 0.55;
      else speed *= 0.85;
      if (game.bonuses && game.bonuses.carrySpeedMul) speed *= game.bonuses.carrySpeedMul;
    }

    // Apply terrain slowdown + event multipliers + power-up dash bonus.
    speed *= this._terrainSpeedMul || 1;
    speed *= game._eventPlayerSpeedMul || 1;
    if (game.activePowerUp === 'dash') speed *= 1.5;

    if (input.moving) {
      const dx = input.moveX;
      const dy = input.moveY;
      const m = Math.hypot(dx, dy);
      if (m > 0.1) {
        const nx = dx / m;
        const ny = dy / m;
        const newX = this.x + nx * speed;
        const newY = this.y + ny * speed;
        // Allow sliding along rock walls: try each axis independently.
        if (game.isWalkableAt(newX, this.y)) this.x = newX;
        if (game.isWalkableAt(this.x, newY)) this.y = newY;
        this.targetAngle = Math.atan2(ny, nx);
        moving = true;
      }
    }
    this._moving = moving;

    // Clamp to world
    this.x = clamp(this.x, 20, WORLD_WIDTH - 20);
    this.y = clamp(this.y, 20, WORLD_HEIGHT - 20);
  }

  updateFriend(dt, game) {
    let moving = false;

    // If carrying food: lead carrier walks to nest; helpers are positioned by Food.update
    if (this.state === 'carrying' && this.carrying && !this.carrying.deposited) {
      const food = this.carrying;
      // Am I the lead carrier?
      if (food.carriers[0] === this) {
        const req = food.required;
        const slow = req >= 8 ? 0.40 : req >= 5 ? 0.50 : req >= 3 ? 0.60 : 0.85;
        const bonus = (game.bonuses && game.bonuses.carrySpeedMul) || 1;
        this.moveToward({ x: NEST_X, y: NEST_Y }, this.speed * slow * bonus, game);
      }
      this._moving = true;
      return;
    } else if (this.state === 'carrying') {
      // food deposited somehow — reset
      this.state = 'follow';
      this.callTimer = 5000;
      this.carrying = null;
    }

    if (this.state === 'attacking' && this.target && !this.target.dead) {
      const d = dist(this, this.target);
      if (d > 26) {
        this.moveToward(this.target, this.speed * 0.95, game);
        moving = true;
      } else if (this.attackCooldown <= 0) {
        if (this.target.takeDamage) this.target.takeDamage(this.attackPower, game, this);
        this.attackCooldown = 700;
        game.spawnHitEffect(this.target.x, this.target.y);
      }
      this._moving = moving;
      return;
    } else if (this.state === 'attacking') {
      // Target dead or gone — defenders return to nest and idle, others follow player.
      this.target = null;
      if (inNest(this.x, this.y)) {
        this.state = 'idle';
      } else {
        this.state = 'follow';
        this.callTimer = 5000;
      }
    }

    if (this.state === 'follow') {
      const player = game.player;
      // Walk in a SINGLE-FILE queue directly behind the player (real ant
      // marching column). Slot is assigned by Game.update.
      const slot = this._followSlot >= 0 ? this._followSlot : 0;
      const facing = player.angle;
      const distBehind = 32 + slot * 22;
      const fx = -Math.cos(facing) * distBehind;
      const fy = -Math.sin(facing) * distBehind;
      // Tiny perpendicular wobble so the line breathes / curves naturally.
      const wobble = Math.sin((this.legPhase || 0) * 1.2 + slot * 0.6) * 4;
      const px = -Math.sin(facing) * wobble;
      const py =  Math.cos(facing) * wobble;
      const target = { x: player.x + fx + px, y: player.y + fy + py };
      const d = dist(this, target);
      if (d > 8) {
        const speedMul = d > 60 ? 0.95 : d > 20 ? 0.7 : 0.4;
        this.moveToward(target, this.speed * speedMul, game);
        moving = true;
      }

      // If player is attacking, join in
      if (player.state === 'attacking-active' && player.target && !player.target.dead) {
        if (dist(this, player.target) < 200) {
          this.state = 'attacking';
          this.target = player.target;
        }
      }

      // Auto-defend: if a nearby enemy is targeting us or close, fight.
      // Grace period: skip auto-defend during the first ~3s after being called
      // so the player can pull friends out of fights to follow them.
      const recentlyCalled = this.callTimer > 9000;
      if (!recentlyCalled) {
        const enemy = game.findClosestEnemy(this.x, this.y, 100);
        if (enemy && (enemy.target === this || dist(this, enemy) < 60)) {
          this.state = 'attacking';
          this.target = enemy;
        }
      }

      // Follow times out — go back to idle when reasonably close to the player.
      if (this.callTimer <= 0 && dist(this, player) < 100) {
        this.state = 'idle';
      }

      this._moving = moving;
      return;
    }

    // idle: defend nest if a raider is inside, otherwise wander.
    // 1) Defend against raiders that breached the nest perimeter
    let defenseTarget = null, ddBest = 200;
    for (const e of game.enemies) {
      if (e.dead) continue;
      // Engage in-nest enemies (raiders) or any nearby enemy hugging the perimeter
      const inN = inNest(e.x, e.y);
      const d = dist(this, e);
      const nearPerimeter = !inN && Math.hypot(e.x - NEST_X, e.y - NEST_Y) < NEST_RADIUS_BASE + 30;
      if ((inN || nearPerimeter) && d < ddBest) {
        defenseTarget = e;
        ddBest = d;
      }
    }
    if (defenseTarget) {
      this.state = 'attacking';
      this.target = defenseTarget;
      this._moving = false;
      return;
    }

    // 2) Wander — and occasionally forage outside the nest. Foraging idle
    // ants pick up unattended small food along the way (see attemptPickup).
    this.wanderTimer -= dt;
    if (!this.wanderTarget || this.wanderTimer <= 0 ||
        dist(this, this.wanderTarget) < 15) {
      // 35% chance to head outside the nest as a forager. If there's any
      // unattended small food nearby, head straight for the closest one.
      const forage = Math.random() < 0.35;
      let target = null;
      if (forage) {
        let best = null, bd = 800;
        for (const f of game.foods) {
          if (f.deposited || f.beingCarried) continue;
          if (f.required > 1) continue;        // scouts only grab small food
          const d = dist(this, f);
          if (d < bd) { bd = d; best = f; }
        }
        if (best) {
          target = { x: best.x, y: best.y };
        } else {
          // Wander outside the nest to scout for more food.
          const a = Math.random() * Math.PI * 2;
          const r = rand(NEST_RADIUS_BASE + 80, NEST_RADIUS_BASE + 280);
          target = { x: NEST_X + Math.cos(a) * r, y: NEST_Y + Math.sin(a) * r };
        }
      } else {
        const a = Math.random() * Math.PI * 2;
        const r = Math.random() * (NEST_RADIUS_BASE * 0.8);
        target = { x: NEST_X + Math.cos(a) * r, y: NEST_Y + Math.sin(a) * r };
      }
      this.wanderTarget = target;
      this.wanderTimer = rand(2200, 4500);
    }
    const wspeed = inNest(this.x, this.y) ? this.speed * 0.35 : this.speed * 0.6;
    this.moveToward(this.wanderTarget, wspeed, game);
    moving = true;
    this._moving = moving;
  }

  moveToward(target, spd, game) {
    const dx = target.x - this.x;
    const dy = target.y - this.y;
    const d = Math.hypot(dx, dy);
    if (d > 0.5) {
      const eff = spd * (this._terrainSpeedMul || 1);
      const stepX = (dx / d) * eff;
      const stepY = (dy / d) * eff;
      const newX = this.x + stepX;
      const newY = this.y + stepY;
      if (!game || game.isWalkableAt(newX, this.y)) this.x = newX;
      if (!game || game.isWalkableAt(this.x, newY)) this.y = newY;
      this.targetAngle = Math.atan2(dy, dx);
    }
  }

  // Separation force: push slightly away from other nearby friends so the
  // colony doesn't visually pile up — they form ranks/lines/rings instead.
  // Walkability is respected so ants won't get pushed into walls.
  _applySeparation(game) {
    const SEP_R = 22;
    const SEP_F = 0.45;
    let pushX = 0, pushY = 0;
    let pairs = 0;
    for (const f of game.friends) {
      if (f === this || f.dead) continue;
      const dx = this.x - f.x;
      const dy = this.y - f.y;
      // Cheap bbox prefilter
      if (dx > SEP_R || dx < -SEP_R || dy > SEP_R || dy < -SEP_R) continue;
      const d = Math.hypot(dx, dy);
      if (d < SEP_R && d > 0.01) {
        const m = ((SEP_R - d) / SEP_R) * SEP_F;
        pushX += (dx / d) * m;
        pushY += (dy / d) * m;
        if (++pairs > 8) break;  // limit to nearest few
      }
    }
    // Also keep some space from the player while following (no crowding).
    if (this.state === 'follow' && game.player && !game.player.dead) {
      const dx = this.x - game.player.x;
      const dy = this.y - game.player.y;
      const d = Math.hypot(dx, dy);
      if (d < 16 && d > 0.01) {
        const m = ((16 - d) / 16) * 0.5;
        pushX += (dx / d) * m;
        pushY += (dy / d) * m;
      }
    }
    if (pushX !== 0 || pushY !== 0) {
      const newX = this.x + pushX;
      const newY = this.y + pushY;
      if (game.isWalkableAt(newX, this.y)) this.x = newX;
      if (game.isWalkableAt(this.x, newY)) this.y = newY;
    }
  }

  takeDamage(dmg, game, attacker) {
    if (this.dead || this.invuln > 0) return;
    // Invuln power-up shields the player completely.
    if (this.isPlayer && game && game.activePowerUp === 'invuln') {
      this.invuln = 200;  // tiny invuln to prevent retaliation spam
      return;
    }
    this.hp -= dmg;
    this.invuln = 250;
    game.spawnDamageNumber(this.x, this.y - 15, dmg, this.isPlayer ? '#ff6464' : '#ffaa64');
    if (this.hp <= 0) {
      this.hp = 0;
      this.dead = true;
      game.onAntDeath(this);
    } else {
      // Friends fight back when attacked
      if (!this.isPlayer && attacker && this.state !== 'carrying') {
        this.state = 'attacking';
        this.target = attacker;
      }
    }
  }

  draw(ctx) {
    if (this.dead) return;
    // Giant power-up: scale up entire player rendering ×1.6 (visual + bigger
    // hitbox feel — collisions stay normal-sized for game balance).
    let drawScale = 1;
    if (this.isPlayer && window.game && window.game.activePowerUp === 'giant') {
      drawScale = 1.6;
    }
    if (drawScale !== 1) {
      ctx.save();
      ctx.translate(this.x, this.y);
      ctx.scale(drawScale, drawScale);
      ctx.translate(-this.x, -this.y);
    }
    // Gold-skin glow (player only): drawn before any rotation.
    if (this.isPlayer && this._skinGlow) {
      ctx.save();
      const t = (this.legPhase || 0) * 0.5;
      const pulse = 0.55 + 0.45 * Math.sin(t);
      const glow = ctx.createRadialGradient(this.x, this.y, 0, this.x, this.y, this.size + 14);
      glow.addColorStop(0, `rgba(255, 215, 60, ${0.55 * pulse})`);
      glow.addColorStop(1, 'rgba(255, 215, 60, 0)');
      ctx.fillStyle = glow;
      ctx.beginPath();
      ctx.arc(this.x, this.y, this.size + 14, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
    ctx.save();
    ctx.translate(this.x, this.y);
    ctx.rotate(this.angle + Math.PI / 2);

    if (this.invuln > 0 && Math.floor(this.invuln / 60) % 2 === 0) {
      ctx.globalAlpha = 0.45;
    }

    // ===== Cute / pop-style ant rendering =====
    // Big head + small round body + chunky legs + huge eyes. Walking bob
    // gives the line of ants a fun marching feel.
    const s = this.size / 11;
    const moving = this._moving;
    const swingA = Math.sin(this.legPhase) * 1.2;
    const swingB = Math.sin(this.legPhase + Math.PI) * 1.2;
    const bob = moving ? Math.sin(this.legPhase * 2) * 0.8 : 0;
    const outline = 'rgba(0,0,0,0.55)';

    // Slim 6 legs (3 left, 3 right). Drawn under body.
    ctx.strokeStyle = this.color;
    ctx.lineWidth = 1.6 * s;
    ctx.lineCap = 'round';
    const legSpec = [
      { y: -2.0 * s, swing: swingA },
      { y:  1.5 * s, swing: swingB },
      { y:  5.0 * s, swing: swingA }
    ];
    for (const L of legSpec) {
      ctx.beginPath();
      ctx.moveTo(-1.8 * s, L.y);
      ctx.quadraticCurveTo(-5 * s, L.y + L.swing, -7 * s, L.y + 1 + L.swing * 1.6);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(1.8 * s, L.y);
      ctx.quadraticCurveTo(5 * s, L.y - L.swing, 7 * s, L.y + 1 - L.swing * 1.6);
      ctx.stroke();
    }

    // Slim 3-segment body: abdomen (rear) + thorax (waist) + head.
    // Rear abdomen
    ctx.fillStyle = this.color;
    ctx.strokeStyle = outline;
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.ellipse(0, 5.5 * s + bob, 3.3 * s, 5.0 * s, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    // Subtle body highlight
    ctx.fillStyle = this.bodyHighlight;
    ctx.beginPath();
    ctx.ellipse(-0.9 * s, 4.5 * s + bob, 0.9 * s, 1.8 * s, 0, 0, Math.PI * 2);
    ctx.fill();

    // Thin thorax (waist)
    ctx.fillStyle = this.color;
    ctx.beginPath();
    ctx.ellipse(0, 0.5 * s + bob * 0.7, 1.9 * s, 2.0 * s, 0, 0, Math.PI * 2);
    ctx.fill();

    // Head (slimmer than before)
    ctx.fillStyle = this.color;
    ctx.beginPath();
    ctx.arc(0, -4.0 * s + bob * 0.6, 4.4 * s, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = outline;
    ctx.lineWidth = 1.2;
    ctx.stroke();
    // Head highlight (sheen on left)
    ctx.fillStyle = this.bodyHighlight;
    ctx.beginPath();
    ctx.ellipse(-1.6 * s, -5.0 * s + bob * 0.6, 1.2 * s, 1.5 * s, 0, 0, Math.PI * 2);
    ctx.fill();

    // Round eyes (whites + pupils + sparkle)
    const eyeOff = 1.7 * s;
    const eyeY = -4.6 * s + bob * 0.6;
    const eyeR = 1.4 * s;
    ctx.fillStyle = '#fff';
    ctx.strokeStyle = outline;
    ctx.lineWidth = 1.0;
    ctx.beginPath(); ctx.arc(-eyeOff, eyeY, eyeR, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    ctx.beginPath(); ctx.arc( eyeOff, eyeY, eyeR, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    // Pupils
    ctx.fillStyle = '#1a1a1a';
    ctx.beginPath(); ctx.arc(-eyeOff, eyeY + 0.2 * s, 0.85 * s, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.arc( eyeOff, eyeY + 0.2 * s, 0.85 * s, 0, Math.PI * 2); ctx.fill();
    // Eye sparkle
    ctx.fillStyle = '#fff';
    ctx.beginPath(); ctx.arc(-eyeOff + 0.4 * s, eyeY - 0.3 * s, 0.4 * s, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.arc( eyeOff + 0.4 * s, eyeY - 0.3 * s, 0.4 * s, 0, Math.PI * 2); ctx.fill();

    // Tiny smile
    ctx.strokeStyle = '#1a1a1a';
    ctx.lineWidth = 0.9;
    ctx.beginPath();
    ctx.arc(0, -2.4 * s + bob * 0.6, 1.3 * s, 0.15 * Math.PI, 0.85 * Math.PI);
    ctx.stroke();

    // Antennae with little ball tips
    const antBob = Math.sin(this.legPhase * 2 + 1.2) * 0.4;
    ctx.strokeStyle = this.color;
    ctx.lineWidth = 1.4 * s;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(-1.8 * s, -8.2 * s);
    ctx.quadraticCurveTo(-3.5 * s + antBob, -10 * s, -3.0 * s + antBob, -12.0 * s);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo( 1.8 * s, -8.2 * s);
    ctx.quadraticCurveTo( 3.5 * s - antBob, -10 * s,  3.0 * s - antBob, -12.0 * s);
    ctx.stroke();
    // Tips
    ctx.fillStyle = this.color;
    ctx.beginPath(); ctx.arc(-3.0 * s + antBob, -12.0 * s, 0.95 * s, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.arc( 3.0 * s - antBob, -12.0 * s, 0.95 * s, 0, Math.PI * 2); ctx.fill();

    ctx.restore();

    // HP bar (above head) — only show when injured
    if (this.hp < this.maxHp) {
      const w = 22;
      const h = 3;
      const bx = this.x - w / 2;
      const by = this.y - this.size - 12;
      ctx.fillStyle = 'rgba(0,0,0,0.5)';
      ctx.fillRect(bx - 1, by - 1, w + 2, h + 2);
      const ratio = this.hp / this.maxHp;
      ctx.fillStyle = ratio > 0.5 ? '#5cdb4f' : ratio > 0.25 ? '#ffaa00' : '#ff4040';
      ctx.fillRect(bx, by, w * ratio, h);
    }

    // Player crown indicator
    if (this.isPlayer) {
      ctx.fillStyle = '#ffd700';
      ctx.beginPath();
      ctx.moveTo(this.x - 5, this.y - this.size - 16);
      ctx.lineTo(this.x - 3, this.y - this.size - 20);
      ctx.lineTo(this.x, this.y - this.size - 17);
      ctx.lineTo(this.x + 3, this.y - this.size - 20);
      ctx.lineTo(this.x + 5, this.y - this.size - 16);
      ctx.closePath();
      ctx.fill();
    }
    // Close the giant-scale transform block, if it was opened.
    if (drawScale !== 1) ctx.restore();
  }
}

// ---------- Food ----------
// ---------- Food ----------
const FOOD_DEFS = {
  small:  { required: 1,  eggs: 1,  size: 9,  color: '#caa37c', label: '小' },
  acorn:  { required: 2,  eggs: 3,  size: 14, color: '#a06030', label: 'どんぐり' },
  medium: { required: 3,  eggs: 4,  size: 16, color: '#5fa83a', label: '中' },
  berry:  { required: 4,  eggs: 6,  size: 20, color: '#d63a4a', label: 'いちご' },
  large:  { required: 5,  eggs: 7,  size: 24, color: '#cc4848', label: '大' },
  huge:   { required: 8,  eggs: 11, size: 32, color: '#d4a050', label: '特大' },
  giant:  { required: 12, eggs: 18, size: 42, color: '#e07ab0', label: '超特大' },
  honey:  { required: 6,  eggs: 20, size: 36, color: '#f9c11e', label: 'ハチミツ' }
};

// Per-terrain egg-yield multiplier — harsher terrain rewards more eggs.
const FOOD_TERRAIN_EGG_BONUS = {
  grass: 1.0, sand: 1.0, leaves: 1.1, flower: 1.0, mud: 1.4, concrete: 1.5, pond: 1.0
};

class Food {
  constructor(x, y, type) {
    this.x = x;
    this.y = y;
    this.type = type;
    const def = FOOD_DEFS[type] || FOOD_DEFS.small;
    this.required = def.required;
    this.eggs = def.eggs;
    this.size = def.size;
    this.color = def.color;
    this.label = def.label;
    this.carriers = [];
    this.beingCarried = false;
    this.deposited = false;
    this.bobble = Math.random() * Math.PI * 2;
    // eggBonus is set after construction by spawnFood based on terrain.
    this.eggBonus = 1.0;
  }

  update(dt, game) {
    this.bobble += dt * 0.003;

    if (this.beingCarried && this.carriers.length > 0) {
      // Drop dead carriers first
      const aliveCarriers = this.carriers.filter(c => !c.dead);
      this.carriers = aliveCarriers;

      if (this.carriers.length < this.required) {
        this.dropFood(game);
        return;
      }

      // Lead carrier (index 0) drives position
      const lead = this.carriers[0];
      // Weighted average — lead has 1.5x weight
      let sx = lead.x * 1.5, sy = lead.y * 1.5, w = 1.5;
      for (let i = 1; i < this.carriers.length; i++) {
        sx += this.carriers[i].x;
        sy += this.carriers[i].y;
        w++;
      }
      this.x = sx / w;
      this.y = sy / w;

      // Position helper carriers around food (lerp toward target ring)
      const helpers = this.carriers.filter(c => c !== lead);
      helpers.forEach((c, i) => {
        const angle = (i / Math.max(1, helpers.length)) * Math.PI * 2 + this.bobble * 0.3;
        const r = this.size + 12;
        c.x = lerp(c.x, this.x + Math.cos(angle) * r, 0.18);
        c.y = lerp(c.y, this.y + Math.sin(angle) * r, 0.18);
        c.targetAngle = Math.atan2(this.y - c.y, this.x - c.x);
        c._moving = true;
      });

      // Check if reached egg room — deposit
      if (inEggRoom(this.x, this.y) && !this.deposited) {
        this.deposit(game);
      }
    }
  }

  dropFood(game) {
    this.beingCarried = false;
    this.carriers.forEach(c => {
      if (c.isPlayer) {
        c.carrying = null;
      } else {
        c.carrying = null;
        c.state = 'follow';
        c.callTimer = 5000;
      }
    });
    this.carriers = [];
    game.showMessage('餌を落とした…仲間が足りない！', 'warn');
  }

  deposit(game) {
    this.deposited = true;
    this.beingCarried = false;
    // Free carriers — keep them following the player so they continue to be useful
    this.carriers.forEach(c => {
      c.carrying = null;
      if (!c.isPlayer) {
        c.state = 'follow';
        c.callTimer = 8000;
        c.target = null;
      }
    });
    this.carriers = [];
    // Spawn eggs. Harsh-terrain bonus rewards exploration on mud/concrete.
    const eggsToSpawn = Math.max(1, Math.round(this.eggs * (this.eggBonus || 1)));
    const hatchMul = (game.bonuses && game.bonuses.hatchTimeMul) || 1;
    for (let i = 0; i < eggsToSpawn; i++) {
      const a = Math.random() * Math.PI * 2;
      const r = Math.random() * (EGG_ROOM_RADIUS - 15);
      const eg = new Egg(NEST_X + Math.cos(a) * r, NEST_Y + Math.sin(a) * r);
      eg.timer *= hatchMul;
      eg.maxTimer = eg.timer;
      game.eggs.push(eg);
    }
    game.spawnDepositEffect(this.x, this.y);
    const terrainBonus = eggsToSpawn - this.eggs;
    const bonusTxt = terrainBonus > 0 ? ` (地形+${terrainBonus})` : '';
    game.showMessage(`巣に運んだ！ 卵 +${eggsToSpawn}${bonusTxt}`, 'success');
    if (game.audio) game.audio.play('deposit');
    if (game._advanceTutorial) game._advanceTutorial('deposit');
    if (game._statBump) game._statBump('deposits');
    if (game.saveGame) game.saveGame();
  }

  draw(ctx) {
    if (this.deposited) return;
    ctx.save();
    const bob = this.beingCarried ? Math.sin(this.bobble * 4) * 1.5 : 0;
    ctx.translate(this.x, this.y + bob);

    // Shadow
    ctx.fillStyle = 'rgba(0,0,0,0.3)';
    ctx.beginPath();
    ctx.ellipse(0, this.size * 0.7, this.size * 0.9, this.size * 0.3, 0, 0, Math.PI * 2);
    ctx.fill();

    // Visibility halo — soft warm glow that makes food stand out against
    // grass/leaves/etc. especially on small mobile screens. Stronger for
    // smaller foods (which would otherwise blend in). Honey has its own glow.
    if (!this.beingCarried && this.type !== 'honey') {
      const auraScale = this.type === 'small'  ? 2.6
                      : this.type === 'medium' ? 2.0
                      : 1.6;
      const auraR = this.size * auraScale;
      const pulse = 0.6 + 0.4 * Math.sin(this.bobble * 1.4);
      const grad = ctx.createRadialGradient(0, 0, 0, 0, 0, auraR);
      grad.addColorStop(0, `rgba(255, 232, 140, ${0.55 * pulse})`);
      grad.addColorStop(0.55, `rgba(255, 220, 120, ${0.18 * pulse})`);
      grad.addColorStop(1, 'rgba(255, 220, 120, 0)');
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(0, 0, auraR, 0, Math.PI * 2);
      ctx.fill();
    }

    // Bonus ring for harsh-terrain food (risk-reward indicator)
    if (this.eggBonus && this.eggBonus > 1.0 && this.type !== 'honey') {
      const pulse = 0.6 + 0.4 * Math.sin(this.bobble * 2);
      ctx.strokeStyle = `rgba(255, 200, 50, ${0.5 * pulse})`;
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.arc(0, 0, this.size + 5, 0, Math.PI * 2);
      ctx.stroke();
    }

    if (this.type === 'small') {
      // Seed
      ctx.fillStyle = this.color;
      ctx.beginPath();
      ctx.moveTo(-this.size, 0);
      ctx.quadraticCurveTo(-this.size * 0.5, -this.size, 0, -this.size * 0.6);
      ctx.quadraticCurveTo(this.size * 0.7, -this.size * 0.7, this.size, 0);
      ctx.quadraticCurveTo(this.size * 0.5, this.size * 0.7, 0, this.size * 0.5);
      ctx.quadraticCurveTo(-this.size * 0.7, this.size * 0.5, -this.size, 0);
      ctx.fill();
      ctx.fillStyle = '#e8c89c';
      ctx.beginPath();
      ctx.ellipse(-this.size * 0.3, -this.size * 0.3, this.size * 0.3, this.size * 0.2, 0, 0, Math.PI * 2);
      ctx.fill();
    } else if (this.type === 'acorn') {
      // Acorn — round nut body with a textured cap on top.
      const sz = this.size;
      // Nut body
      ctx.fillStyle = '#bf8050';
      ctx.beginPath();
      ctx.ellipse(0, sz * 0.15, sz * 0.75, sz * 0.85, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#985a25';
      ctx.beginPath();
      ctx.ellipse(sz * 0.18, sz * 0.4, sz * 0.4, sz * 0.4, 0, 0, Math.PI * 2);
      ctx.fill();
      // Highlight
      ctx.fillStyle = 'rgba(255, 230, 180, 0.5)';
      ctx.beginPath();
      ctx.ellipse(-sz * 0.3, -sz * 0.1, sz * 0.25, sz * 0.4, -0.2, 0, Math.PI * 2);
      ctx.fill();
      // Cap (textured top)
      ctx.fillStyle = '#5e3a1c';
      ctx.beginPath();
      ctx.arc(0, -sz * 0.45, sz * 0.85, 0, Math.PI, true);
      ctx.fill();
      // Cap dots
      ctx.fillStyle = '#3a230f';
      for (let i = 0; i < 5; i++) {
        const dx = (-0.6 + i * 0.3) * sz;
        const dy = -sz * (0.55 + (i % 2) * 0.05);
        ctx.beginPath();
        ctx.arc(dx, dy, 1.6, 0, Math.PI * 2);
        ctx.fill();
      }
      // Stem
      ctx.strokeStyle = '#3a2310';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(0, -sz * 1.1);
      ctx.lineTo(0, -sz * 1.4);
      ctx.stroke();
    } else if (this.type === 'berry') {
      // Strawberry — red bumpy heart-ish shape with green leaves on top.
      const sz = this.size;
      ctx.fillStyle = this.color;
      ctx.beginPath();
      ctx.moveTo(0, sz);
      ctx.bezierCurveTo(sz * 1.2, sz * 0.5, sz * 1.0, -sz * 0.3, 0, -sz * 0.3);
      ctx.bezierCurveTo(-sz * 1.0, -sz * 0.3, -sz * 1.2, sz * 0.5, 0, sz);
      ctx.fill();
      // Seeds
      ctx.fillStyle = '#ffe680';
      const seedSpots = [
        [-0.4, -0.05], [0.3, -0.05], [-0.15, 0.25],
        [0.45, 0.30], [-0.35, 0.55], [0.10, 0.55],
        [-0.05, 0.80], [0.30, 0.75]
      ];
      for (const [sx, sy] of seedSpots) {
        ctx.beginPath();
        ctx.ellipse(sx * sz, sy * sz, 1.6, 1.0, 0.6, 0, Math.PI * 2);
        ctx.fill();
      }
      // Highlight
      ctx.fillStyle = 'rgba(255, 220, 220, 0.5)';
      ctx.beginPath();
      ctx.ellipse(-sz * 0.4, sz * 0.15, sz * 0.18, sz * 0.30, -0.3, 0, Math.PI * 2);
      ctx.fill();
      // Leaves on top
      ctx.fillStyle = '#3d8a25';
      for (let i = -2; i <= 2; i++) {
        const a = i * 0.45;
        ctx.save();
        ctx.translate(0, -sz * 0.35);
        ctx.rotate(a);
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.quadraticCurveTo(sz * 0.18, -sz * 0.32, 0, -sz * 0.42);
        ctx.quadraticCurveTo(-sz * 0.18, -sz * 0.32, 0, 0);
        ctx.fill();
        ctx.restore();
      }
    } else if (this.type === 'medium') {
      // Leaf
      ctx.fillStyle = this.color;
      ctx.beginPath();
      ctx.ellipse(0, 0, this.size * 0.7, this.size, Math.PI / 6, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = '#3d7a25';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(-this.size * 0.4, this.size * 0.7);
      ctx.lineTo(this.size * 0.4, -this.size * 0.7);
      ctx.stroke();
      ctx.lineWidth = 1;
      for (let i = -2; i <= 2; i++) {
        ctx.beginPath();
        ctx.moveTo(0, i * this.size * 0.3);
        ctx.lineTo(this.size * 0.35 - Math.abs(i) * 2, i * this.size * 0.3 - this.size * 0.2);
        ctx.stroke();
      }
    } else if (this.type === 'large') {
      // Apple
      ctx.fillStyle = this.color;
      ctx.beginPath();
      ctx.arc(0, 0, this.size, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#aa3030';
      ctx.beginPath();
      ctx.arc(this.size * 0.3, this.size * 0.3, this.size * 0.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,0.35)';
      ctx.beginPath();
      ctx.ellipse(-this.size * 0.4, -this.size * 0.4, this.size * 0.3, this.size * 0.2, -0.4, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = '#5a3a1a';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(0, -this.size);
      ctx.lineTo(2, -this.size - 6);
      ctx.stroke();
    } else if (this.type === 'huge') {
      // Bread roll
      ctx.fillStyle = this.color;
      ctx.beginPath();
      ctx.ellipse(0, 0, this.size, this.size * 0.75, 0, 0, Math.PI * 2);
      ctx.fill();
      // crust shading
      ctx.fillStyle = '#a87838';
      ctx.beginPath();
      ctx.ellipse(0, this.size * 0.3, this.size * 0.9, this.size * 0.3, 0, 0, Math.PI * 2);
      ctx.fill();
      // score lines
      ctx.strokeStyle = '#7a5020';
      ctx.lineWidth = 2;
      for (let i = -1; i <= 1; i++) {
        ctx.beginPath();
        ctx.moveTo(i * this.size * 0.4, -this.size * 0.5);
        ctx.lineTo(i * this.size * 0.4 + 4, this.size * 0.4);
        ctx.stroke();
      }
      // highlight
      ctx.fillStyle = 'rgba(255,240,200,0.4)';
      ctx.beginPath();
      ctx.ellipse(-this.size * 0.3, -this.size * 0.4, this.size * 0.4, this.size * 0.2, 0, 0, Math.PI * 2);
      ctx.fill();
    } else if (this.type === 'giant') {
      // Cake/donut with frosting
      ctx.fillStyle = '#a06038';
      ctx.beginPath();
      ctx.arc(0, 0, this.size, 0, Math.PI * 2);
      ctx.fill();
      // frosting top
      ctx.fillStyle = this.color;
      ctx.beginPath();
      ctx.arc(0, -this.size * 0.15, this.size * 0.85, 0, Math.PI * 2);
      ctx.fill();
      // frosting drip
      ctx.beginPath();
      for (let i = 0; i < 12; i++) {
        const a = (i / 12) * Math.PI * 2;
        const r1 = this.size * 0.85;
        const dx = Math.cos(a) * r1;
        const dy = -this.size * 0.15 + Math.sin(a) * r1;
        if (i === 0) ctx.moveTo(dx, dy);
        else ctx.lineTo(dx, dy + Math.sin(a * 3) * 3);
      }
      ctx.closePath();
      ctx.fill();
      // sprinkles
      const sprinkleColors = ['#ffeb3b', '#4caf50', '#2196f3', '#ff5722', '#fff'];
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * Math.PI * 2 + this.bobble * 0.1;
        const r = this.size * 0.45;
        ctx.fillStyle = sprinkleColors[i % sprinkleColors.length];
        ctx.save();
        ctx.translate(Math.cos(a) * r, -this.size * 0.2 + Math.sin(a) * r);
        ctx.rotate(a);
        ctx.fillRect(-3, -1, 6, 2);
        ctx.restore();
      }
      // highlight
      ctx.fillStyle = 'rgba(255,255,255,0.3)';
      ctx.beginPath();
      ctx.ellipse(-this.size * 0.4, -this.size * 0.45, this.size * 0.4, this.size * 0.15, -0.3, 0, Math.PI * 2);
      ctx.fill();
    } else if (this.type === 'honey') {
      // Honey jar: golden pot + glowing aura + sparkles
      const sz = this.size;
      // Glow
      const glow = ctx.createRadialGradient(0, 0, 0, 0, 0, sz * 1.6);
      glow.addColorStop(0, 'rgba(255, 220, 80, 0.55)');
      glow.addColorStop(1, 'rgba(255, 220, 80, 0)');
      ctx.fillStyle = glow;
      ctx.beginPath();
      ctx.arc(0, 0, sz * 1.6, 0, Math.PI * 2);
      ctx.fill();
      // Pot body (rounded jar)
      ctx.fillStyle = '#c08020';
      ctx.beginPath();
      ctx.ellipse(0, sz * 0.15, sz * 0.85, sz * 0.95, 0, 0, Math.PI * 2);
      ctx.fill();
      // Honey overflowing top
      ctx.fillStyle = '#f9c11e';
      ctx.beginPath();
      ctx.ellipse(0, -sz * 0.55, sz * 0.7, sz * 0.25, 0, 0, Math.PI * 2);
      ctx.fill();
      // Drip
      ctx.beginPath();
      ctx.moveTo(-sz * 0.5, -sz * 0.5);
      ctx.bezierCurveTo(-sz * 0.55, -sz * 0.2, -sz * 0.4, sz * 0.05, -sz * 0.3, sz * 0.1);
      ctx.lineTo(-sz * 0.2, sz * 0.05);
      ctx.bezierCurveTo(-sz * 0.25, -sz * 0.2, -sz * 0.4, -sz * 0.4, -sz * 0.45, -sz * 0.5);
      ctx.closePath();
      ctx.fill();
      // Pot rim
      ctx.fillStyle = '#a0681c';
      ctx.beginPath();
      ctx.ellipse(0, -sz * 0.55, sz * 0.75, sz * 0.13, 0, 0, Math.PI * 2);
      ctx.fill();
      // Highlight
      ctx.fillStyle = 'rgba(255, 255, 220, 0.5)';
      ctx.beginPath();
      ctx.ellipse(-sz * 0.4, sz * 0.05, sz * 0.18, sz * 0.4, -0.2, 0, Math.PI * 2);
      ctx.fill();
      // Floating sparkles
      ctx.fillStyle = '#fff8a0';
      for (let i = 0; i < 4; i++) {
        const a = this.bobble * 1.2 + i * Math.PI / 2;
        const r = sz * 1.1;
        ctx.beginPath();
        ctx.arc(Math.cos(a) * r, Math.sin(a) * r * 0.6 - sz * 0.6, 1.6, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    ctx.restore();

    // Required ants badge
    if (!this.beingCarried && this.required > 1) {
      const badgeW = 38;
      const badgeH = 16;
      ctx.fillStyle = 'rgba(0,0,0,0.75)';
      if (ctx.roundRect) {
        ctx.beginPath();
        ctx.roundRect(this.x - badgeW / 2, this.y - this.size - 22, badgeW, badgeH, 7);
        ctx.fill();
      } else {
        ctx.fillRect(this.x - badgeW / 2, this.y - this.size - 22, badgeW, badgeH);
      }
      ctx.fillStyle = this.required >= 8 ? '#ffaa55' : '#fff';
      ctx.font = 'bold 11px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(`🐜x${this.required}`, this.x, this.y - this.size - 14);
    }
  }
}

// ---------- Egg ----------
class Egg {
  constructor(x, y) {
    this.x = x;
    this.y = y;
    this.timer = FOOD_HATCH_TIME;
    this.maxTimer = FOOD_HATCH_TIME;
    this.hatched = false;
    this.wobble = Math.random() * Math.PI * 2;
    this.maxHp = 30;
    this.hp = this.maxHp;
    this.dead = false;
    this.size = 7;
    this.invuln = 0;
  }

  update(dt) {
    if (this.invuln > 0) this.invuln -= dt;
    this.timer -= dt;
    this.wobble += dt * 0.005;
    if (this.timer <= 0) this.hatched = true;
  }

  takeDamage(dmg, game, attacker) {
    if (this.dead || this.hatched || this.invuln > 0) return;
    this.hp -= dmg;
    this.invuln = 100;
    game.spawnDamageNumber(this.x, this.y - 10, dmg, '#ff7777');
    // Alert nearby idle friends about the threat
    if (game.alertNearbyFriends) game.alertNearbyFriends(this.x, this.y, 110, attacker);
    if (this.hp <= 0) {
      this.hp = 0;
      this.dead = true;
      game.spawnEnemyDeath(this.x, this.y, 0.5);
      game.showMessage('卵が壊された…', 'warn', 1500);
    }
  }

  draw(ctx) {
    const progress = 1 - this.timer / this.maxTimer;
    const wobble = this.timer < 1500 ? Math.sin(this.wobble * 8) * 1.5 : 0;
    ctx.save();
    ctx.translate(this.x + wobble, this.y);
    // shadow
    ctx.fillStyle = 'rgba(0,0,0,0.3)';
    ctx.beginPath();
    ctx.ellipse(0, 7, 6, 2, 0, 0, Math.PI * 2);
    ctx.fill();
    // egg body
    ctx.fillStyle = '#fff8e0';
    ctx.beginPath();
    ctx.ellipse(0, 0, 5, 7, 0, 0, Math.PI * 2);
    ctx.fill();
    // shading
    ctx.fillStyle = 'rgba(180,160,120,0.4)';
    ctx.beginPath();
    ctx.ellipse(1.5, 1.5, 2, 3, 0, 0, Math.PI * 2);
    ctx.fill();
    // progress crack
    if (progress > 0.5) {
      ctx.strokeStyle = '#8b6f4a';
      ctx.lineWidth = 0.8;
      ctx.beginPath();
      ctx.moveTo(-2, -3);
      ctx.lineTo(0, -1);
      ctx.lineTo(-1, 1);
      ctx.lineTo(2, 3);
      ctx.stroke();
    }
    ctx.restore();

    // Damage HP bar (only when injured)
    if (this.hp < this.maxHp && !this.dead) {
      const w = 16;
      const h = 2;
      const bx = this.x - w / 2;
      const by = this.y - 11;
      ctx.fillStyle = 'rgba(0,0,0,0.5)';
      ctx.fillRect(bx - 1, by - 1, w + 2, h + 2);
      ctx.fillStyle = '#ff5050';
      ctx.fillRect(bx, by, w * (this.hp / this.maxHp), h);
    }
  }
}

// ---------- Enemy (Spider) ----------
// ---------- Enemy types ----------
const ENEMY_DEFS = {
  spider: {
    maxHp: 45, attackPower: 8, speed: 1.4, size: 22,
    detectRange: 140, attackRange: 28, attackCooldownMax: 1100,
    color: '#502050', headColor: '#3d1a3d', legColor: '#2a0d2a', markColor: '#7a307a'
  },
  beetle: {
    // Slow, tough, charges in straight line
    maxHp: 95, attackPower: 14, speed: 0.95, size: 28,
    detectRange: 160, attackRange: 32, attackCooldownMax: 1600,
    color: '#3a4a1a', headColor: '#1f2a10', legColor: '#1a1a0a', markColor: '#6a8a30'
  },
  wasp: {
    // Fast, fragile, hover-and-dive
    maxHp: 28, attackPower: 6, speed: 2.5, size: 18,
    detectRange: 200, attackRange: 22, attackCooldownMax: 800,
    color: '#e0b020', headColor: '#3a2a08', legColor: '#1a1408', markColor: '#1a1408'
  },
  hornet: {
    // Faster, redder wasp — bigger threat, hover-and-dive (reuses wasp brain).
    maxHp: 55, attackPower: 11, speed: 3.0, size: 22,
    detectRange: 230, attackRange: 22, attackCooldownMax: 700,
    color: '#d04020', headColor: '#5a0e0e', legColor: '#2a0d0a', markColor: '#1a1408',
    behavior: 'wasp'
  },
  scorpion: {
    // Beetle-style charger with a venom sting; tougher than beetle.
    maxHp: 130, attackPower: 16, speed: 1.05, size: 30,
    detectRange: 170, attackRange: 34, attackCooldownMax: 1400,
    color: '#7a4030', headColor: '#3a1a0d', legColor: '#1a0a05', markColor: '#a8704a',
    behavior: 'beetle'
  },
  slug: {
    // Very slow, very tanky melee — uses spider brain but plodding.
    maxHp: 200, attackPower: 18, speed: 0.55, size: 30,
    detectRange: 130, attackRange: 30, attackCooldownMax: 1700,
    color: '#7a8830', headColor: '#3a4515', legColor: '#3a4515', markColor: '#a4b85a',
    behavior: 'spider'
  }
};

class Enemy {
  constructor(x, y, type = 'spider', powerScale = 1, isRaider = false) {
    this.x = x;
    this.y = y;
    this.startX = x;
    this.startY = y;
    this.type = type;
    const def = ENEMY_DEFS[type] || ENEMY_DEFS.spider;
    this.powerScale = powerScale;
    this.isRaider = isRaider;
    // Raiders have boosted detection range to home in on the nest from far away
    this.maxHp = Math.round(def.maxHp * powerScale);
    this.hp = this.maxHp;
    this.attackPower = Math.round(def.attackPower * powerScale);
    this.speed = def.speed;
    this.size = Math.round(def.size * (1 + (powerScale - 1) * 0.4));
    this.behavior = def.behavior || type;
    this.detectRange = isRaider ? Math.max(def.detectRange, 9999) : def.detectRange;
    this.attackRange = def.attackRange;
    this.attackCooldownMax = def.attackCooldownMax;
    this.color = def.color;
    this.headColor = def.headColor;
    this.legColor = def.legColor;
    this.markColor = def.markColor;

    this.angle = 0;
    this.targetAngle = 0;
    this.target = null;
    this.attackCooldown = 0;
    this.invuln = 0;
    this.legPhase = Math.random() * Math.PI * 2;
    this.dead = false;
    this.wanderTimer = 0;
    this.wanderTarget = null;
    this._moving = false;
    this.wingPhase = Math.random() * Math.PI * 2;

    // Type-specific state
    this.behaviorState = 'approach'; // approach | charging | dashing | hover | dive | retreat
    this.behaviorTimer = 0;
    this.dashAngle = 0;
    this.diveStart = null;
    this.actionPhase = 0; // for visual effects
  }

  findTarget(game) {
    if (this.isRaider) {
      // Priority: nearest egg → nearest friend (incl. in-nest) → player → nest center
      let best = null, bestD = Infinity;
      for (const eg of game.eggs) {
        if (eg.hatched || eg.dead) continue;
        const d = dist(this, eg);
        if (d < bestD) { bestD = d; best = eg; }
      }
      if (!best) {
        for (const f of game.friends) {
          if (f.dead) continue;
          const d = dist(this, f);
          if (d < bestD) { bestD = d; best = f; }
        }
      }
      if (!best && !game.player.dead) {
        best = game.player;
      }
      if (!best) {
        best = { x: NEST_X, y: NEST_Y, _isNestCenter: true, dead: false };
      }
      this.target = best;
      return;
    }
    let candidate = null, closestDist = this.detectRange;
    if (!game.player.dead) {
      const d = dist(this, game.player);
      if (d < closestDist) { closestDist = d; candidate = game.player; }
    }
    for (const f of game.friends) {
      if (f.dead || inNest(f.x, f.y)) continue;
      const d = dist(this, f);
      if (d < closestDist) { closestDist = d; candidate = f; }
    }
    this.target = candidate;
  }

  update(dt, game) {
    if (this.dead) return;
    if (this.attackCooldown > 0) this.attackCooldown -= dt;
    if (this.invuln > 0) this.invuln -= dt;
    this.actionPhase += dt;
    this.wingPhase += dt * 0.04;

    // Terrain effects (wasps fly over slow/dps terrain)
    this._terrainSpeedMul = 1;
    const flying = this.type === 'wasp';
    if (game.terrain && !inNest(this.x, this.y)) {
      const t = game.terrain.getAt(this.x, this.y);
      const def = TERRAIN_DEFS[t];
      if (def && !(flying && def.flyingImmune)) {
        this._terrainSpeedMul = def.speed;
        if (def.dpsOnGround > 0) {
          this._terrainHpAcc = (this._terrainHpAcc || 0) + dt * 0.001 * def.dpsOnGround;
          if (this._terrainHpAcc >= 1) {
            const dmg = Math.floor(this._terrainHpAcc);
            this._terrainHpAcc -= dmg;
            this.hp = clamp(this.hp - dmg, 0, this.maxHp);
            if (this.hp <= 0) {
              this.hp = 0;
              this.dead = true;
              game.spawnEnemyDeath(this.x, this.y);
              game.dropFoodOnEnemyDeath(this);
              return;
            }
          }
        }
      }
    }

    // Lose target if it enters nest or gets too far (raiders never give up).
    if (this.target) {
      const targetGone = this.target.dead;
      const targetInNest = !this.target._isNestCenter && inNest(this.target.x, this.target.y);
      const targetTooFar = dist(this, this.target) > this.detectRange * 2.5;
      if (targetGone || (!this.isRaider && (targetInNest || targetTooFar))) {
        this.target = null;
        this.behaviorState = 'approach';
      }
    }

    if (!this.target) {
      this.findTarget(game);
    }

    // Dispatch by behavior key (variants like hornet/scorpion/slug reuse
    // a base AI). Falls back to the type when no override is provided.
    const behavior = this.behavior || this.type;
    if (behavior === 'spider')      this.updateSpider(dt, game);
    else if (behavior === 'beetle') this.updateBeetle(dt, game);
    else if (behavior === 'wasp')   this.updateWasp(dt, game);

    let da = this.targetAngle - this.angle;
    while (da > Math.PI) da -= Math.PI * 2;
    while (da < -Math.PI) da += Math.PI * 2;
    this.angle += da * Math.min(1, dt * 0.012);

    if (this._moving) this.legPhase += dt * 0.018;
  }

  updateSpider(dt, game) {
    let moving = false;
    if (this.target) {
      const d = dist(this, this.target);
      if (d > this.attackRange) {
        this.moveToward(this.target, this.speed, game);
        moving = true;
      } else if (this.attackCooldown <= 0) {
        if (this.target.takeDamage) this.target.takeDamage(this.attackPower, game, this);
        this.attackCooldown = this.attackCooldownMax;
        game.spawnHitEffect(this.target.x, this.target.y);
      }
    } else {
      this.wander(dt, game);
      moving = !!this.wanderTarget;
    }
    this._moving = moving;
  }

  updateBeetle(dt, game) {
    let moving = false;
    if (this.target) {
      const d = dist(this, this.target);
      if (this.behaviorState === 'approach') {
        if (d < 90 && this.attackCooldown <= 0) {
          // Begin charge windup
          this.behaviorState = 'charging';
          this.behaviorTimer = 700;
          this.dashAngle = Math.atan2(this.target.y - this.y, this.target.x - this.x);
          this.targetAngle = this.dashAngle;
        } else {
          this.moveToward(this.target, this.speed, game);
          moving = true;
        }
      } else if (this.behaviorState === 'charging') {
        // Pause and shake (visible windup)
        this.behaviorTimer -= dt;
        const shake = Math.sin(this.actionPhase * 0.06) * 1.5;
        this.x += shake * 0.15;
        if (this.behaviorTimer <= 0) {
          this.behaviorState = 'dashing';
          this.behaviorTimer = 450;
        }
      } else if (this.behaviorState === 'dashing') {
        // Dash forward fast
        const dashSpeed = 5.5;
        const nx = Math.cos(this.dashAngle) * dashSpeed;
        const ny = Math.sin(this.dashAngle) * dashSpeed;
        const newX = this.x + nx;
        const newY = this.y + ny;
        if (this.isRaider || !inNest(newX, newY)) {
          // Rock walls block dashes too — but along each axis so we may slide.
          if (game.isWalkableAt(newX, this.y)) this.x = clamp(newX, 20, WORLD_WIDTH - 20);
          if (game.isWalkableAt(this.x, newY)) this.y = clamp(newY, 20, WORLD_HEIGHT - 20);
        }
        moving = true;
        // Hit detection vs target and other ants in path (raiders also hit in-nest friends/eggs)
        const candidates = [game.player, ...game.friends];
        if (this.isRaider) {
          for (const eg of game.eggs) candidates.push(eg);
        }
        for (const a of candidates) {
          if (a.dead) continue;
          if (!this.isRaider && inNest(a.x, a.y)) continue;
          if (dist(this, a) < 24) {
            if (a.takeDamage) a.takeDamage(this.attackPower, game, this);
            game.spawnHitEffect(a.x, a.y);
            this.behaviorTimer = 0;
            break;
          }
        }
        this.behaviorTimer -= dt;
        if (this.behaviorTimer <= 0) {
          this.behaviorState = 'approach';
          this.attackCooldown = 1400;
        }
      }
    } else {
      this.wander(dt, game);
      moving = !!this.wanderTarget;
    }
    this._moving = moving;
  }

  updateWasp(dt, game) {
    let moving = false;
    if (this.target) {
      const d = dist(this, this.target);

      if (this.behaviorState === 'approach' || this.behaviorState === 'hover') {
        // Orbit at a desired distance
        this.behaviorState = 'hover';
        const desiredDist = 75;
        const dx = this.x - this.target.x;
        const dy = this.y - this.target.y;
        const m = Math.hypot(dx, dy);
        if (m > 0.1) {
          const radial = (m - desiredDist);
          const tangentX = -dy / m;
          const tangentY = dx / m;
          const radialX = (dx / m) * (-radial * 0.05);
          const radialY = (dy / m) * (-radial * 0.05);
          const hvX = this.x + tangentX * this.speed + radialX * this.speed;
          const hvY = this.y + tangentY * this.speed + radialY * this.speed;
          if (game.isWalkableAt(hvX, this.y)) this.x = hvX;
          if (game.isWalkableAt(this.x, hvY)) this.y = hvY;
          this.targetAngle = Math.atan2(this.target.y - this.y, this.target.x - this.x);
        }
        moving = true;
        this.behaviorTimer += dt;
        if (this.behaviorTimer > 1800 && this.attackCooldown <= 0) {
          // Begin dive
          this.behaviorState = 'dive';
          this.behaviorTimer = 0;
          this.dashAngle = Math.atan2(this.target.y - this.y, this.target.x - this.x);
        }
      } else if (this.behaviorState === 'dive') {
        // Fast dash to target's last known position direction
        const dashSpeed = 5.5;
        const nx = Math.cos(this.dashAngle) * dashSpeed;
        const ny = Math.sin(this.dashAngle) * dashSpeed;
        const dvX = this.x + nx, dvY = this.y + ny;
        if (game.isWalkableAt(dvX, this.y)) this.x = dvX;
        if (game.isWalkableAt(this.x, dvY)) this.y = dvY;
        this.targetAngle = this.dashAngle;
        moving = true;
        // Hit if close
        if (this.target && dist(this, this.target) < 20) {
          if (this.target.takeDamage) this.target.takeDamage(this.attackPower, game, this);
          game.spawnHitEffect(this.target.x, this.target.y);
          this.behaviorState = 'retreat';
          this.behaviorTimer = 0;
        }
        this.behaviorTimer += dt;
        if (this.behaviorTimer > 600) {
          this.behaviorState = 'retreat';
          this.behaviorTimer = 0;
        }
      } else if (this.behaviorState === 'retreat') {
        // Move away from target
        if (this.target) {
          const dx = this.x - this.target.x;
          const dy = this.y - this.target.y;
          const m = Math.hypot(dx, dy) || 1;
          const speed = 4;
          const rtX = this.x + (dx / m) * speed;
          const rtY = this.y + (dy / m) * speed;
          if (game.isWalkableAt(rtX, this.y)) this.x = rtX;
          if (game.isWalkableAt(this.x, rtY)) this.y = rtY;
        }
        moving = true;
        this.behaviorTimer += dt;
        if (this.behaviorTimer > 500) {
          this.behaviorState = 'hover';
          this.behaviorTimer = 0;
          this.attackCooldown = 700;
        }
      }
      // Clamp to world
      this.x = clamp(this.x, 20, WORLD_WIDTH - 20);
      this.y = clamp(this.y, 20, WORLD_HEIGHT - 20);
    } else {
      this.wander(dt, game);
      moving = !!this.wanderTarget;
      this.behaviorState = 'approach';
    }
    this._moving = moving;
  }

  wander(dt, game) {
    this.wanderTimer -= dt;
    if (!this.wanderTarget || this.wanderTimer <= 0 ||
        dist(this, this.wanderTarget) < 10) {
      // Try a few random targets to avoid landing on rock (would just stop them dead).
      let tries = 0, target;
      do {
        const a = Math.random() * Math.PI * 2;
        const r = rand(40, 140);
        target = {
          x: clamp(this.startX + Math.cos(a) * r, 30, WORLD_WIDTH - 30),
          y: clamp(this.startY + Math.sin(a) * r, 30, WORLD_HEIGHT - 30)
        };
        tries++;
      } while (game && game.terrain && game.terrain.getAt(target.x, target.y) === 'rock' && tries < 6);
      this.wanderTarget = target;
      this.wanderTimer = rand(2000, 4000);
    }
    if (this.wanderTarget && !inNest(this.wanderTarget.x, this.wanderTarget.y)) {
      this.moveToward(this.wanderTarget, this.speed * 0.55, game);
    }
  }

  moveToward(t, spd, game) {
    const dx = t.x - this.x;
    const dy = t.y - this.y;
    const d = Math.hypot(dx, dy);
    if (d > 0.5) {
      const evMul = (game && game._eventEnemySpeedMul) || 1;
      const eff = spd * (this._terrainSpeedMul || 1) * evMul;
      const nx = (dx / d) * eff;
      const ny = (dy / d) * eff;
      const newX = this.x + nx;
      const newY = this.y + ny;
      // Raiders ignore the nest barrier and walk right in.
      if (!this.isRaider && inNest(newX, newY)) {
        const dx2 = newX - NEST_X;
        const dy2 = newY - NEST_Y;
        const d2 = Math.hypot(dx2, dy2) || 1;
        const tx = NEST_X + (dx2 / d2) * (NEST_RADIUS_BASE + 5);
        const ty = NEST_Y + (dy2 / d2) * (NEST_RADIUS_BASE + 5);
        this.x = lerp(this.x, tx, 0.1);
        this.y = lerp(this.y, ty, 0.1);
      } else {
        // Block movement on rock; allow sliding along walls per axis.
        if (!game || game.isWalkableAt(newX, this.y)) this.x = newX;
        if (!game || game.isWalkableAt(this.x, newY)) this.y = newY;
      }
      this.targetAngle = Math.atan2(dy, dx);
    }
  }

  takeDamage(dmg, game, attacker) {
    if (this.dead || this.invuln > 0) return;
    this.hp -= dmg;
    this.invuln = 100;
    game.spawnDamageNumber(this.x, this.y - 18, dmg, '#ffeeaa');
    if (this.hp <= 0) {
      this.hp = 0;
      this.dead = true;
      game.spawnEnemyDeath(this.x, this.y, this.powerScale > 1.05 ? 1.5 : 1);
      game.dropFoodOnEnemyDeath(this);
      // Power-up drop chance.
      let dropP = 0.03;
      if (this.powerScale > 1.05) dropP = 0.12;
      if (this.isBoss) dropP = 1.0;
      if (Math.random() < dropP) {
        const t = POWERUP_TYPES[Math.floor(Math.random() * POWERUP_TYPES.length)];
        game.powerUps.push(new PowerUp(this.x, this.y, t));
      }
    } else if (attacker) {
      this.target = attacker;
    }
  }

  draw(ctx) {
    if (this.dead) return;

    // Empowered aura ring (drawn under body in world space)
    if (this.powerScale && this.powerScale > 1.05) {
      ctx.save();
      const pulse = 0.6 + 0.4 * Math.sin((this.actionPhase || 0) * 0.005);
      ctx.strokeStyle = `rgba(255, 50, 50, ${0.35 * pulse})`;
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.arc(this.x, this.y + 3, this.size + 6, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }
    // Raider marker (bright red ring + smaller inner ring)
    if (this.isRaider) {
      ctx.save();
      const pulse = 0.5 + 0.5 * Math.sin((this.actionPhase || 0) * 0.008);
      ctx.strokeStyle = `rgba(255, 0, 30, ${0.55 + 0.3 * pulse})`;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(this.x, this.y + 3, this.size + 10, 0, Math.PI * 2);
      ctx.stroke();
      ctx.strokeStyle = `rgba(255, 100, 100, ${0.3 + 0.2 * pulse})`;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(this.x, this.y + 3, this.size + 14, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }
    // Boss marker — golden crown above the body and brighter halo.
    if (this.isBoss) {
      ctx.save();
      const halo = ctx.createRadialGradient(this.x, this.y + 3, 0, this.x, this.y + 3, this.size + 24);
      halo.addColorStop(0, 'rgba(255, 215, 60, 0.35)');
      halo.addColorStop(1, 'rgba(255, 215, 60, 0)');
      ctx.fillStyle = halo;
      ctx.beginPath();
      ctx.arc(this.x, this.y + 3, this.size + 24, 0, Math.PI * 2);
      ctx.fill();
      // Crown above head
      const cy = this.y - this.size - 10;
      ctx.fillStyle = '#ffd24a';
      ctx.strokeStyle = '#7a5210';
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.moveTo(this.x - 10, cy + 6);
      ctx.lineTo(this.x - 8,  cy - 4);
      ctx.lineTo(this.x - 4,  cy + 1);
      ctx.lineTo(this.x,      cy - 6);
      ctx.lineTo(this.x + 4,  cy + 1);
      ctx.lineTo(this.x + 8,  cy - 4);
      ctx.lineTo(this.x + 10, cy + 6);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      ctx.restore();
    }

    ctx.save();
    ctx.translate(this.x, this.y);
    ctx.rotate(this.angle + Math.PI / 2);

    if (this.invuln > 0 && Math.floor(this.invuln / 40) % 2 === 0) {
      ctx.globalAlpha = 0.5;
    }

    // Charging visual (beetle)
    if (this.type === 'beetle' && this.behaviorState === 'charging') {
      ctx.save();
      ctx.rotate(-this.angle - Math.PI / 2); // unrotate to draw world-space arrow
      ctx.strokeStyle = 'rgba(255, 80, 80, 0.6)';
      ctx.lineWidth = 3;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(Math.cos(this.dashAngle) * 60, Math.sin(this.dashAngle) * 60);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.restore();
    }

    if (this.type === 'spider') {
      this.drawSpider(ctx);
    } else if (this.type === 'beetle' || this.type === 'scorpion') {
      this.drawBeetle(ctx);
      if (this.type === 'scorpion') this._drawScorpionTail(ctx);
    } else if (this.type === 'wasp' || this.type === 'hornet') {
      this.drawWasp(ctx);
    } else if (this.type === 'slug') {
      this.drawSlug(ctx);
    }

    ctx.restore();

    // HP bar
    if (this.hp < this.maxHp) {
      const w = 32;
      const h = 4;
      const bx = this.x - w / 2;
      const by = this.y - this.size - 14;
      ctx.fillStyle = 'rgba(0,0,0,0.5)';
      ctx.fillRect(bx - 1, by - 1, w + 2, h + 2);
      const ratio = this.hp / this.maxHp;
      ctx.fillStyle = '#cc4040';
      ctx.fillRect(bx, by, w * ratio, h);
    }
  }

  drawSpider(ctx) {
    const s = this.size / 16;
    const swing = Math.sin(this.legPhase) * 0.7;
    const swing2 = Math.sin(this.legPhase + Math.PI) * 0.7;

    ctx.strokeStyle = this.legColor;
    ctx.lineWidth = 2 * s;
    ctx.lineCap = 'round';
    const legAngles = [-Math.PI/2.2, -Math.PI/3.5, -Math.PI/8, Math.PI/2.5,
                       Math.PI - Math.PI/2.2, Math.PI + Math.PI/3.5, Math.PI + Math.PI/8, Math.PI - Math.PI/2.5];
    for (let i = 0; i < 8; i++) {
      const sw = (i < 4 ? swing : swing2);
      const a = legAngles[i];
      const lx = Math.cos(a) * 4 * s;
      const ly = Math.sin(a) * 4 * s;
      const ex = Math.cos(a) * (12 + sw) * s;
      const ey = Math.sin(a) * (12 + sw) * s;
      const mx = (lx + ex) / 2 + Math.cos(a) * 2;
      const my = (ly + ey) / 2 - 3 * s;
      ctx.beginPath();
      ctx.moveTo(lx, ly);
      ctx.quadraticCurveTo(mx, my, ex, ey);
      ctx.stroke();
    }

    ctx.fillStyle = this.color;
    ctx.beginPath();
    ctx.ellipse(0, 5 * s, 9 * s, 11 * s, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = this.markColor;
    ctx.beginPath();
    ctx.ellipse(-3 * s, 4 * s, 1.6 * s, 2 * s, 0, 0, Math.PI * 2);
    ctx.ellipse(3 * s, 4 * s, 1.6 * s, 2 * s, 0, 0, Math.PI * 2);
    ctx.ellipse(0, 9 * s, 1.6 * s, 2 * s, 0, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = this.headColor;
    ctx.beginPath();
    ctx.ellipse(0, -3 * s, 6 * s, 6.5 * s, 0, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = '#ff3030';
    ctx.beginPath();
    ctx.arc(-2 * s, -5 * s, 0.9 * s, 0, Math.PI * 2);
    ctx.arc(2 * s, -5 * s, 0.9 * s, 0, Math.PI * 2);
    ctx.arc(-3 * s, -3 * s, 0.7 * s, 0, Math.PI * 2);
    ctx.arc(3 * s, -3 * s, 0.7 * s, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = '#1a001a';
    ctx.beginPath();
    ctx.moveTo(-1.5 * s, -7 * s);
    ctx.lineTo(-2 * s, -9 * s);
    ctx.lineTo(-0.5 * s, -8 * s);
    ctx.closePath();
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(1.5 * s, -7 * s);
    ctx.lineTo(2 * s, -9 * s);
    ctx.lineTo(0.5 * s, -8 * s);
    ctx.closePath();
    ctx.fill();
  }

  drawBeetle(ctx) {
    const s = this.size / 20;
    const swing = Math.sin(this.legPhase) * 0.6;
    const swing2 = Math.sin(this.legPhase + Math.PI) * 0.6;

    // 6 legs (shorter, sturdier)
    ctx.strokeStyle = this.legColor;
    ctx.lineWidth = 2.2 * s;
    ctx.lineCap = 'round';
    for (let i = -1; i <= 1; i++) {
      const ly = i * 5 * s;
      const sw = (i % 2 === 0) ? swing : swing2;
      ctx.beginPath();
      ctx.moveTo(-5 * s, ly);
      ctx.quadraticCurveTo(-9 * s, ly + sw * 2, -12 * s, ly + sw * 4);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(5 * s, ly);
      ctx.quadraticCurveTo(9 * s, ly - sw * 2, 12 * s, ly - sw * 4);
      ctx.stroke();
    }

    // Body (rounder, beetle-like)
    ctx.fillStyle = this.color;
    ctx.beginPath();
    ctx.ellipse(0, 2 * s, 10 * s, 13 * s, 0, 0, Math.PI * 2);
    ctx.fill();

    // Shell line down the middle
    ctx.strokeStyle = this.headColor;
    ctx.lineWidth = 2 * s;
    ctx.beginPath();
    ctx.moveTo(0, -8 * s);
    ctx.lineTo(0, 13 * s);
    ctx.stroke();

    // Shell highlight
    ctx.fillStyle = this.markColor;
    ctx.globalAlpha = 0.6;
    ctx.beginPath();
    ctx.ellipse(-3 * s, -2 * s, 3 * s, 5 * s, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;

    // Head
    ctx.fillStyle = this.headColor;
    ctx.beginPath();
    ctx.ellipse(0, -9 * s, 5.5 * s, 4.5 * s, 0, 0, Math.PI * 2);
    ctx.fill();

    // Horns (pointing forward)
    ctx.strokeStyle = this.headColor;
    ctx.lineWidth = 2.5 * s;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(-2 * s, -11 * s);
    ctx.lineTo(-3 * s, -16 * s);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(2 * s, -11 * s);
    ctx.lineTo(3 * s, -16 * s);
    ctx.stroke();

    // Eyes (red, smaller)
    ctx.fillStyle = '#ff3030';
    ctx.beginPath();
    ctx.arc(-2 * s, -10 * s, 0.7 * s, 0, Math.PI * 2);
    ctx.arc(2 * s, -10 * s, 0.7 * s, 0, Math.PI * 2);
    ctx.fill();
  }

  drawWasp(ctx) {
    const s = this.size / 13;
    const wingFlap = Math.sin(this.wingPhase) * 0.3 + 0.7;

    // Wings (transparent ovals, top of body)
    ctx.fillStyle = 'rgba(220, 240, 255, 0.45)';
    ctx.strokeStyle = 'rgba(180, 200, 220, 0.6)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.ellipse(-5 * s, -1 * s, 7 * s * wingFlap, 4 * s, -0.3, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.beginPath();
    ctx.ellipse(5 * s, -1 * s, 7 * s * wingFlap, 4 * s, 0.3, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    // 6 legs (small)
    ctx.strokeStyle = this.legColor;
    ctx.lineWidth = 1.2 * s;
    ctx.lineCap = 'round';
    for (let i = -1; i <= 1; i++) {
      const ly = i * 2.5 * s;
      ctx.beginPath();
      ctx.moveTo(-3 * s, ly);
      ctx.lineTo(-6 * s, ly + 4 * s);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(3 * s, ly);
      ctx.lineTo(6 * s, ly + 4 * s);
      ctx.stroke();
    }

    // Abdomen with stripes
    ctx.fillStyle = this.color;
    ctx.beginPath();
    ctx.ellipse(0, 5 * s, 5 * s, 7 * s, 0, 0, Math.PI * 2);
    ctx.fill();
    // Black stripes
    ctx.fillStyle = this.markColor;
    for (let i = 0; i < 3; i++) {
      ctx.beginPath();
      ctx.ellipse(0, 3 * s + i * 2.5 * s, 5 * s, 0.9 * s, 0, 0, Math.PI * 2);
      ctx.fill();
    }

    // Stinger
    ctx.fillStyle = this.markColor;
    ctx.beginPath();
    ctx.moveTo(-1 * s, 11 * s);
    ctx.lineTo(0, 14 * s);
    ctx.lineTo(1 * s, 11 * s);
    ctx.closePath();
    ctx.fill();

    // Thorax
    ctx.fillStyle = this.headColor;
    ctx.beginPath();
    ctx.ellipse(0, 0, 4 * s, 4 * s, 0, 0, Math.PI * 2);
    ctx.fill();

    // Head
    ctx.fillStyle = this.headColor;
    ctx.beginPath();
    ctx.ellipse(0, -5 * s, 3.5 * s, 3.5 * s, 0, 0, Math.PI * 2);
    ctx.fill();

    // Big eyes
    ctx.fillStyle = '#1a1a1a';
    ctx.beginPath();
    ctx.arc(-1.5 * s, -5 * s, 1.4 * s, 0, Math.PI * 2);
    ctx.arc(1.5 * s, -5 * s, 1.4 * s, 0, Math.PI * 2);
    ctx.fill();
    // Eye highlight
    ctx.fillStyle = '#ffe680';
    ctx.beginPath();
    ctx.arc(-1.2 * s, -5.3 * s, 0.5 * s, 0, Math.PI * 2);
    ctx.arc(1.8 * s, -5.3 * s, 0.5 * s, 0, Math.PI * 2);
    ctx.fill();
  }

  // Slimy slug — used for the 'slug' enemy type. Round body + antennae +
  // a wet trail. Draws inside the rotated/translated frame.
  drawSlug(ctx) {
    const s = this.size / 30;
    const wob = Math.sin(this.legPhase * 1.4) * 0.6;
    // Slime trail behind the body
    ctx.fillStyle = 'rgba(170, 200, 80, 0.30)';
    ctx.beginPath();
    ctx.ellipse(0, 14 * s, 9 * s, 4 * s, 0, 0, Math.PI * 2);
    ctx.fill();
    // Body (long oval)
    ctx.fillStyle = this.color;
    ctx.beginPath();
    ctx.ellipse(0, 4 * s + wob, 10 * s, 13 * s, 0, 0, Math.PI * 2);
    ctx.fill();
    // Wet sheen on top
    ctx.fillStyle = this.markColor;
    ctx.beginPath();
    ctx.ellipse(-2 * s, -2 * s, 4 * s, 7 * s, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = 'rgba(255, 255, 255, 0.30)';
    ctx.beginPath();
    ctx.ellipse(-3 * s, -4 * s, 1.6 * s, 3 * s, 0, 0, Math.PI * 2);
    ctx.fill();
    // Head
    ctx.fillStyle = this.color;
    ctx.beginPath();
    ctx.arc(0, -8 * s, 5 * s, 0, Math.PI * 2);
    ctx.fill();
    // Eyes (small dots)
    ctx.fillStyle = '#1a1a1a';
    ctx.beginPath();
    ctx.arc(-1.6 * s, -9 * s, 0.7 * s, 0, Math.PI * 2);
    ctx.arc(1.6 * s, -9 * s, 0.7 * s, 0, Math.PI * 2);
    ctx.fill();
    // Two long antennae (slug-style stalks with eyes)
    ctx.strokeStyle = this.color;
    ctx.lineWidth = 1.6 * s;
    ctx.lineCap = 'round';
    const aBob = wob * 0.5;
    ctx.beginPath();
    ctx.moveTo(-1.5 * s, -10 * s);
    ctx.quadraticCurveTo(-3.5 * s + aBob, -13 * s, -3 * s + aBob, -16 * s);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(1.5 * s, -10 * s);
    ctx.quadraticCurveTo(3.5 * s - aBob, -13 * s, 3 * s - aBob, -16 * s);
    ctx.stroke();
    // Antenna eye-balls
    ctx.fillStyle = '#fff';
    ctx.beginPath(); ctx.arc(-3 * s + aBob, -16 * s, 1.2 * s, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.arc(3 * s - aBob, -16 * s, 1.2 * s, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#1a1a1a';
    ctx.beginPath(); ctx.arc(-3 * s + aBob, -16 * s, 0.5 * s, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.arc(3 * s - aBob, -16 * s, 0.5 * s, 0, Math.PI * 2); ctx.fill();
  }

  // Curled stinger tail for scorpion (extra detail layered on top of beetle).
  _drawScorpionTail(ctx) {
    const s = this.size / 30;
    ctx.strokeStyle = this.color;
    ctx.lineWidth = 3.2 * s;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(0, 12 * s);
    ctx.quadraticCurveTo(8 * s, 14 * s, 10 * s, 8 * s);
    ctx.quadraticCurveTo(11 * s, 3 * s, 8 * s, 0);
    ctx.stroke();
    // Sting tip
    ctx.fillStyle = this.markColor;
    ctx.beginPath();
    ctx.arc(8 * s, 0, 1.8 * s, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#fff8a0';
    ctx.beginPath();
    ctx.arc(8 * s, -0.6 * s, 0.7 * s, 0, Math.PI * 2);
    ctx.fill();
  }
}

// ---------- Heal Item ----------
class HealItem {
  constructor(x, y) {
    this.x = x;
    this.y = y;
    this.size = 14;
    this.bobble = Math.random() * Math.PI * 2;
    this.collected = false;
    this.healAmount = 40;
    this.lifetime = 28000;
    this.maxLifetime = 28000;
  }
  update(dt) {
    this.bobble += dt * 0.005;
    this.lifetime -= dt;
    if (this.lifetime <= 0) this.collected = true;
  }
  draw(ctx) {
    if (this.collected) return;
    const bob = Math.sin(this.bobble * 2) * 2;
    const fade = Math.min(1, this.lifetime / 4000);
    ctx.save();
    ctx.translate(this.x, this.y + bob);
    ctx.globalAlpha = fade;

    // Outer glow
    const glow = ctx.createRadialGradient(0, 0, 0, 0, 0, this.size * 1.8);
    glow.addColorStop(0, 'rgba(255, 180, 200, 0.5)');
    glow.addColorStop(1, 'rgba(255, 180, 200, 0)');
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(0, 0, this.size * 1.8, 0, Math.PI * 2);
    ctx.fill();

    // Heart
    const s = this.size;
    ctx.fillStyle = '#ff5577';
    ctx.beginPath();
    ctx.moveTo(0, s * 0.4);
    ctx.bezierCurveTo(-s * 1.1, -s * 0.2, -s * 0.9, -s * 1.0, 0, -s * 0.35);
    ctx.bezierCurveTo(s * 0.9, -s * 1.0, s * 1.1, -s * 0.2, 0, s * 0.4);
    ctx.fill();

    // Highlight
    ctx.fillStyle = 'rgba(255, 255, 255, 0.6)';
    ctx.beginPath();
    ctx.ellipse(-s * 0.35, -s * 0.4, s * 0.25, s * 0.18, -0.4, 0, Math.PI * 2);
    ctx.fill();

    ctx.restore();
  }
}

// ---------- Particles ----------
class Particle {
  constructor(x, y, vx, vy, life, color, size = 3) {
    this.x = x;
    this.y = y;
    this.vx = vx;
    this.vy = vy;
    this.life = life;
    this.maxLife = life;
    this.color = color;
    this.size = size;
    this.dead = false;
  }
  update(dt) {
    this.x += this.vx * dt * 0.06;
    this.y += this.vy * dt * 0.06;
    this.vx *= 0.95;
    this.vy *= 0.95;
    this.life -= dt;
    if (this.life <= 0) this.dead = true;
  }
  draw(ctx) {
    const a = this.life / this.maxLife;
    ctx.globalAlpha = a;
    ctx.fillStyle = this.color;
    ctx.beginPath();
    ctx.arc(this.x, this.y, this.size, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;
  }
}

class DamageNumber {
  constructor(x, y, val, color) {
    this.x = x;
    this.y = y;
    this.val = val;
    this.color = color;
    this.life = 800;
    this.maxLife = 800;
    this.dead = false;
  }
  update(dt) {
    this.y -= dt * 0.03;
    this.life -= dt;
    if (this.life <= 0) this.dead = true;
  }
  draw(ctx) {
    const a = this.life / this.maxLife;
    ctx.globalAlpha = a;
    ctx.fillStyle = this.color;
    ctx.strokeStyle = 'rgba(0,0,0,0.7)';
    ctx.lineWidth = 2.5;
    ctx.font = 'bold 14px sans-serif';
    ctx.textAlign = 'center';
    ctx.strokeText(`-${this.val}`, this.x, this.y);
    ctx.fillText(`-${this.val}`, this.x, this.y);
    ctx.globalAlpha = 1;
  }
}

// ---------- Grass tuft ----------
class GrassTuft {
  constructor(x, y, scale = 1) {
    this.x = x;
    this.y = y;
    this.scale = scale;
    this.blades = [];
    const count = Math.floor(rand(4, 8) * scale);
    for (let i = 0; i < count; i++) {
      this.blades.push({
        offsetX: rand(-6, 6) * scale,
        offsetY: rand(-3, 3) * scale,
        height: rand(8, 14) * scale,
        sway: Math.random() * Math.PI * 2,
        color: pickRand(['#3a7a25', '#4a8a30', '#2d6a18'])
      });
    }
  }
  draw(ctx, time) {
    this.blades.forEach(b => {
      const sway = Math.sin(time * 0.001 + b.sway) * 1.5;
      ctx.strokeStyle = b.color;
      ctx.lineWidth = 1.5;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(this.x + b.offsetX, this.y + b.offsetY);
      ctx.quadraticCurveTo(
        this.x + b.offsetX + sway,
        this.y + b.offsetY - b.height * 0.5,
        this.x + b.offsetX + sway * 1.5,
        this.y + b.offsetY - b.height
      );
      ctx.stroke();
    });
  }
}

// ---------- Terrain ----------
const TILE_SIZE = 80;
const TERRAIN_TYPES = ['rock', 'grass', 'pond', 'sand', 'mud', 'flower', 'leaves', 'concrete'];

// Per-terrain enemy spawn config: weight (relative spawn frequency, 0 = none),
// bias (preferred enemy type), scale (HP/ATK multiplier for that biome).
const ENEMY_TERRAIN = {
  grass:    { weight: 1.0, bias: null,     scale: 1.0 },
  pond:     { weight: 0,   bias: null,     scale: 1.0 },
  sand:     { weight: 0.8, bias: 'spider', scale: 1.0 },
  mud:      { weight: 1.4, bias: 'beetle', scale: 1.1 },
  flower:   { weight: 0.6, bias: 'wasp',   scale: 1.0 },
  leaves:   { weight: 1.2, bias: 'spider', scale: 1.0 },
  concrete: { weight: 1.5, bias: 'beetle', scale: 1.2 }
};

// Per-tile gameplay effects. `dpsOnGround` = HP per second drained on ground units.
// `flyingImmune` = wasps and similar ignore the slow/dps penalty.
// `walkable: false` means the tile is impassable (rock walls).
const TERRAIN_DEFS = {
  rock:     { speed: 0,    dpsOnGround:  0,   flyingImmune: false, footstepColor: null, walkable: false },
  grass:    { speed: 1.00, dpsOnGround:  0,   flyingImmune: false, footstepColor: null, walkable: true  },
  pond:     { speed: 0.45, dpsOnGround:  1.5, flyingImmune: true,  footstepColor: '#a0d8ff', walkable: true },
  sand:     { speed: 0.75, dpsOnGround:  0,   flyingImmune: false, footstepColor: '#e8c98a', walkable: true },
  mud:      { speed: 0.55, dpsOnGround:  0.6, flyingImmune: false, footstepColor: '#5a3a1f', walkable: true },
  flower:   { speed: 1.00, dpsOnGround: -0.2, flyingImmune: false, footstepColor: null, walkable: true },
  leaves:   { speed: 0.85, dpsOnGround:  0,   flyingImmune: false, footstepColor: '#b8742a', walkable: true },
  concrete: { speed: 1.15, dpsOnGround:  0,   flyingImmune: false, footstepColor: null, walkable: true }
};

// Base colors used as fallback rendering before per-type detail kicks in.
const TERRAIN_BASE_COLOR = {
  grass:    null, // null = transparent (use existing background gradient)
  pond:     '#3a78c0',
  sand:     '#d6b878',
  mud:      '#5a3a1f',
  flower:   '#5fa53a',
  leaves:   '#8a5530',
  concrete: '#8e8e8e'
};

class TerrainGrid {
  constructor(worldW, worldH) {
    this.tileSize = TILE_SIZE;
    this.cols = Math.ceil(worldW / TILE_SIZE);
    this.rows = Math.ceil(worldH / TILE_SIZE);
    this.tiles = [];
    for (let r = 0; r < this.rows; r++) {
      // Default = rock. Zones (grass + biomes) are stamped over the top.
      const row = new Array(this.cols).fill('rock');
      this.tiles.push(row);
    }
    this.animPhase = 0;
  }

  // World-space coords → terrain type. Out-of-bounds counts as rock so
  // entities can't sneak past the world edge.
  getAt(x, y) {
    const tx = Math.floor(x / this.tileSize);
    const ty = Math.floor(y / this.tileSize);
    if (ty < 0 || ty >= this.rows || tx < 0 || tx >= this.cols) return 'rock';
    return this.tiles[ty][tx];
  }

  // Fill a rectangular zone with a single terrain type. Used for stamping
  // the initial grass area and the grass base of new biome zones.
  fillRect(bounds, type) {
    const tx0 = Math.max(0, Math.floor(bounds.x0 / this.tileSize));
    const ty0 = Math.max(0, Math.floor(bounds.y0 / this.tileSize));
    const tx1 = Math.min(this.cols, Math.ceil(bounds.x1 / this.tileSize));
    const ty1 = Math.min(this.rows, Math.ceil(bounds.y1 / this.tileSize));
    for (let r = ty0; r < ty1; r++) {
      for (let c = tx0; c < tx1; c++) {
        this.tiles[r][c] = type;
      }
    }
  }

  // Place a roughly elliptical blob of `type` around tile (tx, ty)
  stampBlob(tx, ty, type, radiusTiles) {
    const r = radiusTiles;
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        const yy = ty + dy;
        const xx = tx + dx;
        if (yy < 0 || yy >= this.rows || xx < 0 || xx >= this.cols) continue;
        // irregular boundary using noisy radius
        const noisy = r + (((xx * 1973 + yy * 9277) % 100) / 100 - 0.5) * 1.4;
        const d = Math.hypot(dx, dy);
        if (d <= noisy) {
          // Don't overwrite ponds with weak terrain
          if (this.tiles[yy][xx] === 'pond' && type !== 'pond') continue;
          this.tiles[yy][xx] = type;
        }
      }
    }
  }

  // Fill a region with a single biome type at `coverage` density (default 0.8).
  // The remaining ~20% is left/punched as grass clearings for visual interest.
  fillBiome(bounds, type, coverage = 0.8) {
    const tx0 = Math.max(0, Math.floor(bounds.x0 / this.tileSize));
    const ty0 = Math.max(0, Math.floor(bounds.y0 / this.tileSize));
    const tx1 = Math.min(this.cols, Math.ceil(bounds.x1 / this.tileSize));
    const ty1 = Math.min(this.rows, Math.ceil(bounds.y1 / this.tileSize));
    const nestSafeR = (NEST_RADIUS_BASE + 60) / this.tileSize;
    const nestTx = NEST_X / this.tileSize;
    const nestTy = NEST_Y / this.tileSize;
    const inSafe = (c, r) => Math.hypot(c - nestTx, r - nestTy) < nestSafeR;

    // Step 1: paint the entire region with the biome type.
    for (let r = ty0; r < ty1; r++) {
      for (let c = tx0; c < tx1; c++) {
        if (inSafe(c, r)) continue;
        this.tiles[r][c] = type;
      }
    }

    // Step 2: punch grass clearings to reach the target coverage.
    const w = tx1 - tx0;
    const h = ty1 - ty0;
    const totalTiles = w * h;
    const grassTiles = totalTiles * (1 - coverage);
    const numClearings = Math.max(2, Math.round(grassTiles / 8));
    for (let i = 0; i < numClearings; i++) {
      const cx = Math.floor(rand(tx0, tx1));
      const cy = Math.floor(rand(ty0, ty1));
      if (inSafe(cx, cy)) continue;
      const radius = Math.floor(rand(1, 3));
      for (let dy = -radius; dy <= radius; dy++) {
        for (let dx = -radius; dx <= radius; dx++) {
          const yy = cy + dy;
          const xx = cx + dx;
          if (yy < ty0 || yy >= ty1 || xx < tx0 || xx >= tx1) continue;
          const noisy = radius + (((xx * 1973 + yy * 9277) % 100) / 100 - 0.5) * 1.4;
          const d = Math.hypot(dx, dy);
          if (d <= noisy) this.tiles[yy][xx] = 'grass';
        }
      }
    }
  }

  // Regenerate terrain inside the world rectangle bounds = {x0,y0,x1,y1}.
  // Patches are centered roughly inside bounds. Skips area near nest center.
  regenerate(bounds, opts = {}) {
    const x0 = Math.max(0, Math.floor(bounds.x0 / this.tileSize));
    const y0 = Math.max(0, Math.floor(bounds.y0 / this.tileSize));
    const x1 = Math.min(this.cols, Math.ceil(bounds.x1 / this.tileSize));
    const y1 = Math.min(this.rows, Math.ceil(bounds.y1 / this.tileSize));
    const nestSafeRadiusTiles = (NEST_RADIUS_BASE + 60) / this.tileSize;
    const nestTx = NEST_X / this.tileSize;
    const nestTy = NEST_Y / this.tileSize;

    // Distribution of types to place. `weights` controls relative coverage.
    const weights = opts.weights || {
      sand:     2,
      mud:      2,
      flower:   2,
      leaves:   3,
      concrete: 1,
      pond:     1
    };
    const flat = [];
    Object.keys(weights).forEach(k => {
      for (let i = 0; i < weights[k]; i++) flat.push(k);
    });

    const areaTiles = (x1 - x0) * (y1 - y0);
    const numPatches = Math.max(2, Math.floor(areaTiles / 35));

    for (let i = 0; i < numPatches; i++) {
      const tx = Math.floor(rand(x0, x1));
      const ty = Math.floor(rand(y0, y1));
      // Skip if too close to nest
      if (Math.hypot(tx - nestTx, ty - nestTy) < nestSafeRadiusTiles) continue;
      const type = pickRand(flat);
      const radius = type === 'pond' ? Math.floor(rand(2, 4))
                  : type === 'concrete' ? Math.floor(rand(2, 4))
                  : Math.floor(rand(2, 5));
      this.stampBlob(tx, ty, type, radius);
    }
  }

  tickAnim(dt) {
    this.animPhase += dt * 0.001;
  }

  // Grow the underlying grid to cover (newWorldW, newWorldH). Existing tiles preserved.
  extend(newWorldW, newWorldH) {
    const newCols = Math.ceil(newWorldW / this.tileSize);
    const newRows = Math.ceil(newWorldH / this.tileSize);
    // Pad existing rows to newCols
    if (newCols > this.cols) {
      for (let r = 0; r < this.rows; r++) {
        for (let c = this.cols; c < newCols; c++) {
          this.tiles[r][c] = 'grass';
        }
      }
    }
    // Add new rows
    if (newRows > this.rows) {
      for (let r = this.rows; r < newRows; r++) {
        const row = new Array(newCols).fill('grass');
        this.tiles.push(row);
      }
    }
    this.cols = newCols;
    this.rows = newRows;
  }

  // Stable per-tile pseudo-random in [0,1) — for decoration placement.
  _rand01(c, r, salt = 0) {
    const v = (c * 1973 + r * 9277 + salt * 31337);
    return ((Math.sin(v) * 43758.5453) % 1 + 1) % 1;
  }

  // Draw visible tiles only.
  draw(ctx, camX, camY, viewW, viewH) {
    const ts = this.tileSize;
    const c0 = Math.max(0, Math.floor(camX / ts));
    const r0 = Math.max(0, Math.floor(camY / ts));
    const c1 = Math.min(this.cols, Math.ceil((camX + viewW) / ts) + 1);
    const r1 = Math.min(this.rows, Math.ceil((camY + viewH) / ts) + 1);

    // Pass 1: fill base color
    for (let r = r0; r < r1; r++) {
      for (let c = c0; c < c1; c++) {
        const t = this.tiles[r][c];
        if (t === 'grass') continue;
        const x = c * ts;
        const y = r * ts;
        this._drawTileBase(ctx, x, y, t, c, r);
      }
    }
    // Pass 2: decorations on top
    for (let r = r0; r < r1; r++) {
      for (let c = c0; c < c1; c++) {
        const t = this.tiles[r][c];
        if (t === 'grass') continue;
        const x = c * ts;
        const y = r * ts;
        this._drawTileDeco(ctx, x, y, t, c, r);
      }
    }
  }

  _drawTileBase(ctx, x, y, type, c, r) {
    const ts = this.tileSize;
    if (type === 'rock') {
      // Solid impassable stone — slightly varied between tiles for texture.
      const shade = 56 + ((c * 7 + r * 13) % 16);
      ctx.fillStyle = `rgb(${shade}, ${shade - 4}, ${shade - 8})`;
      ctx.fillRect(x, y, ts, ts);
      return;
    }
    if (type === 'pond') {
      const grad = ctx.createLinearGradient(x, y, x, y + ts);
      grad.addColorStop(0, '#3f86d0');
      grad.addColorStop(1, '#27598a');
      ctx.fillStyle = grad;
      ctx.fillRect(x, y, ts, ts);
    } else if (type === 'sand') {
      ctx.fillStyle = '#dcc188';
      ctx.fillRect(x, y, ts, ts);
    } else if (type === 'mud') {
      ctx.fillStyle = '#5a3a1f';
      ctx.fillRect(x, y, ts, ts);
    } else if (type === 'flower') {
      ctx.fillStyle = '#5fa53a';
      ctx.fillRect(x, y, ts, ts);
    } else if (type === 'leaves') {
      ctx.fillStyle = '#7a5230';
      ctx.fillRect(x, y, ts, ts);
    } else if (type === 'concrete') {
      ctx.fillStyle = '#9a9a9a';
      ctx.fillRect(x, y, ts, ts);
    }
  }

  _drawTileDeco(ctx, x, y, type, c, r) {
    const ts = this.tileSize;
    const phase = this.animPhase;

    if (type === 'rock') {
      // Cracks + a few darker speckles to read as rock.
      ctx.strokeStyle = 'rgba(20,20,20,0.55)';
      ctx.lineWidth = 1;
      const sx = x + this._rand01(c, r, 1) * ts;
      const sy = y + this._rand01(c, r, 2) * ts;
      ctx.beginPath();
      ctx.moveTo(sx, sy);
      let cx = sx, cy = sy;
      for (let i = 0; i < 3; i++) {
        cx += (this._rand01(c, r, i + 7) - 0.5) * ts * 0.6;
        cy += (this._rand01(c, r, i + 17) - 0.5) * ts * 0.6;
        ctx.lineTo(cx, cy);
      }
      ctx.stroke();
      // Highlight chips
      ctx.fillStyle = 'rgba(255,255,255,0.07)';
      ctx.fillRect(x + this._rand01(c, r, 3) * ts, y + this._rand01(c, r, 4) * ts, 2, 2);
      ctx.fillStyle = 'rgba(0,0,0,0.35)';
      ctx.fillRect(x + this._rand01(c, r, 5) * ts, y + this._rand01(c, r, 6) * ts, 2, 2);
      // Subtle inner edge against neighbours that aren't rock — gives a wall feel.
      const neighbors = [
        [c-1, r, 0, 0, 1.5, ts],     // left edge
        [c+1, r, ts - 1.5, 0, 1.5, ts], // right edge
        [c, r-1, 0, 0, ts, 1.5],     // top edge
        [c, r+1, 0, ts - 1.5, ts, 1.5]  // bottom edge
      ];
      ctx.fillStyle = 'rgba(0,0,0,0.55)';
      for (const [nc, nr, dx, dy, w, h] of neighbors) {
        if (nr < 0 || nr >= this.rows || nc < 0 || nc >= this.cols) continue;
        if (this.tiles[nr][nc] !== 'rock') {
          ctx.fillRect(x + dx, y + dy, w, h);
        }
      }
      return;
    }

    if (type === 'pond') {
      // Ripples (animated arcs)
      ctx.strokeStyle = 'rgba(255,255,255,0.35)';
      ctx.lineWidth = 1.2;
      const rx1 = this._rand01(c, r, 1);
      const rx2 = this._rand01(c, r, 2);
      for (let i = 0; i < 2; i++) {
        const cx = x + (i === 0 ? rx1 : rx2) * ts;
        const cy = y + (i === 0 ? rx2 : rx1) * ts;
        const baseR = 6 + i * 3;
        const t = (phase * 0.6 + i * 0.5 + rx1) % 1;
        const rr = baseR + t * 12;
        ctx.globalAlpha = (1 - t) * 0.6;
        ctx.beginPath();
        ctx.arc(cx, cy, rr, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
      // Highlight glints
      ctx.fillStyle = 'rgba(255,255,255,0.18)';
      const gx = x + this._rand01(c, r, 3) * ts;
      const gy = y + this._rand01(c, r, 4) * ts;
      ctx.beginPath();
      ctx.ellipse(gx, gy, 6, 1.5, 0.4, 0, Math.PI * 2);
      ctx.fill();
    } else if (type === 'sand') {
      // Fine grain specks
      ctx.fillStyle = 'rgba(110,80,40,0.35)';
      for (let i = 0; i < 18; i++) {
        const dx = this._rand01(c, r, i) * ts;
        const dy = this._rand01(c, r, i + 100) * ts;
        ctx.fillRect(x + dx, y + dy, 1.4, 1.4);
      }
      // Lighter highlight specks
      ctx.fillStyle = 'rgba(255,240,210,0.4)';
      for (let i = 0; i < 6; i++) {
        const dx = this._rand01(c, r, i + 200) * ts;
        const dy = this._rand01(c, r, i + 300) * ts;
        ctx.fillRect(x + dx, y + dy, 1.2, 1.2);
      }
    } else if (type === 'mud') {
      // Puddle blotches
      ctx.fillStyle = 'rgba(30,18,8,0.55)';
      for (let i = 0; i < 4; i++) {
        const dx = this._rand01(c, r, i) * ts;
        const dy = this._rand01(c, r, i + 50) * ts;
        const rad = 5 + this._rand01(c, r, i + 70) * 8;
        ctx.beginPath();
        ctx.ellipse(x + dx, y + dy, rad, rad * 0.6, 0, 0, Math.PI * 2);
        ctx.fill();
      }
      // Wet sheen
      ctx.fillStyle = 'rgba(150,110,70,0.18)';
      ctx.beginPath();
      ctx.ellipse(x + this._rand01(c,r,8) * ts, y + this._rand01(c,r,9) * ts, 12, 4, 0.3, 0, Math.PI * 2);
      ctx.fill();
    } else if (type === 'flower') {
      // Scatter flowers (5-petal)
      const colors = ['#ff7eb1', '#ffd24a', '#ffffff', '#bb88ff'];
      for (let i = 0; i < 6; i++) {
        const dx = this._rand01(c, r, i) * ts;
        const dy = this._rand01(c, r, i + 60) * ts;
        const cidx = Math.floor(this._rand01(c, r, i + 30) * colors.length);
        const sway = Math.sin(phase * 1.3 + this._rand01(c, r, i + 5) * Math.PI * 2) * 0.6;
        ctx.fillStyle = colors[cidx];
        const cx = x + dx + sway;
        const cy = y + dy;
        // 5 petals
        for (let p = 0; p < 5; p++) {
          const a = (p / 5) * Math.PI * 2;
          ctx.beginPath();
          ctx.arc(cx + Math.cos(a) * 2.2, cy + Math.sin(a) * 2.2, 1.7, 0, Math.PI * 2);
          ctx.fill();
        }
        // Center
        ctx.fillStyle = '#ffe34a';
        ctx.beginPath();
        ctx.arc(cx, cy, 1.4, 0, Math.PI * 2);
        ctx.fill();
      }
    } else if (type === 'leaves') {
      // Scattered leaves
      const colors = ['#a55a25', '#d68635', '#e0a040', '#7d4419'];
      for (let i = 0; i < 7; i++) {
        const dx = this._rand01(c, r, i) * ts;
        const dy = this._rand01(c, r, i + 40) * ts;
        const cidx = Math.floor(this._rand01(c, r, i + 80) * colors.length);
        const ang = this._rand01(c, r, i + 90) * Math.PI * 2;
        ctx.save();
        ctx.translate(x + dx, y + dy);
        ctx.rotate(ang);
        ctx.fillStyle = colors[cidx];
        ctx.beginPath();
        ctx.ellipse(0, 0, 5, 2.5, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = 'rgba(0,0,0,0.25)';
        ctx.lineWidth = 0.6;
        ctx.beginPath();
        ctx.moveTo(-5, 0);
        ctx.lineTo(5, 0);
        ctx.stroke();
        ctx.restore();
      }
    } else if (type === 'concrete') {
      // Cracks
      ctx.strokeStyle = 'rgba(40,40,40,0.5)';
      ctx.lineWidth = 1;
      const startX = x + this._rand01(c, r, 1) * ts;
      const startY = y + this._rand01(c, r, 2) * ts;
      ctx.beginPath();
      ctx.moveTo(startX, startY);
      let cx = startX, cy = startY;
      for (let i = 0; i < 3; i++) {
        const dx = (this._rand01(c, r, i + 10) - 0.5) * ts * 0.6;
        const dy = (this._rand01(c, r, i + 20) - 0.5) * ts * 0.6;
        cx += dx; cy += dy;
        ctx.lineTo(cx, cy);
      }
      ctx.stroke();
      // Edge seams (suggesting tile slabs)
      ctx.strokeStyle = 'rgba(60,60,60,0.5)';
      ctx.lineWidth = 1.3;
      // Horizontal seam
      const seamY = y + Math.floor(this._rand01(c, r, 11) * ts);
      ctx.beginPath();
      ctx.moveTo(x, seamY);
      ctx.lineTo(x + ts, seamY);
      ctx.stroke();
      // Speckles
      ctx.fillStyle = 'rgba(70,70,70,0.4)';
      for (let i = 0; i < 6; i++) {
        const dx = this._rand01(c, r, i + 30) * ts;
        const dy = this._rand01(c, r, i + 33) * ts;
        ctx.fillRect(x + dx, y + dy, 1.3, 1.3);
      }
    }
  }
}

// ---------- AudioFx ----------
// Lightweight WebAudio-based SFX. No audio files required — all sounds are
// short oscillator envelopes. Defaults to OFF for considerate commute play;
// users can flip the 🔇 button in the HUD.
class AudioFx {
  constructor() {
    this.enabled = false;
    try { this.enabled = localStorage.getItem('ant_sfx') === 'true'; } catch (_) {}
    this.ctx = null;
    this.master = null;
  }
  _ensureCtx() {
    if (this.ctx) return;
    const C = window.AudioContext || window.webkitAudioContext;
    if (!C) return;
    try {
      this.ctx = new C();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.35;
      this.master.connect(this.ctx.destination);
    } catch (_) { this.ctx = null; }
  }
  resume() {
    if (this.ctx && this.ctx.state === 'suspended') {
      this.ctx.resume().catch(() => {});
    }
  }
  setEnabled(on) {
    this.enabled = !!on;
    try { localStorage.setItem('ant_sfx', this.enabled ? 'true' : 'false'); } catch (_) {}
    if (this.enabled) { this._ensureCtx(); this.resume(); }
  }
  toggle() { this.setEnabled(!this.enabled); return this.enabled; }
  play(name) {
    if (!this.enabled) return;
    this._ensureCtx();
    if (!this.ctx) return;
    this.resume();
    const t = this.ctx.currentTime;
    switch (name) {
      case 'tap':       this._tone(t,        880, 0.05, 0.18, 'sine'); break;
      case 'hit':       this._tone(t,        220, 0.08, 0.22, 'square'); break;
      case 'food':      this._tone(t,        700, 0.07, 0.20, 'triangle');
                        this._tone(t + 0.07, 1100, 0.08, 0.22, 'triangle'); break;
      case 'deposit':   this._tone(t,        500, 0.09, 0.20, 'triangle');
                        this._tone(t + 0.09,  750, 0.09, 0.22, 'triangle');
                        this._tone(t + 0.18, 1000, 0.14, 0.22, 'triangle'); break;
      case 'hatch':     this._tone(t,        420, 0.10, 0.18, 'sine');
                        this._tone(t + 0.06,  650, 0.12, 0.20, 'sine'); break;
      case 'kill':      this._tone(t,        320, 0.08, 0.22, 'sawtooth');
                        this._tone(t + 0.06,  220, 0.10, 0.22, 'sawtooth'); break;
      case 'raid':      this._tone(t,        220, 0.14, 0.30, 'sawtooth');
                        this._tone(t + 0.15, 180, 0.18, 0.30, 'sawtooth'); break;
      case 'milestone': this._tone(t,        523, 0.10, 0.22, 'triangle');
                        this._tone(t + 0.10, 659, 0.10, 0.22, 'triangle');
                        this._tone(t + 0.20, 784, 0.22, 0.25, 'triangle'); break;
      case 'levelup':   this._tone(t,        440, 0.08, 0.20, 'sine');
                        this._tone(t + 0.10, 660, 0.08, 0.20, 'sine');
                        this._tone(t + 0.20, 880, 0.20, 0.22, 'sine'); break;
      case 'expand':    this._tone(t,        300, 0.18, 0.22, 'triangle');
                        this._tone(t + 0.18, 500, 0.20, 0.22, 'triangle'); break;
      case 'heal':      this._tone(t,        700, 0.10, 0.20, 'sine');
                        this._tone(t + 0.08, 950, 0.12, 0.22, 'sine'); break;
      case 'win':       this._tone(t,        523, 0.12, 0.25, 'triangle');
                        this._tone(t + 0.12, 659, 0.12, 0.25, 'triangle');
                        this._tone(t + 0.24, 784, 0.12, 0.25, 'triangle');
                        this._tone(t + 0.36, 1047, 0.30, 0.27, 'triangle'); break;
      case 'powerup':   this._tone(t,        523, 0.06, 0.22, 'square');
                        this._tone(t + 0.06, 784, 0.06, 0.24, 'square');
                        this._tone(t + 0.12, 1047, 0.10, 0.25, 'square'); break;
      case 'death':     this._tone(t,        440, 0.10, 0.22, 'sawtooth');
                        this._tone(t + 0.10, 330, 0.12, 0.22, 'sawtooth');
                        this._tone(t + 0.22, 220, 0.20, 0.25, 'sawtooth'); break;
      case 'respawn':   this._tone(t,        330, 0.10, 0.22, 'sine');
                        this._tone(t + 0.10, 440, 0.10, 0.22, 'sine');
                        this._tone(t + 0.20, 660, 0.16, 0.22, 'sine'); break;
    }
  }
  _tone(when, freq, dur, vol, type) {
    if (!this.ctx) return;
    const o = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    o.type = type;
    o.frequency.value = freq;
    g.gain.setValueAtTime(vol, when);
    g.gain.exponentialRampToValueAtTime(0.0001, when + dur);
    o.connect(g); g.connect(this.master);
    o.start(when); o.stop(when + dur + 0.05);
  }
}

// ---------- BGM ----------
// Procedural background music. No audio files — built from oscillators on
// top of AudioFx. Two moods: "calm" (default) and "tense" (during raids).
class BGMPlayer {
  constructor(fx) {
    this.fx = fx;
    // Default ON unless the user has explicitly turned it off.
    this.enabled = true;
    try {
      const v = localStorage.getItem('ant_bgm');
      if (v !== null) this.enabled = v === 'true';
    } catch (_) {}
    this.intensity = 'calm';
    this.scheduler = null;
    this.nextNoteTime = 0;
    this.step = 0;
    this.master = null;
    // 16-step patterns for each mood. Frequencies in Hz.
    // Calm: C major pentatonic-ish arp + bass on the I/V/vi/IV chords.
    this.patterns = {
      calm: {
        arp:  [262, 330, 392, 523, 392, 330, 262, 196,
               220, 277, 330, 440, 330, 277, 220, 165],
        bass: [131, null, null, null, 196, null, null, null,
               220, null, null, null, 175, null, null, null],
        tempo: 100
      },
      tense: {
        arp:  [220, 262, 311, 415, 311, 262, 220, 175,
               196, 233, 294, 392, 294, 233, 196, 147],
        bass: [110, null, null, null, 147, null, null, null,
               165, null, null, null, 123, null, null, null],
        tempo: 130
      }
    };
  }
  _ensureChain() {
    this.fx._ensureCtx();
    if (!this.fx.ctx) return false;
    if (!this.master) {
      this.master = this.fx.ctx.createGain();
      this.master.gain.value = 0.18;  // BGM softer than SFX
      this.master.connect(this.fx.ctx.destination);
    }
    return true;
  }
  setEnabled(on) {
    this.enabled = !!on;
    try { localStorage.setItem('ant_bgm', this.enabled ? 'true' : 'false'); } catch (_) {}
    if (this.enabled) this.start();
    else this.stop();
  }
  toggle() { this.setEnabled(!this.enabled); return this.enabled; }
  setIntensity(mode) { this.intensity = mode; }
  start() {
    if (!this.enabled) return;
    if (!this._ensureChain()) return;
    this.fx.resume();
    this.nextNoteTime = this.fx.ctx.currentTime + 0.1;
    if (!this.scheduler) {
      this.scheduler = setInterval(() => this._tick(), 25);
    }
  }
  stop() {
    if (this.scheduler) { clearInterval(this.scheduler); this.scheduler = null; }
  }
  _tick() {
    if (!this.fx.ctx) return;
    const now = this.fx.ctx.currentTime;
    while (this.nextNoteTime < now + 0.12) {
      this._playStep(this.step, this.nextNoteTime);
      const tempo = this.patterns[this.intensity].tempo;
      this.nextNoteTime += 60 / tempo / 4;  // 16th note
      this.step = (this.step + 1) % 16;
    }
  }
  _playStep(step, when) {
    const pat = this.patterns[this.intensity] || this.patterns.calm;
    const note = pat.arp[step];
    if (note) this._note(when, note, 0.18, 0.18, 'triangle');
    const b = pat.bass[step];
    if (b) this._note(when, b, 0.40, 0.20, 'sine');
    // Soft pad on first beat of each bar
    if (step === 0) this._note(when, this.intensity === 'tense' ? 110 : 131, 1.6, 0.10, 'sine');
  }
  _note(when, freq, dur, vol, type) {
    const ctx = this.fx.ctx;
    if (!ctx || !this.master) return;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = type;
    o.frequency.value = freq;
    g.gain.setValueAtTime(0, when);
    g.gain.linearRampToValueAtTime(vol, when + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, when + dur);
    o.connect(g); g.connect(this.master);
    o.start(when); o.stop(when + dur + 0.05);
  }
}

// ---------- Game ----------
class Game {
  constructor() {
    this.canvas = document.getElementById('gameCanvas');
    this.ctx = this.canvas.getContext('2d');
    this.player = null;
    this.friends = [];
    this.foods = [];
    this.enemies = [];
    this.eggs = [];
    this.healItems = [];
    this.particles = [];
    this.damageNumbers = [];
    this.grassTufts = [];
    this.terrain = null;
    this.camera = { x: 0, y: 0, cx: 0, cy: 0, scale: 1 };
    this.cinematic = null;
    this.audio = new AudioFx();
    this.bgm = new BGMPlayer(this.audio);
    // Vibration setting (default ON). Stored separately from SFX.
    let vib = true;
    try { const v = localStorage.getItem('ant_vibrate'); if (v !== null) vib = v === 'true'; } catch (_) {}
    this.vibrationEnabled = vib;
    this.viewW = 0;
    this.viewH = 0;
    this.dpr = Math.max(1, window.devicePixelRatio || 1);
    this.input = { moving: false, moveX: 0, moveY: 0 };
    this.gameState = 'start';
    this.respawnTimer = 0;
    this.foodSpawnTimer = 0;
    this.enemySpawnTimer = 5000;
    this.healSpawnTimer = 18000;
    this.lastTime = performance.now();
    this.time = 0;
    this.firstFoodSeen = false;
    this.firstEnemySeen = false;
    this.firstBigFoodSeen = false;
    this.firstHealSeen = false;
    this.expansionStage = 0;
    this.shakeTimer = 0;
    this.shakeMag = 0;
    this.raidTimer = 50000;  // first raid possible after ~50s
    this.raidActive = false;
    this.raidEnemies = [];
    this.pendingExpansionRaid = false;
    this.unlockedBiomes = new Set();

    this.resize();
    window.addEventListener('resize', () => this.resize());
    window.addEventListener('orientationchange', () => setTimeout(() => this.resize(), 100));
    // Pause BGM when the tab is hidden so it doesn't keep playing in the
    // background. SFX are event-driven so they don't need explicit pausing.
    document.addEventListener('visibilitychange', () => {
      if (!this.bgm) return;
      if (document.hidden) this.bgm.stop();
      else if (this.bgm.enabled && this.gameState === 'playing') this.bgm.start();
    });
    this.setupControls();
    this.setupUI();
    this.generateGrass();

    // Start the game loop right away (it will idle on start screen)
    requestAnimationFrame(this.loop.bind(this));
  }

  resize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.canvas.width = w * this.dpr;
    this.canvas.height = h * this.dpr;
    this.canvas.style.width = w + 'px';
    this.canvas.style.height = h + 'px';
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.viewW = w;
    this.viewH = h;
  }

  generateGrass() {
    this.grassTufts = [];
    // Sprinkle tufts inside the initial (square) zone, avoiding the nest disc.
    const half = ZONE_SIZE / 2;
    for (let i = 0; i < 50; i++) {
      const x = rand(NEST_X - half + 40, NEST_X + half - 40);
      const y = rand(NEST_Y - half + 40, NEST_Y + half - 40);
      // Don't drop tufts on top of the nest disc.
      if (Math.hypot(x - NEST_X, y - NEST_Y) < NEST_RADIUS_BASE + 30) continue;
      this.grassTufts.push(new GrassTuft(x, y, rand(0.7, 1.2)));
    }
    // A few around the nest perimeter for visual flair.
    for (let i = 0; i < 16; i++) {
      const a = Math.random() * Math.PI * 2;
      const r = rand(NEST_RADIUS_BASE + 30, NEST_RADIUS_BASE + 100);
      this.grassTufts.push(new GrassTuft(
        NEST_X + Math.cos(a) * r,
        NEST_Y + Math.sin(a) * r - 20,
        rand(0.7, 1)
      ));
    }
  }

  // Field expansion — appends a new ZONE_SIZE × ZONE_SIZE biome zone adjacent
  // to one of the currently-unlocked zones. Direction is randomised so the
  // map grows organically in any of N/S/E/W rather than only east.
  // Rocks in the chosen direction get carved away (the new zone replaces them).
  expandWorld() {
    const placement = this._pickZonePlacement();
    if (!placement) return; // No valid spot — keep silently.
    this.expansionStage++;
    const biomeType = BIOME_SEQUENCE[(this.expansionStage - 1) % BIOME_SEQUENCE.length];
    const isFirstUnlock = !this.unlockedBiomes.has(biomeType);
    this.unlockedBiomes.add(biomeType);

    // Carve the new zone out of the rock and stamp the biome over it.
    const zone = { ...placement, biome: biomeType };
    this.zones.push(zone);
    if (this.terrain) {
      this.terrain.fillRect(zone, 'grass');           // ground (carve rock)
      this.terrain.fillBiome(zone, biomeType, 0.8);   // biome with grass clearings
    }

    // Add some grass tufts inside the new zone for visual flair.
    for (let i = 0; i < 10; i++) {
      const x = rand(zone.x0 + 20, zone.x1 - 20);
      const y = rand(zone.y0 + 20, zone.y1 - 20);
      this.grassTufts.push(new GrassTuft(x, y, rand(0.7, 1.2)));
    }

    // Visual feedback + 2-line announcement.
    this.shakeTimer = 600;
    this.shakeMag = 6;
    const info = BIOME_UNLOCK_INFO[biomeType];
    const headline = isFirstUnlock
      ? '✨ 新しいエリアが追加されました！'
      : '🌍 エリアが広がった！';
    this.showMessage(headline, 'success', 3500);
    const detail = info
      ? (isFirstUnlock ? `${info.name}エリア: ${info.intro}` : `${info.name}エリアが拡張されました`)
      : `🌍 ステージ ${this.expansionStage}`;
    setTimeout(() => {
      if (this.gameState === 'playing') this.showMessage(detail, 'success', 3000);
    }, 700);

    // Sparkle particles along the carve-away border (where rocks just moved).
    for (let i = 0; i < 24; i++) {
      const x = rand(zone.x0, zone.x1);
      const y = rand(zone.y0, zone.y1);
      this.particles.push(new Particle(x, y, rand(-0.5, 0.5), rand(-1.5, -0.5), rand(800, 1400), '#ffe680', rand(2, 3)));
    }

    if (this.audio) this.audio.play('expand');
    // Welcome gift: just a healing heart (reward power-ups are now reserved
    // for raid clears).
    const giftX = (zone.x0 + zone.x1) / 2;
    const giftY = (zone.y0 + zone.y1) / 2;
    this.healItems.push(new HealItem(giftX, giftY));

    // Seed the new zone with at least one new food and one new enemy.
    this._seedNewBiomeContent(zone, biomeType);

    // Persist after a major milestone.
    this.saveGame();

    // Cinematic camera: zoom out, pan to the new zone, hold, then return.
    this.startCinematic(zone);

    // Expansion arrow: a big "→ 🌍 NEW" pointer toward the new zone for ~5s,
    // so the player knows which way to head when the cinematic ends.
    this.expansionArrow = {
      zoneCx: (zone.x0 + zone.x1) / 2,
      zoneCy: (zone.y0 + zone.y1) / 2,
      timer: 5000
    };

    // 10 seconds after the area opens, the new area's denizens raid the nest.
    // GUARANTEED: this raid always fires, even if a raid is currently active
    // (it queues for after) and even if friend count is low (force bypasses
    // the normal threshold). The expansion-raid is a scripted dramatic beat.
    this.pendingExpansionRaid = true;
    if (!this.raidActive) {
      this.raidTimer = 10000;
      this.raidWarningGiven = false;
      this.raidImminent = false;
    }
  }

  startCinematic(zone) {
    const playerCx = this.player.x;
    const playerCy = this.player.y;
    const zoneCx   = (zone.x0 + zone.x1) / 2;
    const zoneCy   = (zone.y0 + zone.y1) / 2;
    const zoomOut  = 0.65;
    this.cinematic = {
      t: 0,
      segments: [
        // 1. Zoom out at player, ~400ms
        { from: { cx: playerCx, cy: playerCy, scale: 1 },
          to:   { cx: playerCx, cy: playerCy, scale: zoomOut },
          duration: 400 },
        // 2. Pan to new zone, ~1200ms
        { from: { cx: playerCx, cy: playerCy, scale: zoomOut },
          to:   { cx: zoneCx,   cy: zoneCy,   scale: zoomOut },
          duration: 1200 },
        // 3. Hold on the new zone, ~600ms
        { from: { cx: zoneCx, cy: zoneCy, scale: zoomOut },
          to:   { cx: zoneCx, cy: zoneCy, scale: zoomOut },
          duration: 600 },
        // 4. Pan back + zoom in, ~500ms
        { from: { cx: zoneCx,   cy: zoneCy,   scale: zoomOut },
          to:   { cx: playerCx, cy: playerCy, scale: 1 },
          duration: 500 }
      ]
    };
  }

  // Spiral grid coordinate for zone N (N=0 is the initial zone at origin).
  // Returns [gx, gy] in zone-grid units. Matches the numbered layout the
  // user designed (1=N, 2=NE, 3=E, 4=SE, 5=S, 6=SW, 7=W, 8=NW, then layer 2…).
  _spiralCoord(n) {
    if (n === 0) return [0, 0];
    const L = Math.ceil((Math.sqrt(n + 1) - 1) / 2);
    const start = (2 * L - 1) * (2 * L - 1);
    const k = n - start;
    const side = 2 * L;
    let gx, gy;
    if      (k < side)     { gx = -(L - 1) + k;             gy = -L; }
    else if (k < 2 * side) { gx =  L;                       gy = -(L - 1) + (k -     side); }
    else if (k < 3 * side) { gx = (L - 1) - (k - 2 * side); gy =  L; }
    else                   { gx = -L;                       gy = (L - 1) - (k - 3 * side); }
    return [gx, gy];
  }

  // Compute the next zone's bounds from the spiral. Stage N maps to grid
  // index N, so stage 1 → north of nest, stage 2 → north-east corner, etc.
  _pickZonePlacement() {
    const sz = ZONE_SIZE;
    const idx = this.expansionStage + 1;  // about to advance to this stage
    const [gx, gy] = this._spiralCoord(idx);
    const cx = NEST_X + gx * sz;
    const cy = NEST_Y + gy * sz;
    const half = sz / 2;
    const z = { x0: cx - half, y0: cy - half, x1: cx + half, y1: cy + half };
    if (!this._zoneIsValid(z)) return null;
    return z;
  }

  _zoneIsValid(z) {
    // Within world bounds (with margin)
    if (z.x0 < 40 || z.y0 < 40 || z.x1 > WORLD_WIDTH - 40 || z.y1 > WORLD_HEIGHT - 40) return false;
    // Doesn't overlap nest disc (with padding)
    const cx = (z.x0 + z.x1) / 2, cy = (z.y0 + z.y1) / 2;
    const halfW = (z.x1 - z.x0) / 2, halfH = (z.y1 - z.y0) / 2;
    const nestPad = NEST_RADIUS_BASE + 60;
    const nearestX = clamp(NEST_X, z.x0, z.x1);
    const nearestY = clamp(NEST_Y, z.y0, z.y1);
    if (Math.hypot(NEST_X - nearestX, NEST_Y - nearestY) < nestPad &&
        !(cx === NEST_X && cy === NEST_Y)) {
      // Allow if nest is already inside an existing zone — but new zones
      // shouldn't graze the nest disc.
      if (Math.hypot(NEST_X - nearestX, NEST_Y - nearestY) < nestPad) return false;
    }
    // Doesn't significantly overlap any existing zone
    for (const other of this.zones) {
      const overlapX = Math.min(z.x1, other.x1) - Math.max(z.x0, other.x0);
      const overlapY = Math.min(z.y1, other.y1) - Math.max(z.y0, other.y0);
      if (overlapX > 30 && overlapY > 30) return false;
    }
    return true;
  }

  // Place 1-2 fresh foods and 1-2 fresh enemies inside the newly opened biome
  // zone. Used by expandWorld() so the new area always has visible content.
  _seedNewBiomeContent(zone, biomeType) {
    const yMin = zone.y0 + 30;
    const yMax = zone.y1 - 30;
    const stripX0 = zone.x0 + 30;
    const stripX1 = zone.x1 - 30;
    const pickWalkable = (allowPond) => {
      // Try several positions to land on a non-rock (and optionally non-pond) tile.
      for (let i = 0; i < 20; i++) {
        const x = rand(stripX0, stripX1);
        const y = rand(yMin, yMax);
        const t = this.terrain ? this.terrain.getAt(x, y) : 'grass';
        if (t === 'rock') continue;
        if (!allowPond && t === 'pond') continue;
        return { x, y, t };
      }
      return null;
    };

    // --- Foods (no pond placement — they would be unreachable) ---
    const stage = this.expansionStage;
    // At least 5 foods in every new biome zone so the area feels rewarding
    // immediately, with one or two extras at higher stages.
    const foodCount = stage >= 5 ? 7 : stage >= 3 ? 6 : 5;
    for (let i = 0; i < foodCount; i++) {
      const pos = pickWalkable(false);
      if (!pos) continue;
      let type;
      if (stage < 1) type = 'small';
      else if (stage < 2) type = Math.random() < 0.5 ? 'small' : 'medium';
      else if (stage < 3) type = Math.random() < 0.6 ? 'medium' : 'large';
      else if (stage < 4) type = Math.random() < 0.5 ? 'medium' : 'large';
      else type = Math.random() < 0.5 ? 'large' : 'huge';
      const f = new Food(pos.x, pos.y, type);
      f.eggBonus = FOOD_TERRAIN_EGG_BONUS[pos.t] || 1.0;
      this.foods.push(f);
    }

    // --- Enemies ---
    const enemyCount = 1 + (stage >= 3 && Math.random() < 0.5 ? 1 : 0);
    const cfg = ENEMY_TERRAIN[biomeType] || ENEMY_TERRAIN.grass;
    const hasMud = this.unlockedBiomes.has('mud');
    const hasPond = this.unlockedBiomes.has('pond');
    for (let i = 0; i < enemyCount; i++) {
      let type = cfg.bias || 'spider';
      if (type === 'beetle' && !hasMud) type = 'spider';
      if (type === 'wasp'   && !hasPond) type = 'spider';
      const pos = pickWalkable(type === 'wasp');
      if (!pos) continue;
      this.enemies.push(new Enemy(pos.x, pos.y, type, cfg.scale || 1.0));
    }
  }

  // Begin a nest raid — a coordinated attack heading straight for the nest.
  // Both squad size and per-raider strength scale with the colony, and an
  // occasional very strong boss raider can join the formation.
  startRaid(force = false) {
    if (this.raidActive) return;
    if (!force && this.friends.filter(f => !f.dead).length < 10) return;
    const totalAnts = 1 + this.friends.length;

    // Squad size: 3 → 22 across 0 → 1000 friends.
    const count = clamp(3 + Math.floor(totalAnts / 50), 3, 22);
    // Per-raider power scale: 1.0 → 1.8 across 0 → 1000 friends.
    const powerScale = 1.0 + Math.min(0.8, totalAnts / 1000);
    // Boss is ALWAYS present in a raid. Boss strength scales hard with the
    // colony — small colonies face a modest boss, late game faces a giant.
    const includeBoss = true;
    // Boss multiplier: 2.5x at 20 friends → 8.0x at 1000+ friends. The boss
    // type also rotates so the visual changes as the colony grows.
    const bossMul = 2.5 + Math.min(5.5, totalAnts / 180);

    // Pick the outermost unlocked zone (farthest from the nest) and spawn
    // the formation INSIDE it. Spawning at the world edge stuck raiders in
    // rock with the new spiral layout — they couldn't path back to the nest.
    let outerZone = this.zones[0];
    let bestDist = -1;
    for (const z of this.zones) {
      const cx = (z.x0 + z.x1) / 2, cy = (z.y0 + z.y1) / 2;
      const d = Math.hypot(cx - NEST_X, cy - NEST_Y);
      if (d > bestDist) { bestDist = d; outerZone = z; }
    }
    // Spawn position: along the edge of outerZone that faces AWAY from the nest.
    const ocx = (outerZone.x0 + outerZone.x1) / 2;
    const ocy = (outerZone.y0 + outerZone.y1) / 2;
    const adx = ocx - NEST_X, ady = ocy - NEST_Y;
    let baseX, baseY, dx, dy;
    if (Math.abs(adx) > Math.abs(ady)) {
      // Outer edge is east or west
      baseX = adx > 0 ? outerZone.x1 - 50 : outerZone.x0 + 50;
      baseY = ocy;
      dx = 0; dy = 30;
    } else {
      // Outer edge is north or south
      baseX = ocx;
      baseY = ady > 0 ? outerZone.y1 - 50 : outerZone.y0 + 50;
      dx = 30; dy = 0;
    }

    this.raidEnemies = [];

    // Boss raider — placed slightly behind the formation centre.
    // Boss type rotates with colony size for visual variety:
    //   <100 → beetle, <300 → scorpion, <600 → slug, 600+ → hornet swarm-leader
    if (includeBoss) {
      const bossX = clamp(baseX, 40, WORLD_WIDTH - 40);
      const bossY = clamp(baseY, 40, WORLD_HEIGHT - 40);
      let bossType = 'beetle';
      if (totalAnts >= 600 && this.unlockedBiomes.has('flower')) bossType = 'hornet';
      else if (totalAnts >= 300 && this.unlockedBiomes.has('leaves')) bossType = 'slug';
      else if (totalAnts >= 100 && this.unlockedBiomes.has('sand')) bossType = 'scorpion';
      const boss = new Enemy(bossX, bossY, bossType, bossMul, true);
      boss.isBoss = true;
      this.enemies.push(boss);
      this.raidEnemies.push(boss);
    }

    for (let i = 0; i < count; i++) {
      const sx = clamp(baseX + (i - count / 2) * dx, 40, WORLD_WIDTH - 40);
      const sy = clamp(baseY + (i - count / 2) * dy, 40, WORLD_HEIGHT - 40);
      // Type mix shifts toward beetles/wasps in late game (more variety + threat).
      const r = Math.random();
      let type;
      if (totalAnts < 200) type = r < 0.65 ? 'spider' : r < 0.88 ? 'beetle' : 'wasp';
      else if (totalAnts < 500) type = r < 0.45 ? 'spider' : r < 0.75 ? 'beetle' : 'wasp';
      else type = r < 0.30 ? 'spider' : r < 0.65 ? 'beetle' : 'wasp';
      const e = new Enemy(sx, sy, type, powerScale, true);
      this.enemies.push(e);
      this.raidEnemies.push(e);
    }
    this.raidActive = true;
    this.shakeTimer = 700;
    this.shakeMag = 4;
    this.raidWarningGiven = false;
    this.raidImminent = false;
    this.raidArrived = false;
    this.raidPenaltyApplied = false;
    const bossLabel = includeBoss ? ' + 👑ボス' : '';
    this.showMessage(`⚠️ 巣に敵が来る！ (${count}体${bossLabel})`, 'warn', 3500);
    if (this.audio) this.audio.play('raid');
    if (this.bgm) this.bgm.setIntensity('tense');
  }

  endRaid(success) {
    this.raidActive = false;
    this.raidEnemies = [];
    this.raidWarningGiven = false;
    this.raidImminent = false;
    this.raidArrived = false;
    this.raidPenaltyApplied = false;
    if (success) {
      this._statBump('raidsWon');
      this.showMessage('🛡️ 巣を守った！ ご褒美が現れた！', 'success', 3500);
      // Spawn a heart bonus near the nest, plus 2 reward power-ups.
      let x, y, attempts = 0;
      do {
        x = NEST_X + rand(-160, 160);
        y = NEST_Y - NEST_RADIUS_BASE - rand(20, 80);
        attempts++;
      } while ((y < 40 || x < 60 || x > WORLD_WIDTH - 60) && attempts < 8);
      if (attempts < 8) this.healItems.push(new HealItem(x, y));
      // Reward power-ups: 2 random ones around the player so the player can
      // grab them while basking in the victory.
      if (this.player && !this.player.dead && this.powerUps) {
        const types = Object.keys(POWERUP_DEFS);
        for (let i = 0; i < 2; i++) {
          const a = Math.random() * Math.PI * 2;
          const r = 60 + i * 30;
          const px = clamp(this.player.x + Math.cos(a) * r, 30, WORLD_WIDTH - 30);
          const py = clamp(this.player.y + Math.sin(a) * r, 30, WORLD_HEIGHT - 30);
          const t = types[Math.floor(Math.random() * types.length)];
          this.powerUps.push(new PowerUp(px, py, t));
        }
      }
    }
    // Schedule next raid + return to calm music. If an area opened during
    // the raid, honor the guaranteed 10s post-expansion raid now.
    if (this.pendingExpansionRaid) {
      this.raidTimer = 10000;
      this.raidWarningGiven = false;
      this.raidImminent = false;
    } else {
      // Larger colonies get raided more often (they can handle it, and the
      // action stays lively). Window shrinks from 60-110s at 0 friends down
      // to ~30-55s at 1000+.
      const tFr = Math.min(1, this.friends.length / 1000);
      const minMs = 60000 - 30000 * tFr;
      const maxMs = 110000 - 55000 * tFr;
      this.raidTimer = rand(minMs, maxMs);
    }
    if (this.bgm) this.bgm.setIntensity('calm');
    this.saveGame();
  }

  // Hidden raid-arrival penalty: silently kills a fraction of the colony
  // when the raid reaches the nest with the player still away. The user sees
  // their colony count drop without an explicit message — that's intentional.
  _applySilentRaidPenalty(fraction) {
    const alive = this.friends.filter(f => !f.dead);
    const toKill = Math.min(alive.length, Math.floor(alive.length * fraction));
    if (toKill <= 0) return;
    this._statBump('raidsFailed');
    // Shuffle to pick random victims
    for (let i = alive.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [alive[i], alive[j]] = [alive[j], alive[i]];
    }
    for (let k = 0; k < toKill; k++) {
      const f = alive[k];
      // Drop carried food cleanly so the carry state doesn't get stuck
      if (f.carrying) {
        f.carrying.carriers = f.carrying.carriers.filter(c => c !== f);
        if (f.carrying.carriers.length < f.carrying.required) {
          f.carrying.dropFood(this);
        }
        f.carrying = null;
      }
      f.hp = 0;
      f.dead = true;
      // Subtle dust puff — ant-colored, no damage number, no message.
      for (let i = 0; i < 4; i++) {
        const a = Math.random() * Math.PI * 2;
        const s = rand(0.6, 1.6);
        this.particles.push(new Particle(
          f.x, f.y,
          Math.cos(a) * s, Math.sin(a) * s - 0.4,
          rand(400, 700), '#5a3416', rand(1.5, 2.2)
        ));
      }
    }
  }

  // Used by friend defense AI / Egg.takeDamage / friend death to wake nearby ants.
  alertNearbyFriends(x, y, radius, attacker) {
    // If no specific attacker given, pick the nearest enemy near the alert point.
    let targetEnemy = (attacker && !attacker.dead) ? attacker : null;
    if (!targetEnemy) {
      let best = null, bestD = radius * 1.4;
      for (const e of this.enemies) {
        if (e.dead) continue;
        const d = Math.hypot(e.x - x, e.y - y);
        if (d < bestD) { best = e; bestD = d; }
      }
      targetEnemy = best;
    }
    for (const f of this.friends) {
      if (f.dead || f.state === 'carrying') continue;
      if (Math.hypot(f.x - x, f.y - y) > radius) continue;
      if (targetEnemy) {
        f.state = 'attacking';
        f.target = targetEnemy;
        f.callTimer = 8000;
      }
    }
  }

  startGame(saveData = null) {
    // Reset world dimensions in case of replay after expansion
    WORLD_WIDTH = 4400;
    WORLD_HEIGHT = 4400;
    NEST_X = 2200;
    NEST_Y = 2200;

    this.player = new Ant(NEST_X, NEST_Y - 60, true);
    // Apply selected skin (cosmetic) to player ant.
    this._applyActiveSkin();
    this.friends = [];
    this.foods = [];
    this.enemies = [];
    this.eggs = [];
    this.healItems = [];
    this.particles = [];
    this.damageNumbers = [];
    this.gameState = 'playing';
    this.foodSpawnTimer = 1000;
    this.enemySpawnTimer = 8000;
    this.healSpawnTimer = 18000;
    this.expansionStage = 0;
    this.shakeTimer = 0;
    this.shakeMag = 0;
    this.raidTimer = 50000;
    this.raidActive = false;
    this.raidEnemies = [];
    this.pendingExpansionRaid = false;
    this.raidWarningGiven = false;
    this.raidImminent = false;
    this.raidArrived = false;
    this.raidPenaltyApplied = false;
    // Call-window suspense: rises to 1.0 when calling friends, decays to 0 over ~5s.
    this.callStress = 0;
    // Random mid-game events
    this.eventTimer = rand(90000, 150000);
    this.activeEvent = null;
    this.activeEventTimer = 0;
    this._eventEnemyMul = 1.0;
    this._eventFoodMul = 1.0;
    this._eventPlayerSpeedMul = 1.0;
    this._eventEnemySpeedMul = 1.0;
    // Active power-up (one slot at a time; latest wins)
    this.powerUps = [];
    this.activePowerUp = null;
    this.activePowerUpTimer = 0;
    // Pheromone trail (visual only). Capped to keep render cheap.
    this.trailPoints = [];
    this._trailAcc = 0;
    // Colony level + per-bonus tracking. Bonuses get re-applied on continue.
    this.colonyLevel = 0;
    this.nestLevel = 0;
    // One tap of "Call" brings up to this many NEW followers. Tapping again
    // adds another batch (already-following ants only refresh their timer
    // and don't consume the cap).
    this.maxCallSize = 5;
    this.bonuses = {
      friendMaxHp: FRIEND_HP,
      friendAttack: FRIEND_ATTACK,
      carrySpeedMul: 1.0,
      hatchTimeMul: 1.0,
      nestRegenPerSec: 0
    };
    // Set of biome types unlocked so far (drives enemy/food unlock gates).
    this.unlockedBiomes = new Set();
    // Zones: list of accessible rectangles. The first zone is the initial
    // grass area around/above the nest; new zones unlock with expansions.
    this.zones = [];
    // Initial terrain: everything is rock by default; we then carve out the
    // initial zone with grass.
    this.terrain = new TerrainGrid(WORLD_WIDTH, WORLD_HEIGHT);
    const half = ZONE_SIZE / 2;
    const initialZone = {
      x0: NEST_X - half,
      y0: NEST_Y - half,
      x1: NEST_X + half,
      y1: NEST_Y + half,
      biome: 'grass'
    };
    this.zones.push(initialZone);
    this.terrain.fillRect(initialZone, 'grass');

    // Restore from save (zones, biomes, friend count) if provided.
    if (saveData) {
      this.expansionStage = saveData.expansionStage || 0;
      this.unlockedBiomes = new Set(saveData.unlockedBiomes || []);
      // Replay colony-level applies up to saved level (mutates player + bonuses).
      const savedLv = saveData.colonyLevel || 0;
      for (const def of COLONY_LEVELS) {
        if (def.lv > savedLv) break;
        this.colonyLevel = def.lv;
        def.apply(this);
      }
      // Replay nest-level applies up to saved level.
      const savedNestLv = saveData.nestLevel || 0;
      for (const def of NEST_LEVELS) {
        if (def.lv > savedNestLv) break;
        this.nestLevel = def.lv;
        def.apply(this);
      }
      // Re-stamp each saved non-initial zone (initial zone is already stamped).
      for (const sz of saveData.zones || []) {
        const isInitial = sz.x0 === initialZone.x0 && sz.y0 === initialZone.y0
                       && sz.x1 === initialZone.x1 && sz.y1 === initialZone.y1;
        if (isInitial) continue;
        this.zones.push({ x0: sz.x0, y0: sz.y0, x1: sz.x1, y1: sz.y1, biome: sz.biome });
        this.terrain.fillRect(sz, 'grass');
        if (sz.biome && sz.biome !== 'grass') {
          this.terrain.fillBiome(sz, sz.biome, 0.8);
        }
      }
      // Restore friend count (positions are not persisted — they spawn idle near the nest).
      const fc = clamp(saveData.friendCount || 0, 0, WIN_ANT_COUNT - 1);
      for (let i = 0; i < fc; i++) {
        const a = new Ant(NEST_X + rand(-80, 80), NEST_Y + rand(-50, 50), false);
        a.state = 'idle';
        this.friends.push(a);
      }
      // Restore HP (clamped to maxHp).
      this.player.hp = clamp(saveData.playerHp || this.player.maxHp, 1, this.player.maxHp);
      // Restore milestone-shown set so we don't replay the banners.
      this._milestoneShown = new Set(saveData.milestonesShown || []);
      // Skip "tutorial" hint messages — returning player.
      this.firstFoodSeen = true;
      this.firstEnemySeen = true;
      this.firstBigFoodSeen = true;
      this.firstHealSeen = true;
      this.showMessage(`💾 続きから (仲間 ${fc + 1}匹)`, 'success', 2200);
    } else {
      this.firstFoodSeen = false;
      this.firstEnemySeen = false;
      this.firstBigFoodSeen = false;
      this.firstHealSeen = false;
    }

    // Local-only analytics. No network. Stored alongside the save in
    // localStorage so we can show "your record so far" on the start screen
    // and visualize where the difficulty bites.
    if (saveData && saveData.stats) {
      this.stats = Object.assign(this._freshStats(), saveData.stats);
    } else {
      this.stats = this._freshStats();
    }
    this.stats.runStart = performance.now();

    // Tutorial: 3 short steps for first-time players. Saved players skip it.
    let tutorialDone = false;
    try { tutorialDone = localStorage.getItem('ant_tutorial_done') === 'true'; } catch (_) {}
    this.tutorialStep = (saveData || tutorialDone) ? 0 : 1;
    this._updateTutorialHint();

    // Snap the camera so the first frame doesn't pan from (0,0).
    this.camera.scale = 1;
    this.camera.cx = this.player.x;
    this.camera.cy = this.player.y;
    this.camera.x = clamp(this.player.x - this.viewW / 2, 0, WORLD_WIDTH - this.viewW);
    this.camera.y = clamp(this.player.y - this.viewH / 2, 0, WORLD_HEIGHT - this.viewH);
    this.cinematic = null;
    // Regenerate grass for the (reset) initial world
    this.generateGrass();
    // Initial food (always present so the player can immediately act)
    this.spawnInitialFoods();
    this._lastSaveTime = 0;
    // Music lifecycle: start with calm mood when a run begins.
    if (this.bgm) {
      this.bgm.setIntensity('calm');
      this.bgm.start();
    }
  }

  setupControls() {
    const hitArea = document.getElementById('joystickHitArea');
    const base = document.getElementById('joystickBase');
    const knob = document.getElementById('joystickKnob');

    let activeTouchId = null;
    let mouseDown = false;
    const MAX_RADIUS = 48;
    const DEAD_ZONE = 6;

    const getBaseCenter = () => {
      const rect = base.getBoundingClientRect();
      return {
        x: rect.left + rect.width / 2,
        y: rect.top + rect.height / 2
      };
    };

    const updateInput = (clientX, clientY) => {
      const center = getBaseCenter();
      const dx = clientX - center.x;
      const dy = clientY - center.y;
      const m = Math.hypot(dx, dy);
      let kx = dx, ky = dy;
      if (m > MAX_RADIUS) {
        kx = (dx / m) * MAX_RADIUS;
        ky = (dy / m) * MAX_RADIUS;
      }
      knob.style.transform = `translate(calc(-50% + ${kx}px), calc(-50% + ${ky}px))`;
      knob.classList.add('active');

      if (m > DEAD_ZONE) {
        const norm = Math.min(1, m / MAX_RADIUS);
        this.input.moving = true;
        this.input.moveX = (dx / m) * norm;
        this.input.moveY = (dy / m) * norm;
      } else {
        this.input.moving = false;
        this.input.moveX = 0;
        this.input.moveY = 0;
      }
    };

    const resetInput = () => {
      this.input.moving = false;
      this.input.moveX = 0;
      this.input.moveY = 0;
      knob.style.transform = 'translate(-50%, -50%)';
      knob.classList.remove('active');
    };

    // ---- Touch events ----
    hitArea.addEventListener('touchstart', (e) => {
      if (this.gameState !== 'playing') return;
      if (activeTouchId !== null) return;
      e.preventDefault();
      const t = e.changedTouches[0];
      activeTouchId = t.identifier;
      updateInput(t.clientX, t.clientY);
    }, { passive: false });

    // Track moves on document so finger can drag outside the hit area
    document.addEventListener('touchmove', (e) => {
      if (activeTouchId === null) return;
      for (let i = 0; i < e.changedTouches.length; i++) {
        const t = e.changedTouches[i];
        if (t.identifier === activeTouchId) {
          e.preventDefault();
          updateInput(t.clientX, t.clientY);
          return;
        }
      }
    }, { passive: false });

    const onTouchEnd = (e) => {
      if (activeTouchId === null) return;
      for (let i = 0; i < e.changedTouches.length; i++) {
        if (e.changedTouches[i].identifier === activeTouchId) {
          activeTouchId = null;
          resetInput();
          return;
        }
      }
    };
    document.addEventListener('touchend', onTouchEnd);
    document.addEventListener('touchcancel', onTouchEnd);

    // ---- Mouse events (desktop testing) ----
    hitArea.addEventListener('mousedown', (e) => {
      if (this.gameState !== 'playing') return;
      e.preventDefault();
      mouseDown = true;
      updateInput(e.clientX, e.clientY);
    });
    document.addEventListener('mousemove', (e) => {
      if (!mouseDown) return;
      updateInput(e.clientX, e.clientY);
    });
    document.addEventListener('mouseup', () => {
      if (!mouseDown) return;
      mouseDown = false;
      resetInput();
    });

    // ---- Action buttons ----
    const playTapEffect = (btn) => {
      // Restart the CSS ring animation by toggling the class.
      btn.classList.remove('tapped');
      // Force reflow so re-adding the class restarts animation
      // eslint-disable-next-line no-unused-expressions
      void btn.offsetWidth;
      btn.classList.add('tapped');
    };
    const setupBtn = (btn, handler) => {
      btn.addEventListener('touchstart', (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (this.gameState !== 'playing') return;
        playTapEffect(btn);
        handler();
      }, { passive: false });
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        if (this.gameState !== 'playing') return;
        playTapEffect(btn);
        handler();
      });
    };
    setupBtn(document.getElementById('attackBtn'), () => this.playerAttack());
    setupBtn(document.getElementById('callBtn'), () => this.playerCallFriends());

    // SFX toggle (HUD icon, defaults to muted).
    const sfxBtn = document.getElementById('sfxToggle');
    if (sfxBtn) {
      const renderIcon = () => { sfxBtn.textContent = this.audio.enabled ? '🔊' : '🔇'; };
      renderIcon();
      const toggle = (e) => {
        if (e) { e.preventDefault(); e.stopPropagation(); }
        this.audio.toggle();
        renderIcon();
        if (this.audio.enabled) this.audio.play('tap');
        // Sync the in-pause toggle if present.
        const sb = document.getElementById('settingSfx');
        if (sb) { sb.classList.toggle('on', this.audio.enabled); sb.textContent = this.audio.enabled ? 'ON' : 'OFF'; }
      };
      sfxBtn.addEventListener('click', toggle);
      sfxBtn.addEventListener('touchstart', toggle, { passive: false });
    }

    // BGM toggle (HUD icon).
    const bgmBtn = document.getElementById('bgmToggle');
    if (bgmBtn) {
      const renderBgm = () => bgmBtn.classList.toggle('off', !this.bgm.enabled);
      renderBgm();
      const toggle = (e) => {
        if (e) { e.preventDefault(); e.stopPropagation(); }
        this.bgm.toggle();
        renderBgm();
        const sb = document.getElementById('settingBgm');
        if (sb) { sb.classList.toggle('on', this.bgm.enabled); sb.textContent = this.bgm.enabled ? 'ON' : 'OFF'; }
      };
      bgmBtn.addEventListener('click', toggle);
      bgmBtn.addEventListener('touchstart', toggle, { passive: false });
    }

    // Pause button.
    const pauseBtn = document.getElementById('pauseBtn');
    if (pauseBtn) {
      const onPause = (e) => {
        if (e) { e.preventDefault(); e.stopPropagation(); }
        if (this.gameState !== 'playing') return;
        this.pauseGame();
      };
      pauseBtn.addEventListener('click', onPause);
      pauseBtn.addEventListener('touchstart', onPause, { passive: false });
    }

    // Pause-screen actions
    const resumeBtn = document.getElementById('resumeBtn');
    if (resumeBtn) resumeBtn.addEventListener('click', () => this.resumeGame());
    const restartBtn = document.getElementById('restartRunBtn');
    if (restartBtn) restartBtn.addEventListener('click', () => {
      if (!confirm('現在の進行を破棄して最初からやり直しますか？')) return;
      this.clearSave();
      document.getElementById('pauseScreen').classList.add('hidden');
      this.startGame();
    });
    const exitBtn = document.getElementById('exitBtn');
    if (exitBtn) exitBtn.addEventListener('click', () => {
      this.saveGame();
      document.getElementById('pauseScreen').classList.add('hidden');
      document.getElementById('startScreen').classList.remove('hidden');
      // Refresh the start-screen panels (continue button, stats, skins).
      this._renderStartPanels();
      this.gameState = 'start';
    });
    const resetAllBtn = document.getElementById('resetAllBtn');
    if (resetAllBtn) resetAllBtn.addEventListener('click', () => {
      if (!confirm('全データ (セーブ・記録・スキン) を消去します。本当に？')) return;
      try {
        ['ant_save','ant_stats','ant_history','ant_skin_unlocked','ant_skin_active',
         'ant_tutorial_done','ant_hints_seen','ant_sfx','ant_vibrate'].forEach(k => localStorage.removeItem(k));
      } catch (_) {}
      location.reload();
    });
    // Setting toggles (in pause screen) — sync with master state.
    const settingSfx = document.getElementById('settingSfx');
    if (settingSfx) {
      settingSfx.addEventListener('click', () => {
        this.audio.toggle();
        settingSfx.classList.toggle('on', this.audio.enabled);
        settingSfx.textContent = this.audio.enabled ? 'ON' : 'OFF';
        if (sfxBtn) sfxBtn.textContent = this.audio.enabled ? '🔊' : '🔇';
        if (this.audio.enabled) this.audio.play('tap');
      });
    }
    const settingBgm = document.getElementById('settingBgm');
    if (settingBgm) {
      settingBgm.addEventListener('click', () => {
        this.bgm.toggle();
        settingBgm.classList.toggle('on', this.bgm.enabled);
        settingBgm.textContent = this.bgm.enabled ? 'ON' : 'OFF';
        if (bgmBtn) bgmBtn.classList.toggle('off', !this.bgm.enabled);
      });
    }
    const settingVib = document.getElementById('settingVibrate');
    if (settingVib) {
      settingVib.addEventListener('click', () => {
        this.vibrationEnabled = !this.vibrationEnabled;
        try { localStorage.setItem('ant_vibrate', this.vibrationEnabled ? 'true' : 'false'); } catch (_) {}
        settingVib.classList.toggle('on', this.vibrationEnabled);
        settingVib.textContent = this.vibrationEnabled ? 'ON' : 'OFF';
      });
    }
  }

  pauseGame() {
    if (this.gameState !== 'playing') return;
    this.gameState = 'paused';
    document.getElementById('pauseScreen').classList.remove('hidden');
    // Sync settings UI to current state.
    const bgmS = document.getElementById('settingBgm');
    if (bgmS) { bgmS.classList.toggle('on', this.bgm.enabled); bgmS.textContent = this.bgm.enabled ? 'ON' : 'OFF'; }
    const sb = document.getElementById('settingSfx');
    if (sb) { sb.classList.toggle('on', this.audio.enabled); sb.textContent = this.audio.enabled ? 'ON' : 'OFF'; }
    const vb = document.getElementById('settingVibrate');
    if (vb) { vb.classList.toggle('on', this.vibrationEnabled); vb.textContent = this.vibrationEnabled ? 'ON' : 'OFF'; }
  }
  resumeGame() {
    if (this.gameState !== 'paused') return;
    this.gameState = 'playing';
    document.getElementById('pauseScreen').classList.add('hidden');
  }

  // Re-render the start-screen panels (used after returning from gameplay).
  _renderStartPanels() {
    this._renderStatsPanel();
    this._renderSkinPicker();
    // Continue button visibility
    const cb = document.getElementById('continueBtn');
    if (!cb) return;
    if (this.loadSave()) cb.classList.remove('hidden');
    else cb.classList.add('hidden');
  }

  setupUI() {
    const continueBtn = document.getElementById('continueBtn');
    const startBtn = document.getElementById('startBtn');
    // Always attach the click handler; visibility is driven separately by
    // _renderStartPanels() so the button works even after returning to the
    // title from an in-progress game.
    if (continueBtn) {
      continueBtn.addEventListener('click', () => {
        const data = this.loadSave();
        if (!data) return;  // No (or invalid) save — silent no-op
        document.getElementById('startScreen').classList.add('hidden');
        this.startGame(data);
      });
    }
    // Show "your record so far" panel + skin picker if any stats exist.
    this._renderStartPanels();
    startBtn.addEventListener('click', () => {
      // Starting fresh — drop the previous save (if any).
      this.clearSave();
      document.getElementById('startScreen').classList.add('hidden');
      this.startGame();
    });
    document.getElementById('playAgainBtn').addEventListener('click', () => {
      this.clearSave();
      document.getElementById('winScreen').classList.add('hidden');
      this.startGame();
    });
  }

  _appendHistoryAndRender(elapsedMs, isNewBest) {
    let history = [];
    try {
      const raw = localStorage.getItem('ant_history');
      if (raw) history = JSON.parse(raw) || [];
    } catch (_) {}
    if (elapsedMs > 0) {
      history.unshift({ ms: elapsedMs, at: Date.now() });
      history = history.slice(0, 5);
      try { localStorage.setItem('ant_history', JSON.stringify(history)); } catch (_) {}
    }
    const fmt = (ms) => {
      if (!ms) return '—';
      const sec = Math.floor(ms / 1000);
      const m = Math.floor(sec / 60), r = sec % 60;
      return `${m}分${String(r).padStart(2, '0')}秒`;
    };
    const panel = document.getElementById('winRecord');
    if (!panel) return;
    const best = (this.stats && this.stats.bestClearMs) || elapsedMs;
    const newBadge = isNewBest ? '<span class="new-badge">✨ NEW!</span>' : '';
    const hist = history.map((h, i) => `<li>${fmt(h.ms)}</li>`).join('');
    panel.innerHTML = `
      <div class="big">⏱ 今回 ${fmt(elapsedMs)} ${newBadge}</div>
      <div>🏆 自己ベスト: ${fmt(best)}</div>
      ${history.length > 0 ? `<div>📜 直近の記録:</div><ol>${hist}</ol>` : ''}
    `;
  }

  _renderSkinPicker() {
    const panel = document.getElementById('skinPicker');
    if (!panel) return;
    // Refresh unlocked set in case stats updated since last visit.
    const unlocked = this._checkSkinUnlocks();
    const active = this._activeSkinId();
    // Only show the picker if there's at least one non-default unlocked skin
    // (no point in showing a single default chip).
    if (unlocked.size <= 1) { panel.classList.add('hidden'); return; }
    panel.classList.remove('hidden');
    let html = '<span class="label">🎨 アリのスキン</span><div class="skins">';
    for (const s of SKIN_DEFS) {
      const has = unlocked.has(s.id);
      const cls = `skin-chip${has ? '' : ' locked'}${active === s.id ? ' active' : ''}`;
      const title = has ? s.label : `${s.label} (${s.requirement})`;
      const inner = `<span style="display:inline-block;width:18px;height:18px;border-radius:50%;background:${s.color};border:2px solid ${s.highlight};"></span>`;
      html += `<button class="${cls}" data-skin="${s.id}" title="${title}">${inner}</button>`;
    }
    html += '</div>';
    panel.innerHTML = html;
    // Wire clicks
    panel.querySelectorAll('.skin-chip').forEach(chip => {
      chip.addEventListener('click', (e) => {
        e.preventDefault();
        const id = chip.getAttribute('data-skin');
        if (chip.classList.contains('locked')) return;
        this._setActiveSkin(id);
        if (this.audio) this.audio.play('tap');
        this._renderSkinPicker();
      });
    });
  }

  _renderStatsPanel() {
    const panel = document.getElementById('statsDisplay');
    if (!panel) return;
    const s = this._loadStatsOnly();
    if (!s) { panel.classList.add('hidden'); return; }
    const fmt = (ms) => {
      if (!ms) return '—';
      const sec = Math.floor(ms / 1000);
      const m = Math.floor(sec / 60), r = sec % 60;
      return `${m}分${String(r).padStart(2, '0')}秒`;
    };
    panel.classList.remove('hidden');
    panel.innerHTML = `
      <h4>📊 これまでの記録</h4>
      <div class="stat-row"><span>累計プレイ時間</span><span>${fmt(s.playTimeMs)}</span></div>
      <div class="stat-row"><span>累計撃破</span><span>${s.kills || 0}</span></div>
      <div class="stat-row"><span>累計運搬</span><span>${s.deposits || 0}</span></div>
      <div class="stat-row"><span>レイド撃退</span><span>${s.raidsWon || 0} / ${(s.raidsWon || 0) + (s.raidsFailed || 0)}</span></div>
      <div class="stat-row"><span>死亡回数</span><span>${s.deaths || 0}</span></div>
      <div class="stat-row"><span>🏆 自己ベスト</span><span>${fmt(s.bestClearMs)}</span></div>
    `;
  }

  // Drop a random power-up near the player as a reward.
  _dropRewardPowerUp() {
    if (!this.player || this.player.dead || !this.powerUps) return;
    const types = Object.keys(POWERUP_DEFS);
    const t = types[Math.floor(Math.random() * types.length)];
    const a = Math.random() * Math.PI * 2;
    const r = 50;
    const x = clamp(this.player.x + Math.cos(a) * r, 30, WORLD_WIDTH - 30);
    const y = clamp(this.player.y + Math.sin(a) * r, 30, WORLD_HEIGHT - 30);
    this.powerUps.push(new PowerUp(x, y, t));
  }

  // ---------- Hints (one-shot) ----------
  _hintOnce(id, text) {
    let seen;
    try { seen = JSON.parse(localStorage.getItem('ant_hints_seen') || '[]'); } catch (_) { seen = []; }
    if (seen.includes(id)) return;
    seen.push(id);
    try { localStorage.setItem('ant_hints_seen', JSON.stringify(seen)); } catch (_) {}
    this.showMessage('💡 ' + text, '', 3500);
  }

  // ---------- Skins ----------
  _activeSkinId() {
    try { return localStorage.getItem('ant_skin_active') || 'default'; } catch (_) { return 'default'; }
  }
  _setActiveSkin(id) {
    try { localStorage.setItem('ant_skin_active', id); } catch (_) {}
    if (this.player) this._applyActiveSkin();
  }
  _applyActiveSkin() {
    if (!this.player) return;
    const id = this._activeSkinId();
    const skin = SKIN_DEFS.find(s => s.id === id) || SKIN_DEFS[0];
    this.player.color = skin.color;
    this.player.bodyHighlight = skin.highlight;
    this.player._skinGlow = !!skin.glow;
  }
  _checkSkinUnlocks() {
    // Look at the persistent stats; show a one-shot toast on newly-unlocked skins.
    const stats = this._loadStatsOnly();
    let unlockedSet;
    try {
      unlockedSet = new Set(JSON.parse(localStorage.getItem('ant_skin_unlocked') || '["default"]'));
    } catch (_) { unlockedSet = new Set(['default']); }
    let newOnes = [];
    for (const s of SKIN_DEFS) {
      if (unlockedSet.has(s.id)) continue;
      if (s.unlock(stats)) {
        unlockedSet.add(s.id);
        newOnes.push(s);
      }
    }
    if (newOnes.length > 0) {
      try { localStorage.setItem('ant_skin_unlocked', JSON.stringify([...unlockedSet])); } catch (_) {}
      newOnes.forEach((s, i) => {
        setTimeout(() => {
          this.showMessage(`🎁 新スキン解放! ${s.label}`, 'success', 3500);
          if (this.audio) this.audio.play('milestone');
        }, i * 1200 + 500);
      });
    }
    return unlockedSet;
  }

  // ---------- Stats / Analytics (local only) ----------
  _freshStats() {
    return {
      playTimeMs: 0,
      kills: 0,
      deposits: 0,
      raidsWon: 0,
      raidsFailed: 0,
      deaths: 0,
      milestones: {},  // { 100: timestampMs, 200: ... }
      bestClearMs: null
    };
  }
  _statBump(key, n = 1) {
    if (!this.stats) return;
    this.stats[key] = (this.stats[key] || 0) + n;
  }
  _statMilestone(level) {
    if (!this.stats) return;
    if (!this.stats.milestones[level]) {
      this.stats.milestones[level] = Math.round(performance.now() - this.stats.runStart);
    }
  }

  // ---------- Milestone celebrations ----------
  _showMilestoneBanner(label) {
    const el = document.getElementById('milestoneBanner');
    if (el) {
      el.textContent = label;
      el.classList.remove('hidden');
      // Restart CSS animation
      el.style.animation = 'none';
      void el.offsetWidth;
      el.style.animation = '';
      setTimeout(() => { el.classList.add('hidden'); }, 1700);
    }
    if (this.audio) this.audio.play('milestone');
    // Bigger particle burst around the player.
    if (this.player && !this.player.dead) {
      for (let i = 0; i < 32; i++) {
        const a = Math.random() * Math.PI * 2;
        const s = rand(1.5, 4.5);
        this.particles.push(new Particle(
          this.player.x + Math.cos(a) * 14,
          this.player.y + Math.sin(a) * 14,
          Math.cos(a) * s, Math.sin(a) * s - 1.5,
          rand(800, 1300), '#ffe680', rand(2.5, 4)
        ));
      }
    }
    this.shakeTimer = 350;
    this.shakeMag = 5;
    // Persist milestone for skin unlock detection.
    this._persistStatsOnly();
    // Check skin unlocks (some are gated on milestones).
    this._checkSkinUnlocks();
  }

  // ---------- Tutorial ----------
  _updateTutorialHint() {
    const hint   = document.getElementById('tutorialHint');
    const text   = document.getElementById('tutorialText');
    const callBtn   = document.getElementById('callBtn');
    const attackBtn = document.getElementById('attackBtn');
    if (!hint || !text) return;
    callBtn   && callBtn.classList.remove('tutorial-pulse');
    attackBtn && attackBtn.classList.remove('tutorial-pulse');
    if (!this.tutorialStep) {
      hint.classList.add('hidden');
      return;
    }
    hint.classList.remove('hidden');
    if (this.tutorialStep === 1) {
      text.textContent = '① 🌾 餌に近づいて巣に運ぼう';
    } else if (this.tutorialStep === 2) {
      text.textContent = '② 👥 「呼ぶ」ボタンで仲間を集めよう';
      callBtn && callBtn.classList.add('tutorial-pulse');
    } else if (this.tutorialStep === 3) {
      text.textContent = '③ ⚔️ 「攻撃」ボタンで敵を倒そう';
      attackBtn && attackBtn.classList.add('tutorial-pulse');
    }
  }

  _advanceTutorial(trigger) {
    if (!this.tutorialStep) return;
    if (trigger === 'deposit' && this.tutorialStep === 1) this.tutorialStep = 2;
    else if (trigger === 'call' && this.tutorialStep === 2) this.tutorialStep = 3;
    else if (trigger === 'kill' && this.tutorialStep === 3) {
      this.tutorialStep = 0;
      try { localStorage.setItem('ant_tutorial_done', 'true'); } catch (_) {}
      this.showMessage('🎉 チュートリアル完了！コロニーを大きく育てよう', 'success', 3000);
    } else {
      return;  // no advancement
    }
    this._updateTutorialHint();
  }

  // ---------- Save / Load ----------
  saveGame() {
    if (!this.player || this.gameState !== 'playing') return;
    try {
      const save = {
        v: 2,
        friendCount: this.friends.filter(f => !f.dead).length,
        expansionStage: this.expansionStage,
        unlockedBiomes: [...this.unlockedBiomes],
        zones: this.zones.map(z => ({ x0: z.x0, y0: z.y0, x1: z.x1, y1: z.y1, biome: z.biome })),
        playerHp: Math.round(this.player.hp),
        colonyLevel: this.colonyLevel,
        nestLevel: this.nestLevel,
        milestonesShown: this._milestoneShown ? [...this._milestoneShown] : [],
        time: Date.now(),
        stats: this.stats ? this._statsForSave() : null
      };
      localStorage.setItem('ant_save', JSON.stringify(save));
      this._persistStatsOnly();
    } catch (_) { /* private mode etc — fail silently */ }
  }
  _statsForSave() {
    // Drop the runtime-only field
    const s = Object.assign({}, this.stats);
    delete s.runStart;
    return s;
  }
  _persistStatsOnly() {
    try {
      if (!this.stats) return;
      localStorage.setItem('ant_stats', JSON.stringify(this._statsForSave()));
    } catch (_) {}
  }
  _loadStatsOnly() {
    try {
      const raw = localStorage.getItem('ant_stats');
      if (!raw) return null;
      return JSON.parse(raw);
    } catch (_) { return null; }
  }
  loadSave() {
    try {
      const raw = localStorage.getItem('ant_save');
      if (!raw) return null;
      const data = JSON.parse(raw);
      if (!data || data.v !== 2) return null;
      // Quick sanity check
      if (typeof data.friendCount !== 'number' || !Array.isArray(data.zones)) return null;
      return data;
    } catch (_) { return null; }
  }
  clearSave() {
    try { localStorage.removeItem('ant_save'); } catch (_) {}
  }

  // ---------- Player Actions ----------
  playerAttack() {
    if (!this.player || this.player.dead) return;
    if (this.player.attackCooldown > 0) return;
    this.player.attackCooldown = ATTACK_COOLDOWN;

    // Find closest enemy in range
    let closest = null, cd = ATTACK_RANGE;
    this.enemies.forEach(e => {
      if (e.dead) return;
      const d = dist(this.player, e);
      if (d < cd) {
        cd = d;
        closest = e;
      }
    });

    if (closest) {
      const wasAlive = !closest.dead;
      // Strong-mouth doubles damage; Giant adds another 2.5x for a smashing feel.
      let dmg = this.player.attackPower;
      if (this.activePowerUp === 'strong') dmg *= 2;
      if (this.activePowerUp === 'giant')  dmg = Math.round(dmg * 2.5);
      closest.takeDamage(Math.round(dmg), this, this.player);
      if (this.audio) this.audio.play('hit');
      if (wasAlive && closest.dead) {
        this._advanceTutorial('kill');
        this._statBump('kills');
        if (this.audio) this.audio.play('kill');
      }
      this.spawnHitEffect(closest.x, closest.y);
      // Mark player as 'attacking-active' so friends join
      this.player.state = 'attacking-active';
      this.player.target = closest;
      // Friends in follow state attack too
      this.friends.forEach(f => {
        if (!f.dead && f.state === 'follow' && dist(f, closest) < 200) {
          f.state = 'attacking';
          f.target = closest;
        }
      });
      // Brief visual feedback
      setTimeout(() => {
        if (this.player.target === closest && (closest.dead || dist(this.player, closest) > 250)) {
          this.player.state = 'player';
          this.player.target = null;
        }
      }, 1500);
    } else {
      // No enemy nearby — try to interact with food
      this.tryPickupNearbyFood();
    }
  }

  tryPickupNearbyFood() {
    if (this.player.carrying) return;
    let closest = null, cd = 35;
    this.foods.forEach(f => {
      if (f.deposited || f.beingCarried) return;
      const d = dist(this.player, f);
      if (d < cd) {
        cd = d;
        closest = f;
      }
    });
    if (closest) {
      this.attemptPickup(closest);
    }
  }

  playerCallFriends() {
    if (!this.player || this.player.dead) return;

    // Pick the closest callable friends so the response feels responsive even
    // in late game when the colony has hundreds of ants scattered around.
    const MAX_NEW_CALLS = this.maxCallSize || 12;
    const candidates = this.friends
      .filter(f => !f.dead && f.state !== 'carrying')
      .map(f => ({ f, d: dist(f, this.player) }))
      .sort((a, b) => a.d - b.d);

    let switched = 0;   // ants newly pulled into follow
    let refreshed = 0;  // ants already following (timer refreshed, no cap cost)
    for (const { f } of candidates) {
      const wasFollowing = f.state === 'follow';
      if (!wasFollowing && switched >= MAX_NEW_CALLS) continue;

      f.state = 'follow';
      f.target = null;
      f.callTimer = 12000;
      if (wasFollowing) refreshed++;
      else switched++;
    }

    const total = switched + refreshed;
    if (total > 0) {
      this.spawnCallEffect();
      this._advanceTutorial('call');
      // Mark a "call window" so spawns intensify during the suspenseful wait.
      this.callStress = 1;
      if (switched > 0) {
        this.showMessage(`仲間 ${switched}匹を呼んだ！`, 'success', 1200);
      } else {
        this.showMessage(`仲間 ${total}匹が追従中`, 'success', 1100);
      }
    } else {
      this.showMessage('呼べる仲間がいない…', 'warn', 1200);
    }
  }

  attemptPickup(food) {
    if (food.beingCarried || food.deposited) return false;

    if (food.required === 1) {
      // Small food: prefer player if very close, else any nearby follow friend
      if (!this.player.dead && !this.player.carrying && dist(this.player, food) < 28) {
        food.carriers = [this.player];
        food.beingCarried = true;
        this.player.carrying = food;
        this.showMessage('餌をゲット！', 'success', 1100);
        return true;
      }
      // Followers OR idle foragers (idle ants outside the nest) can pick up.
      const nearbyFriend = this.friends.find(f =>
        !f.dead && dist(f, food) < 38 &&
        (f.state === 'follow' ||
         (f.state === 'idle' && !inNest(f.x, f.y)))
      );
      if (nearbyFriend) {
        food.carriers = [nearbyFriend];
        food.beingCarried = true;
        nearbyFriend.state = 'carrying';
        nearbyFriend.carrying = food;
        return true;
      }
      return false;
    }

    // Big food: friends-only carry (player keeps free to fight/scout)
    const nearby = this.friends.filter(f =>
      !f.dead &&
      f.state === 'follow' &&
      dist(f, food) < 65
    );
    if (nearby.length >= food.required) {
      const helpers = nearby.slice(0, food.required);
      food.carriers = [...helpers];
      food.beingCarried = true;
      helpers.forEach(h => {
        h.state = 'carrying';
        h.carrying = food;
      });
      this.showMessage(`よいしょ！ 仲間${helpers.length}匹で運ぶ`, 'success', 1500);
      return true;
    }

    // Not enough — throttled hint when player nearby
    if (!this.player.carrying && dist(this.player, food) < 70) {
      const now = performance.now();
      if (!food._lastWarnTime || now - food._lastWarnTime > 2500) {
        food._lastWarnTime = now;
        const stillNeed = food.required - nearby.length;
        const totalAlive = this.friends.filter(f => !f.dead).length;
        if (totalAlive < stillNeed) {
          this.showMessage(`仲間${food.required}匹必要！もっと増やそう`, 'warn', 2200);
        } else {
          this.showMessage(`「仲間呼ぶ」で集めて来よう (あと${stillNeed}匹)`, 'warn', 2200);
        }
      }
    }
    return false;
  }

  // ---------- Spawning ----------
  // Initial foods placed at the start of a fresh game: 3 small (1-carrier)
  // pieces fanned across the north hemisphere of the nest at close range,
  // so the player has obvious nearby targets without clutter.
  spawnInitialFoods() {
    const placements = [
      { angleFrac: 0.20, r: NEST_RADIUS_BASE + 95  },
      { angleFrac: 0.50, r: NEST_RADIUS_BASE + 110 },
      { angleFrac: 0.80, r: NEST_RADIUS_BASE + 95  }
    ];
    for (const p of placements) {
      const a = Math.PI + p.angleFrac * Math.PI + rand(-0.08, 0.08);
      const r = p.r + rand(-15, 15);
      const x = clamp(NEST_X + Math.cos(a) * r, 60, WORLD_WIDTH - 60);
      const y = clamp(NEST_Y + Math.sin(a) * r, 60, NEST_Y - NEST_RADIUS_BASE - 60);
      const f = new Food(x, y, 'small');
      f.eggBonus = this.terrain
        ? (FOOD_TERRAIN_EGG_BONUS[this.terrain.getAt(x, y)] || 1.0)
        : 1.0;
      this.foods.push(f);
    }
  }

  spawnFood() {
    // Late-game allows more concurrent foods on the field.
    const cap = MAX_FOODS + Math.min(12, Math.floor(this.friends.length / 80));
    if (this.foods.filter(f => !f.deposited).length >= cap) return;

    // Per-terrain spawn weight & sampling. Higher = more likely to keep this candidate.
    const FOOD_TERRAIN_WEIGHT = {
      grass: 1.0, pond: 0, sand: 0.6, mud: 0.4, flower: 2.5, leaves: 1.2, concrete: 0.5
    };

    // Early stages keep food close to the nest so the player can find easy
    // wins right away. The radius grows as new zones unlock around the nest.
    const _stage = this.expansionStage;
    const maxFromNest = _stage === 0 ? 380 : Infinity;

    // Bias zone pick toward zones with FEWER current foods so newly opened
    // areas refill over time as the player carries food back to the nest.
    const zonePicker = this._weightedZonePicker('food');

    // Find a candidate position weighted by terrain. Reject pond cells and
    // anything that's still rock (outside an unlocked zone).
    let x = 0, y = 0, terrainHere = 'grass', accepted = false;
    let bestX = 0, bestY = 0, bestTerrain = 'grass', haveBest = false;
    for (let attempt = 0; attempt < 18; attempt++) {
      // Sample inside one of the unlocked zones to guarantee a walkable tile.
      const zone = zonePicker();
      x = rand(zone.x0 + 30, zone.x1 - 30);
      y = rand(zone.y0 + 30, zone.y1 - 30);
      const dn = Math.hypot(x - NEST_X, y - NEST_Y);
      if (dn < NEST_RADIUS_BASE + 80) continue;
      if (dn > maxFromNest) continue;
      terrainHere = this.terrain ? this.terrain.getAt(x, y) : 'grass';
      if (terrainHere === 'rock') continue;
      const w = FOOD_TERRAIN_WEIGHT[terrainHere] ?? 1.0;
      if (w <= 0) continue;
      if (!haveBest) { bestX = x; bestY = y; bestTerrain = terrainHere; haveBest = true; }
      // accept-reject: higher weight = more likely to accept (vs. retrying)
      if (Math.random() < Math.min(1, w / 2.5)) { accepted = true; break; }
    }
    if (!accepted) {
      if (!haveBest) return;
      x = bestX; y = bestY; terrainHere = bestTerrain;
    }

    // Food types unlock with biome stages — each new area introduces a new
    // species so the carry-targets stay visually fresh:
    //   stage 0 → small + medium
    //   stage 1 → + acorn  (mud)     2-carrier nut
    //   stage 2 → + large  (pond)
    //   stage 3 → + berry  (flower)  4-carrier sweet
    //   stage 4 → + huge   (leaves)
    //   stage 5+→ + giant  (sand+)
    const stage = this.expansionStage;
    const pool = ['small', 'medium'];
    if (stage >= 1) pool.push('acorn');
    if (stage >= 2) pool.push('large');
    if (stage >= 3) pool.push('berry');
    if (stage >= 4) pool.push('huge');
    if (stage >= 5) pool.push('giant');
    let type;
    if (Math.random() < 0.35 && pool.length > 2) {
      // Bias toward latest 2 unlocks so new areas show off the new food.
      type = pickRand(pool.slice(Math.max(2, pool.length - 2)));
    } else {
      // Weighted toward smaller foods so the field doesn't get too clogged.
      const r = Math.random();
      if      (r < 0.35) type = 'small';
      else if (r < 0.65) type = pool.indexOf('medium') >= 0 ? 'medium' : 'small';
      else               type = pickRand(pool);
    }

    // Terrain bias: shift type distribution. Skip biases that would pick a
    // not-yet-unlocked food type.
    const canHuge  = stage >= 2;
    const canGiant = stage >= 3;
    if (terrainHere === 'sand') {
      if (type === 'large' || type === 'huge' || type === 'giant') {
        if (Math.random() < 0.5) type = 'medium';
      }
    } else if (terrainHere === 'mud') {
      if (Math.random() < 0.5) type = 'small';
    } else if (terrainHere === 'flower') {
      if (type === 'small' && Math.random() < 0.6) type = 'medium';
      else if (type === 'medium' && stage >= 1 && Math.random() < 0.3) type = 'large';
    } else if (terrainHere === 'leaves') {
      if (type === 'small' && Math.random() < 0.4) type = 'medium';
    } else if (terrainHere === 'concrete') {
      if (Math.random() < 0.25) {
        if (canGiant) type = Math.random() < 0.5 ? 'huge' : 'giant';
        else if (canHuge) type = 'huge';
      }
    }

    // Honey jar: rare drop on harsh terrain (mud/pond/concrete) starting from
    // stage 2 (pond unlocked). Only one honey on the field at once.
    const isHarsh = (terrainHere === 'mud' || terrainHere === 'pond' || terrainHere === 'concrete');
    const honeyOnField = this.foods.some(f => !f.deposited && f.type === 'honey');
    if (isHarsh && stage >= 2 && !honeyOnField && Math.random() < 0.04) {
      type = 'honey';
      // Announce the rare find
      this.showMessage('🍯 珍しい餌が現れた! でも危険…', 'success', 3000);
      this._hintOnce('food_honey', 'ハチミツの壺は卵+20! でもハチが守っている');
      // Honey attracts wasps when pond is unlocked: spawn 1-2 nearby
      if (this.unlockedBiomes.has('pond')) {
        const guards = 1 + (Math.random() < 0.5 ? 1 : 0);
        for (let g = 0; g < guards; g++) {
          if (this.enemies.filter(e => !e.dead).length >= this.getMaxEnemies()) break;
          const a = Math.random() * Math.PI * 2;
          const r = rand(60, 100);
          const ex = clamp(x + Math.cos(a) * r, 30, WORLD_WIDTH - 30);
          const ey = clamp(y + Math.sin(a) * r, 30, NEST_Y - NEST_RADIUS_BASE - 30);
          this.enemies.push(new Enemy(ex, ey, 'wasp', 1.0));
        }
      }
    }

    const newFood = new Food(x, y, type);
    newFood.eggBonus = FOOD_TERRAIN_EGG_BONUS[terrainHere] || 1.0;
    this.foods.push(newFood);
  }

  getMaxEnemies() {
    const totalAnts = 1 + this.friends.filter(f => !f.dead).length;
    // Cap grows from 7 → 22 over 0 → 1000 ants.
    return Math.min(22, MAX_ENEMIES + Math.floor(totalAnts / 65));
  }

  spawnEnemy() {
    if (this.enemies.filter(e => !e.dead).length >= this.getMaxEnemies()) return;

    // Bias zone pick toward zones with fewer current enemies so newly
    // opened areas always have enemies appear over time.
    const zonePicker = this._weightedZonePicker('enemy');

    let x = 0, y = 0, terrainHere = 'grass', accepted = false;
    let bestX = 0, bestY = 0, bestTerrain = 'grass', haveBest = false;
    for (let attempt = 0; attempt < 18; attempt++) {
      // Sample inside one of the unlocked zones (preferring zone edges for
      // that "appearing from the wilderness" feel).
      const zone = zonePicker();
      const edgeBias = Math.random() < 0.6;
      if (edgeBias) {
        const side = Math.floor(Math.random() * 4);
        if      (side === 0) { x = rand(zone.x0 + 30, zone.x1 - 30); y = rand(zone.y0 + 30, zone.y0 + 100); }
        else if (side === 1) { x = rand(zone.x0 + 30, zone.x1 - 30); y = rand(zone.y1 - 100, zone.y1 - 30); }
        else if (side === 2) { x = rand(zone.x0 + 30, zone.x0 + 100); y = rand(zone.y0 + 30, zone.y1 - 30); }
        else                 { x = rand(zone.x1 - 100, zone.x1 - 30); y = rand(zone.y0 + 30, zone.y1 - 30); }
      } else {
        x = rand(zone.x0 + 30, zone.x1 - 30);
        y = rand(zone.y0 + 30, zone.y1 - 30);
      }
      if (Math.hypot(x - NEST_X, y - NEST_Y) < NEST_RADIUS_BASE + 100) continue;
      if (this.player && dist({ x, y }, this.player) < 200) continue;
      terrainHere = this.terrain ? this.terrain.getAt(x, y) : 'grass';
      if (terrainHere === 'rock') continue;
      const cfg = ENEMY_TERRAIN[terrainHere] || ENEMY_TERRAIN.grass;
      if (cfg.weight <= 0) continue;
      if (!haveBest) { bestX = x; bestY = y; bestTerrain = terrainHere; haveBest = true; }
      // weighted accept: relative to max weight (1.5)
      if (Math.random() < cfg.weight / 1.5) { accepted = true; break; }
    }
    if (!accepted) {
      if (!haveBest) return;
      x = bestX; y = bestY; terrainHere = bestTerrain;
    }

    const cfg = ENEMY_TERRAIN[terrainHere] || ENEMY_TERRAIN.grass;

    // Type unlocks tied to biome unlocks. Each new biome introduces a new
    // enemy species, keeping each area visually fresh.
    //   mud      → beetle
    //   pond     → wasp
    //   flower   → hornet (red wasp variant)
    //   leaves   → slug   (slow tank)
    //   sand     → scorpion (charger v2)
    const has = (b) => this.unlockedBiomes.has(b);
    const pool = ['spider'];
    if (has('mud'))    pool.push('beetle');
    if (has('pond'))   pool.push('wasp');
    if (has('flower')) pool.push('hornet');
    if (has('leaves')) pool.push('slug');
    if (has('sand'))   pool.push('scorpion');
    let type;
    // Bias the most-recently-unlocked types so they actually show up more
    // when an area is fresh, then settle into uniform later.
    if (Math.random() < 0.40 && pool.length > 1) {
      // Pick from the latest 2 unlocks
      const tail = pool.slice(Math.max(1, pool.length - 2));
      type = pickRand(tail);
    } else {
      type = pickRand(pool);
    }

    // Apply terrain bias only if the biased type is actually unlocked.
    if (cfg.bias && Math.random() < 0.4 && pool.indexOf(cfg.bias) !== -1) {
      type = cfg.bias;
    }

    this.enemies.push(new Enemy(x, y, type, cfg.scale));
    if (type === 'beetle')   this._hintOnce('enemy_beetle',   'カブトムシ: 突進攻撃! 横にステップで避けよう');
    if (type === 'wasp')     this._hintOnce('enemy_wasp',     'ハチ: 速くて空を飛ぶ. 近づいてきた瞬間に攻撃');
    if (type === 'hornet')   this._hintOnce('enemy_hornet',   'スズメバチ: ハチより速く強い! 注意');
    if (type === 'slug')     this._hintOnce('enemy_slug',     'ナメクジ: 遅いがタフ. 数で囲もう');
    if (type === 'scorpion') this._hintOnce('enemy_scorpion', 'サソリ: 突進攻撃あり! 高耐久');
  }

  // Carry-time ambush spawn: place an enemy at a random angle from (cx, cy),
  // 90-160px away, outside the nest. Uses normal spawnEnemy logic for type
  // selection by calling spawnEnemy() against a temporarily-set bias point.
  _spawnAmbushNear(cx, cy) {
    let x = 0, y = 0, ok = false;
    for (let i = 0; i < 12; i++) {
      const a = Math.random() * Math.PI * 2;
      const r = rand(90, 160);
      x = clamp(cx + Math.cos(a) * r, 30, WORLD_WIDTH - 30);
      y = clamp(cy + Math.sin(a) * r, 30, WORLD_HEIGHT - 30);
      if (Math.hypot(x - NEST_X, y - NEST_Y) < NEST_RADIUS_BASE + 60) continue;
      if (this.terrain && this.terrain.getAt(x, y) === 'rock') continue;
      ok = true; break;
    }
    if (!ok) return;
    const terrainHere = this.terrain ? this.terrain.getAt(x, y) : 'grass';
    // Type follows biome unlock rules (mirrors spawnEnemy)
    const hasMud = this.unlockedBiomes.has('mud');
    const hasPond = this.unlockedBiomes.has('pond');
    const r = Math.random();
    let type;
    if (!hasMud && !hasPond) type = 'spider';
    else if (hasMud && !hasPond) type = r < 0.65 ? 'spider' : 'beetle';
    else if (!hasMud && hasPond) type = r < 0.65 ? 'spider' : 'wasp';
    else type = r < 0.45 ? 'spider' : r < 0.75 ? 'wasp' : 'beetle';
    // Use the terrain's power scale so harsh-terrain ambushes still feel right
    const cfg = ENEMY_TERRAIN[terrainHere] || ENEMY_TERRAIN.grass;
    this.enemies.push(new Enemy(x, y, type, cfg.scale || 1.0));
  }

  // Returns a closure that picks a zone weighted inversely by how populated
  // the zone already is. `kind` selects whether food or enemy populations
  // are counted. The closure caches per-zone counts at construction time.
  _weightedZonePicker(kind) {
    const counts = this.zones.map(z => {
      let count = 0;
      if (kind === 'food') {
        for (const f of this.foods) {
          if (f.deposited || f.beingCarried) continue;
          if (f.x >= z.x0 && f.x <= z.x1 && f.y >= z.y0 && f.y <= z.y1) count++;
        }
      } else {
        for (const e of this.enemies) {
          if (e.dead) continue;
          if (e.x >= z.x0 && e.x <= z.x1 && e.y >= z.y0 && e.y <= z.y1) count++;
        }
      }
      return count;
    });
    // weight = 1 / (count + 1) — empty zones get strong preference, but
    // populated zones still have nonzero chance.
    const weights = counts.map(c => 1 / (c + 1));
    const total = weights.reduce((s, w) => s + w, 0);
    return () => {
      let r = Math.random() * total;
      for (let i = 0; i < this.zones.length; i++) {
        r -= weights[i];
        if (r <= 0) return this.zones[i];
      }
      return this.zones[this.zones.length - 1];
    };
  }

  // True if (x, y) is on a tile a ground unit can stand on. Rock blocks both
  // movement and spawning. Used by spawn validators and Ant/Enemy movement.
  isWalkableAt(x, y) {
    if (!this.terrain) return true;
    const t = this.terrain.getAt(x, y);
    const def = TERRAIN_DEFS[t];
    return !def || def.walkable !== false;
  }

  // Reward for defeating an enemy: drop a small food where it died.
  // Stronger / boss-empowered enemies drop a medium food instead so the kill
  // feels meaningfully rewarding.
  dropFoodOnEnemyDeath(enemy) {
    // Tutorial step 3 advances on ANY enemy death, not only player kills.
    // Friends often finish enemies before the player can land the killing
    // blow, so requiring a player kill leaves the hint stuck on screen.
    if (this._advanceTutorial) this._advanceTutorial('kill');
    const x = clamp(enemy.x, 30, WORLD_WIDTH - 30);
    const y = clamp(enemy.y, 30, NEST_Y - NEST_RADIUS_BASE - 30);
    // Skip if drop would land in nest (raiders dying inside the nest)
    if (inNest(x, y)) return;
    const isStrong = enemy.powerScale && enemy.powerScale > 1.1;
    const stage = this.expansionStage;
    let type = 'small';
    if (isStrong && stage >= 1) type = 'medium';
    const f = new Food(x, y, type);
    f.eggBonus = this.terrain
      ? (FOOD_TERRAIN_EGG_BONUS[this.terrain.getAt(x, y)] || 1.0)
      : 1.0;
    this.foods.push(f);
  }

  spawnHealItem() {
    if (this.healItems.length >= 2) return;
    let x = 0, y = 0, ok = false;
    for (let attempt = 0; attempt < 14; attempt++) {
      const zone = pickRand(this.zones);
      x = rand(zone.x0 + 60, zone.x1 - 60);
      y = rand(zone.y0 + 60, zone.y1 - 60);
      if (Math.hypot(x - NEST_X, y - NEST_Y) < NEST_RADIUS_BASE + 100) continue;
      if (this.terrain && this.terrain.getAt(x, y) === 'rock') continue;
      ok = true; break;
    }
    if (!ok) return;
    this.healItems.push(new HealItem(x, y));
  }

  // ---------- Effects ----------
  spawnHitEffect(x, y) {
    for (let i = 0; i < 6; i++) {
      const a = Math.random() * Math.PI * 2;
      const s = rand(2, 5);
      this.particles.push(new Particle(x, y, Math.cos(a) * s, Math.sin(a) * s, rand(300, 500), '#ffaa44', rand(2, 3.5)));
    }
  }
  spawnEnemyDeath(x, y, intensity = 1) {
    const count = Math.floor(14 * intensity);
    for (let i = 0; i < count; i++) {
      const a = Math.random() * Math.PI * 2;
      const s = rand(2, 6) * (intensity > 1 ? 1.2 : 1);
      this.particles.push(new Particle(x, y, Math.cos(a) * s, Math.sin(a) * s, rand(500, 900), '#7a307a', rand(2, 4)));
    }
  }
  spawnDepositEffect(x, y) {
    for (let i = 0; i < 18; i++) {
      const a = Math.random() * Math.PI * 2;
      const s = rand(1, 4);
      this.particles.push(new Particle(x, y, Math.cos(a) * s, Math.sin(a) * s - 2, rand(600, 1200), '#fff8d0', rand(2, 4)));
    }
  }
  spawnHatchEffect(x, y) {
    for (let i = 0; i < 12; i++) {
      const a = Math.random() * Math.PI * 2;
      const s = rand(1, 3);
      this.particles.push(new Particle(x, y, Math.cos(a) * s, Math.sin(a) * s - 1, rand(400, 800), '#ffe680', rand(2, 3)));
    }
  }
  spawnHealEffect(x, y) {
    for (let i = 0; i < 16; i++) {
      const a = Math.random() * Math.PI * 2;
      const s = rand(1, 3);
      this.particles.push(new Particle(x, y, Math.cos(a) * s, Math.sin(a) * s - 1.5, rand(500, 900), '#ff99bb', rand(2, 4)));
    }
    // upward sparkles
    for (let i = 0; i < 8; i++) {
      this.particles.push(new Particle(
        x + rand(-10, 10), y + rand(-6, 6),
        rand(-0.5, 0.5), rand(-3, -1.5),
        rand(700, 1100), '#ffffff', rand(1.5, 2.5)
      ));
    }
  }
  spawnCallEffect() {
    for (let i = 0; i < 10; i++) {
      const a = Math.random() * Math.PI * 2;
      const r = 30 + Math.random() * 10;
      const s = 2;
      this.particles.push(new Particle(
        this.player.x + Math.cos(a) * r,
        this.player.y + Math.sin(a) * r,
        Math.cos(a) * s, Math.sin(a) * s,
        500, '#ffe680', 3
      ));
    }
  }
  spawnDamageNumber(x, y, val, color) {
    this.damageNumbers.push(new DamageNumber(x + rand(-5, 5), y, val, color));
  }

  // ---------- Death/Win Handling ----------
  onAntDeath(ant) {
    if (ant.isPlayer) {
      // Drop food if carrying
      if (ant.carrying) {
        ant.carrying.dropFood(this);
      }
      this.gameState = 'dead';
      this.respawnTimer = 3000;
      this._statBump('deaths');
      if (this.audio) this.audio.play('death');
      document.getElementById('deathScreen').classList.remove('hidden');
    } else {
      // Friend died — drop food if any
      if (ant.carrying) {
        ant.carrying.carriers = ant.carrying.carriers.filter(c => c !== ant);
        if (ant.carrying.carriers.length < ant.carrying.required) {
          ant.carrying.dropFood(this);
        }
      }
      this.spawnEnemyDeath(ant.x, ant.y); // sad death effect
      // Alert nearby friends (propagation): wake idle defenders to fight back.
      this.alertNearbyFriends(ant.x, ant.y, 90, ant.target && !ant.target.dead ? ant.target : null);
    }
  }

  respawnPlayer() {
    this.player.x = NEST_X;
    this.player.y = NEST_Y;
    this.player.hp = this.player.maxHp;
    this.player.dead = false;
    this.player.invuln = 2200;  // a touch longer so the flash is clearly visible
    this.player.state = 'player';
    this.gameState = 'playing';
    document.getElementById('deathScreen').classList.add('hidden');
    this.showMessage('💪 復活！', 'success', 1800);
    if (this.audio) this.audio.play('respawn');
    // Burst of golden particles around the spawn point.
    for (let i = 0; i < 28; i++) {
      const a = Math.random() * Math.PI * 2;
      const s = rand(1.5, 4);
      this.particles.push(new Particle(
        NEST_X + Math.cos(a) * 8,
        NEST_Y + Math.sin(a) * 8,
        Math.cos(a) * s, Math.sin(a) * s - 1,
        rand(700, 1100), '#ffe680', rand(2, 3.5)
      ));
    }
    this.saveGame();
  }

  showMessage(text, type = '', duration = 2500) {
    const area = document.getElementById('messageArea');
    const div = document.createElement('div');
    div.className = 'message' + (type ? ' ' + type : '');
    div.textContent = text;
    area.appendChild(div);
    setTimeout(() => {
      if (div.parentNode) div.parentNode.removeChild(div);
    }, duration);
  }

  findClosestEnemy(x, y, range) {
    let closest = null, cd = range;
    this.enemies.forEach(e => {
      if (e.dead) return;
      const d = Math.hypot(e.x - x, e.y - y);
      if (d < cd) { cd = d; closest = e; }
    });
    return closest;
  }

  // ---------- Update ----------
  update(dt) {
    if (this.gameState === 'dead') {
      this.respawnTimer -= dt;
      const sec = Math.ceil(this.respawnTimer / 1000);
      document.getElementById('respawnText').textContent = sec > 0 ? sec : 1;
      if (this.respawnTimer <= 0) {
        this.respawnPlayer();
      }
      return;
    }
    if (this.gameState !== 'playing') return;

    // Update terrain animations (water ripples etc)
    if (this.terrain) this.terrain.tickAnim(dt);

    // Update entities. LOD: idle ants wandering in the nest while off-screen
    // get their update skipped — they aren't doing anything player-visible
    // and skipping ~hundreds of them per frame keeps late-game smooth.
    this.player.update(dt, this);
    const lodLeft   = this.camera.x - 80;
    const lodTop    = this.camera.y - 80;
    const lodRight  = this.camera.x + this.viewW + 80;
    const lodBottom = this.camera.y + this.viewH + 80;
    const offscreen = (e) =>
      e.x < lodLeft || e.x > lodRight || e.y < lodTop || e.y > lodBottom;

    // Assign formation slots to following friends so they line up in a 2-column
    // queue behind the player (real-ant marching feel).
    let _slot = 0;
    for (const f of this.friends) {
      if (f.dead) continue;
      if (f.state === 'follow') f._followSlot = _slot++;
      else f._followSlot = -1;
    }

    // Throttle (not skip) updates for idle ants in the nest while off-screen.
    // We still need them to occasionally cycle wander logic so they can become
    // foragers and pick up food in newly opened areas while the player is
    // exploring elsewhere.
    this._idleTickPhase = ((this._idleTickPhase || 0) + 1) % 4;
    this.friends.forEach((f, idx) => {
      if (f.dead) return;
      if (f.state === 'idle' && inNest(f.x, f.y) && offscreen(f)) {
        if ((idx + this._idleTickPhase) % 4 !== 0) return;  // ~15fps for these
      }
      f.update(dt, this);
    });
    this.enemies.forEach(e => {
      if (e.dead) return;
      // Skip enemies that have no target and are off-screen and far from any
      // friend/player (no one can see or be hit by them yet).
      if (!e.target && offscreen(e) && dist(e, this.player) > 300) return;
      e.update(dt, this);
    });
    this.foods.forEach(f => f.update(dt, this));
    this.eggs.forEach(eg => eg.update(dt));
    this.healItems.forEach(h => h.update(dt));
    if (this.powerUps) this.powerUps.forEach(p => p.update(dt));

    // Pheromone trail: sample player + a few moving friends every 200ms,
    // and fade existing points. Capped at 200 points for performance.
    this._trailAcc += dt;
    if (this._trailAcc >= 200) {
      this._trailAcc = 0;
      const pushPt = (x, y, life = 3500) => {
        if (this.trailPoints.length >= 200) this.trailPoints.shift();
        this.trailPoints.push({ x, y, life, maxLife: life });
      };
      if (this.player && !this.player.dead && this.player._moving && !inNest(this.player.x, this.player.y)) {
        pushPt(this.player.x, this.player.y, 4500);
      }
      // Sample only a few friends to avoid trail spam.
      let sampled = 0;
      for (const f of this.friends) {
        if (sampled >= 5) break;
        if (f.dead || !f._moving || inNest(f.x, f.y)) continue;
        pushPt(f.x, f.y, 2500);
        sampled++;
      }
    }
    for (const p of this.trailPoints) p.life -= dt;
    this.trailPoints = this.trailPoints.filter(p => p.life > 0);
    this.particles.forEach(p => p.update(dt));
    this.damageNumbers.forEach(d => d.update(dt));

    // Try pickup for every uncarried food (player or friends, friends-only for big food)
    this.foods.forEach(f => {
      if (!f.deposited && !f.beingCarried) {
        // Hint flags on first contact
        if (!this.player.dead && dist(this.player, f) < this.player.size + f.size - 2) {
          if (!this.firstFoodSeen) {
            this.firstFoodSeen = true;
          }
          if (f.required > 1 && !this.firstBigFoodSeen) {
            this.firstBigFoodSeen = true;
            this.showMessage('大きい餌は仲間を呼んで運んでもらおう', '', 3500);
          }
        }
        this.attemptPickup(f);
      }
    });

    // Heal item collision
    this.healItems.forEach(item => {
      if (item.collected) return;
      if (!this.player.dead && dist(this.player, item) < this.player.size + item.size - 2) {
        item.collected = true;
        const oldHp = this.player.hp;
        this.player.hp = Math.min(this.player.maxHp, this.player.hp + item.healAmount);
        const healed = this.player.hp - oldHp;
        // Also half-heal nearby friends
        let friendsHealed = 0;
        this.friends.forEach(f => {
          if (!f.dead && f.hp < f.maxHp && dist(f, this.player) < 90) {
            f.hp = Math.min(f.maxHp, f.hp + Math.floor(item.healAmount * 0.6));
            friendsHealed++;
          }
        });
        this.spawnHealEffect(item.x, item.y);
        if (this.audio) this.audio.play('heal');
        const friendsTxt = friendsHealed > 0 ? ` 仲間${friendsHealed}匹も回復` : '';
        this.showMessage(`💖 HP +${healed}!${friendsTxt}`, 'success', 1800);
      }
    });

    // Power-up pickup + active timer.
    if (this.powerUps) {
      this.powerUps.forEach(pu => {
        if (pu.collected) return;
        if (!this.player.dead && dist(this.player, pu) < this.player.size + pu.size - 2) {
          pu.collected = true;
          this.activePowerUp = pu.type;
          const def = POWERUP_DEFS[pu.type];
          this.activePowerUpTimer = def.durationMs;
          this.showMessage(`✨ ${def.icon} ${def.label} 発動!`, 'success', 1800);
          if (this.audio) this.audio.play('powerup');
          // Sparkles
          for (let i = 0; i < 14; i++) {
            const a = Math.random() * Math.PI * 2;
            this.particles.push(new Particle(
              pu.x, pu.y, Math.cos(a) * 2.5, Math.sin(a) * 2.5 - 1,
              700, '#ffe680', 2.5
            ));
          }
        }
      });
    }
    if (this.activePowerUp) {
      this.activePowerUpTimer -= dt;
      if (this.activePowerUpTimer <= 0) {
        this.activePowerUp = null;
        this.activePowerUpTimer = 0;
        this.showMessage('効果が切れた', '', 1200);
      }
    }

    // Player deposit when entering egg room while carrying
    if (this.player.carrying && inEggRoom(this.player.x, this.player.y) && !this.player.carrying.deposited) {
      this.player.carrying.deposit(this);
      this.player.carrying = null;
    }

    // Process eggs
    this.eggs = this.eggs.filter(eg => {
      if (eg.dead) return false;
      if (eg.hatched) {
        // Hatch into friend ant — apply current colony bonuses to its stats.
        const newAnt = new Ant(eg.x, eg.y, false);
        newAnt.maxHp = this.bonuses.friendMaxHp;
        newAnt.hp = newAnt.maxHp;
        newAnt.attackPower = this.bonuses.friendAttack;
        newAnt.state = 'idle';
        this.friends.push(newAnt);
        this.spawnHatchEffect(eg.x, eg.y);
        if (this.audio) this.audio.play('hatch');
        // Friend increase celebration: bounce the HUD count.
        const ac = document.getElementById('antCount');
        if (ac) {
          ac.classList.remove('bump');
          void ac.offsetWidth;
          ac.classList.add('bump');
        }
        // Bright ring blast from the egg site.
        for (let i = 0; i < 10; i++) {
          const a = (i / 10) * Math.PI * 2;
          this.particles.push(new Particle(
            eg.x, eg.y, Math.cos(a) * 2.4, Math.sin(a) * 2.4 - 0.3,
            500, '#ffe680', 2.4
          ));
        }
        return false;
      }
      return true;
    });

    // Remove dead/expired things
    this.enemies = this.enemies.filter(e => !e.dead);
    this.foods = this.foods.filter(f => !f.deposited);
    this.friends = this.friends.filter(f => !f.dead);
    this.healItems = this.healItems.filter(i => !i.collected);
    if (this.powerUps) this.powerUps = this.powerUps.filter(p => !p.collected);
    this.particles = this.particles.filter(p => !p.dead);
    this.damageNumbers = this.damageNumbers.filter(d => !d.dead);

    // Spawning (event multipliers tweak the cadence).
    this.foodSpawnTimer -= dt * (this._eventFoodMul || 1);
    if (this.foodSpawnTimer <= 0) {
      this.spawnFood();
      // Often spawn a second food too — keeps the field comfortably stocked.
      if (Math.random() < 0.45) this.spawnFood();
      if (this.friends.length >= 200 && Math.random() < 0.6) this.spawnFood();
      const floor = this.friends.length >= 300 ? 1500 : this.friends.length >= 100 ? 2200 : 2800;
      const baseInterval = Math.max(floor, 6500 - this.friends.length * 50);
      this.foodSpawnTimer = baseInterval + rand(0, 2200);
    }
    // Decay call-stress over ~5s after a call.
    if (this.callStress > 0) this.callStress = Math.max(0, this.callStress - dt / 5000);

    // Expansion arrow lifetime
    if (this.expansionArrow) {
      this.expansionArrow.timer -= dt;
      if (this.expansionArrow.timer <= 0) this.expansionArrow = null;
    }

    // Enemy spawn timer ticks faster while call stress is active (raid pause kept normal).
    const stressMul = this.raidActive ? 1 : 1 + this.callStress;
    this.enemySpawnTimer -= dt * stressMul * (this._eventEnemyMul || 1);
    if (this.enemySpawnTimer <= 0) {
      this.spawnEnemy();
      const totalAnts = 1 + this.friends.length;
      const baseInt = Math.max(3500, 12000 - totalAnts * 60);
      this.enemySpawnTimer = baseInt + rand(0, 2500);
      if (!this.firstEnemySeen) {
        this.firstEnemySeen = true;
        setTimeout(() => this.showMessage('敵だ！攻撃か仲間を呼ぼう！', 'warn', 3000), 500);
      }
    }

    // Enemy approach vibration: trigger a single short vibration when an
    // enemy first crosses into attack range of the player (≤ 70px). The
    // cooldown ensures we only buzz once per close call, not per frame.
    if (this.player && !this.player.dead) {
      const APPROACH_RANGE = 70;
      this._lastApproachBuzz = (this._lastApproachBuzz || 0) - dt;
      if (this._lastApproachBuzz <= 0) {
        let close = false;
        for (const e of this.enemies) {
          if (e.dead) continue;
          if (dist(this.player, e) <= APPROACH_RANGE) { close = true; break; }
        }
        if (close) {
          this._lastApproachBuzz = 1500; // 1.5s cooldown
          if (this.vibrationEnabled && navigator.vibrate) {
            try { navigator.vibrate(40); } catch (_) {}
          }
        }
      }
    }

    // Carry-time ambush: when a food is being carried, occasionally spawn an
    // extra enemy nearby. Skipped during raids to avoid overload.
    if (!this.raidActive) {
      for (const food of this.foods) {
        if (!food.beingCarried || food.deposited) continue;
        if (this.enemies.filter(e => !e.dead).length >= this.getMaxEnemies()) break;
        const now = performance.now();
        if (food._lastAmbushTime && now - food._lastAmbushTime < 8000) continue;
        // Per-second probability: 1% base + scales with colony (max ~3% at 100+)
        const prob = (0.01 + Math.min(0.02, this.friends.length * 0.0002)) * (dt / 1000);
        if (Math.random() < prob) {
          food._lastAmbushTime = now;
          this._spawnAmbushNear(food.x, food.y);
        }
      }
    }
    this.healSpawnTimer -= dt;
    if (this.healSpawnTimer <= 0) {
      this.spawnHealItem();
      this.healSpawnTimer = 22000 + rand(0, 12000);
      if (!this.firstHealSeen && this.healItems.length > 0) {
        this.firstHealSeen = true;
        setTimeout(() => this.showMessage('💖 ハートはHP回復アイテム', '', 3000), 800);
      }
    }

    // Raid logic
    if (!this.raidActive) {
      this.raidTimer -= dt;
      // Pre-raid warning: heads-up ~8s before, second alarm ~3s before.
      const aliveFriends = this.friends.filter(f => !f.dead).length;
      if (aliveFriends >= 10) {
        if (!this.raidWarningGiven && this.raidTimer < 8000 && this.raidTimer > 0) {
          this.showMessage('⚠️ 敵の気配が近づいてくる…巣に戻る準備を！', 'warn', 4000);
          this._hintOnce('raid_warn', '巣に戻って迎え撃とう! 不在だと仲間が大量に減る');
          this.raidWarningGiven = true;
        }
        if (!this.raidImminent && this.raidTimer < 3000 && this.raidTimer > 0) {
          this.showMessage('⚠️ もうすぐ襲撃!', 'warn', 2500);
          this.raidImminent = true;
        }
      }
      if (this.raidTimer <= 0) {
        // Post-expansion raids are GUARANTEED — bypass friend threshold.
        const force = !!this.pendingExpansionRaid;
        this.startRaid(force);
        if (this.raidActive) {
          this.pendingExpansionRaid = false;
        } else {
          // Failed precondition (e.g. <10 friends) — try again sooner.
          this.raidTimer = rand(20000, 35000);
          this.raidWarningGiven = false;
          this.raidImminent = false;
        }
      }
    }

    // Random mid-game events
    if (this.activeEvent) {
      this.activeEventTimer -= dt;
      if (this.activeEventTimer <= 0) {
        if (this.activeEvent.revert) this.activeEvent.revert(this);
        this.showMessage(`⚡ ${this.activeEvent.label} 終了`, '', 1800);
        this.activeEvent = null;
        this.eventTimer = rand(90000, 180000);
      }
    } else if ((1 + this.friends.length) >= 30 && !this.raidActive) {
      this.eventTimer -= dt;
      if (this.eventTimer <= 0) {
        const ev = pickRand(RANDOM_EVENTS);
        if (ev.durationMs > 0) {
          this.activeEvent = ev;
          this.activeEventTimer = ev.durationMs;
        } else {
          this.eventTimer = rand(90000, 180000);
        }
        ev.apply(this);
        this.showMessage(`⚡ イベント! ${ev.label}`, 'warn', 3500);
        if (this.audio) this.audio.play('milestone');
      }
    }

    if (this.raidActive) {
      // Drop any dead raiders from tracking; if all dead → success
      this.raidEnemies = this.raidEnemies.filter(e => !e.dead);
      // First raider entering the nest perimeter = "the raid arrived". If the
      // player isn't in the nest at that moment, a hidden penalty kicks in.
      if (!this.raidArrived && this.raidEnemies.some(e => inNest(e.x, e.y))) {
        this.raidArrived = true;
        if (!this.raidPenaltyApplied && this.player && !this.player.dead && !inNest(this.player.x, this.player.y)) {
          this.raidPenaltyApplied = true;
          this._applySilentRaidPenalty(0.30);
        }
      }
      if (this.raidEnemies.length === 0) {
        this.endRaid(true);
      }
    }

    // Periodic auto-save (every 30s) so passive progress is preserved.
    this._lastSaveTime = (this._lastSaveTime || 0) + dt;
    if (this._lastSaveTime > 30000) {
      this._lastSaveTime = 0;
      this.saveGame();
    }

    // Update camera. Cinematic sequences (e.g. expandWorld) override the
    // normal player-follow behavior with scripted keyframes.
    if (this.cinematic) {
      const c = this.cinematic;
      c.t += dt;
      let elapsed = c.t;
      let seg = null;
      for (const s of c.segments) {
        if (elapsed < s.duration) { seg = s; break; }
        elapsed -= s.duration;
      }
      if (seg) {
        const t = clamp(elapsed / seg.duration, 0, 1);
        const e = t * t * (3 - 2 * t);  // smoothstep
        this.camera.cx = lerp(seg.from.cx, seg.to.cx, e);
        this.camera.cy = lerp(seg.from.cy, seg.to.cy, e);
        this.camera.scale = lerp(seg.from.scale, seg.to.scale, e);
      } else {
        // Sequence complete — return to player follow.
        this.cinematic = null;
        this.camera.scale = 1;
      }
    } else {
      this.camera.cx = lerp(this.camera.cx, this.player.x, 0.12);
      this.camera.cy = lerp(this.camera.cy, this.player.y, 0.12);
      // Smoothly settle scale back to 1 if it drifted.
      if (this.camera.scale !== 1) this.camera.scale = lerp(this.camera.scale, 1, 0.18);
    }
    // Project center+scale → top-left for legacy code paths.
    const halfWworld = this.viewW / (2 * this.camera.scale);
    const halfHworld = this.viewH / (2 * this.camera.scale);
    this.camera.x = clamp(this.camera.cx - halfWworld, 0, Math.max(0, WORLD_WIDTH - 2 * halfWworld));
    this.camera.y = clamp(this.camera.cy - halfHworld, 0, Math.max(0, WORLD_HEIGHT - 2 * halfHworld));

    // Update HUD
    const total = 1 + this.friends.length;
    const stageLabel = this.expansionStage > 0 ? ` 🌍${this.expansionStage}` : '';
    const lvLabel = this.colonyLevel > 0 ? ` ⭐${this.colonyLevel}` : '';
    const nestLabel = this.nestLevel > 0 ? ` 🏠${this.nestLevel}` : '';
    document.getElementById('antCount').textContent = `🐜 ${total}${stageLabel}${lvLabel}${nestLabel}`;

    // HP bar with digits + low-hp pulsing.
    const hpFill = document.getElementById('hpFill');
    const hpText = document.getElementById('hpText');
    const hpRatio = this.player.hp / this.player.maxHp;
    hpFill.style.width = (hpRatio * 100) + '%';
    let hpClass;
    if (hpRatio < 0.25) hpClass = 'low';
    else if (hpRatio < 0.6) hpClass = 'medium';
    else hpClass = 'high';
    if (hpFill.className !== hpClass) hpFill.className = hpClass;
    if (hpText) hpText.textContent = `${Math.ceil(this.player.hp)}/${this.player.maxHp}`;

    // Colony progress bar with milestone markers and color tiers.
    const progressFill = document.getElementById('progressFill');
    if (progressFill) {
      const ratio = clamp(total / WIN_ANT_COUNT, 0, 1);
      progressFill.style.width = (ratio * 100) + '%';
      const cls = ratio > 0.7 ? 'high' : ratio > 0.3 ? 'mid' : '';
      if (progressFill.className !== cls) progressFill.className = cls;
      // Add milestone markers once
      const markers = document.getElementById('progressMarkers');
      if (markers && !markers._initted) {
        markers._initted = true;
        for (let i = 1; i < 10; i++) {
          const m = document.createElement('div');
          m.className = 'progress-marker';
          m.style.left = (i * 10) + '%';
          markers.appendChild(m);
        }
      }
    }

    // Dynamic goal text — varies by friend count to keep guidance fresh.
    const goal = document.getElementById('goalText');
    if (goal) {
      const deposits = (this.stats && this.stats.deposits) || 0;
      // Next-area threshold from the dynamic table.
      let nextArea = -1;
      for (let i = 1; i < EXPANSION_THRESHOLDS.length; i++) {
        if (EXPANSION_THRESHOLDS[i] > total) {
          nextArea = EXPANSION_THRESHOLDS[i];
          break;
        }
      }
      let text;
      if (deposits < 5) {
        text = `🌾 餌を巣に運ぼう (${deposits}/5)`;
      } else if (total < FIRST_EXPANSION_AT) {
        text = `👥 仲間を ${FIRST_EXPANSION_AT}匹に増やそう (${total}/${FIRST_EXPANSION_AT})`;
      } else if (total < 50) {
        text = `🌍 新エリア発見! 次の解放まで あと ${nextArea - total}匹`;
      } else if (total < 100) {
        text = `💪 100匹のコロニーを目指そう (${total}/100)`;
      } else if (total < 200) {
        text = `🛡 巣レイドに備えよう! 強い敵が来る (${total}/200)`;
      } else if (total < 350) {
        text = `⚔️ 強敵地帯を攻略しよう (${total}/350)`;
      } else if (total < 500) {
        text = `🏆 折り返し地点! 500匹まで あと ${500 - total}匹`;
      } else if (total < 700) {
        text = `🎖 大コロニーへ! 700匹まで あと ${700 - total}匹`;
      } else if (total < 900) {
        text = `🚀 ラストスパート! 900匹まで あと ${900 - total}匹`;
      } else if (total < WIN_ANT_COUNT) {
        text = `🎯 クリアまで あと ${WIN_ANT_COUNT - total}匹!`;
      } else {
        text = '🎉 1000匹達成！';
      }
      if (goal.textContent !== text) goal.textContent = text;
    }

    // Field expansion check — find the highest stage whose threshold has
    // been crossed by the current friend count.
    let expectedStage = 0;
    for (let i = 1; i < EXPANSION_THRESHOLDS.length; i++) {
      if (total >= EXPANSION_THRESHOLDS[i]) expectedStage = i;
      else break;
    }
    if (expectedStage > MAX_EXPANSION_STAGE) expectedStage = MAX_EXPANSION_STAGE;
    while (expectedStage > this.expansionStage && total < WIN_ANT_COUNT) {
      this.expandWorld();
    }

    // Track milestone times (every 100 friends).
    if (this.stats) {
      this.stats.playTimeMs = (this.stats.playTimeMs || 0) + dt;
      const milestone = Math.floor(total / 100) * 100;
      if (milestone > 0 && !this.stats.milestones[milestone]) {
        this._statMilestone(milestone);
      }
    }

    // Mini-goal celebrations (cosmetic banners + sounds).
    if (!this._milestoneShown) this._milestoneShown = new Set();
    for (const def of MILESTONE_DEFS) {
      if (this._milestoneShown.has(def.n)) continue;
      if (total < def.n) break;
      this._milestoneShown.add(def.n);
      this._showMilestoneBanner(def.label);
    }

    // Nest level-up checks (gated on cumulative deposits).
    const dep = (this.stats && this.stats.deposits) || 0;
    for (const def of NEST_LEVELS) {
      if (this.nestLevel >= def.lv) continue;
      if (dep < def.deposits) break;
      this.nestLevel = def.lv;
      def.apply(this);
      this.showMessage(`🏠 巣 Lv ${def.lv}! ${def.label}`, 'success', 3500);
      if (this.audio) this.audio.play('levelup');
      this.shakeTimer = 350;
      this.shakeMag = 4;
      // Burst at the nest center
      for (let i = 0; i < 24; i++) {
        const a = Math.random() * Math.PI * 2;
        const s = rand(1.4, 3.6);
        this.particles.push(new Particle(
          NEST_X, NEST_Y,
          Math.cos(a) * s, Math.sin(a) * s - 1.2,
          rand(700, 1200), '#ffd84a', rand(2, 3.5)
        ));
      }
    }

    // Nest in-nest HP regen (player only) once Lv 2 is unlocked.
    if (this.bonuses && this.bonuses.nestRegenPerSec > 0
        && this.player && !this.player.dead
        && inNest(this.player.x, this.player.y)
        && this.player.hp < this.player.maxHp) {
      this._nestRegenAcc = (this._nestRegenAcc || 0) + dt * 0.001 * this.bonuses.nestRegenPerSec;
      if (this._nestRegenAcc >= 1) {
        const heal = Math.floor(this._nestRegenAcc);
        this._nestRegenAcc -= heal;
        this.player.hp = clamp(this.player.hp + heal, 0, this.player.maxHp);
      }
    } else {
      this._nestRegenAcc = 0;
    }

    // Colony level-up checks (passive bonuses).
    for (const def of COLONY_LEVELS) {
      if (this.colonyLevel >= def.lv) continue;
      if (total < def.friends) break;
      this.colonyLevel = def.lv;
      def.apply(this);
      this.showMessage(`⭐ Lv ${def.lv}! ${def.label}`, 'success', 3500);
      if (this.audio) this.audio.play('levelup');
      this.shakeTimer = 350;
      this.shakeMag = 4;
      // Sparkle burst
      for (let i = 0; i < 22; i++) {
        const a = Math.random() * Math.PI * 2;
        const s = rand(1.2, 3.2);
        this.particles.push(new Particle(
          this.player.x, this.player.y,
          Math.cos(a) * s, Math.sin(a) * s - 1.2,
          rand(700, 1100), '#ffe680', rand(2, 3.5)
        ));
      }
    }

    // Win check
    if (total >= WIN_ANT_COUNT) {
      this.gameState = 'won';
      if (this.audio) this.audio.play('win');
      if (this.bgm) this.bgm.stop();
      // Record best clear time + history; render the win-screen panel.
      let elapsed = 0;
      let isNewBest = false;
      if (this.stats) {
        elapsed = Math.round(performance.now() - this.stats.runStart);
        if (!this.stats.bestClearMs || elapsed < this.stats.bestClearMs) {
          this.stats.bestClearMs = elapsed;
          isNewBest = true;
        }
        this._persistStatsOnly();
      }
      this._appendHistoryAndRender(elapsed, isNewBest);
      this._checkSkinUnlocks();
      this.clearSave();
      document.getElementById('winScreen').classList.remove('hidden');
    }

    // Decay shake
    if (this.shakeTimer > 0) {
      this.shakeTimer -= dt;
      if (this.shakeTimer <= 0) this.shakeMag = 0;
    }

    // Tutorial-ish hint: first food
    if (!this.firstFoodSeen && this.foods.length > 0) {
      // After 2 seconds, hint
      this._foodHintTimer = (this._foodHintTimer || 0) + dt;
      if (this._foodHintTimer > 2500) {
        this.firstFoodSeen = true;
        this.showMessage('外に出て餌を探そう！', '', 3000);
      }
    }
  }

  // ---------- Render ----------
  render() {
    const ctx = this.ctx;
    let shakeX = 0, shakeY = 0;
    if (this.shakeTimer > 0 && this.shakeMag > 0) {
      const t = this.shakeTimer / 600;
      shakeX = (Math.random() - 0.5) * this.shakeMag * t * 2;
      shakeY = (Math.random() - 0.5) * this.shakeMag * t * 2;
    }
    ctx.save();
    // Cinematic-aware transform: translate to viewport center, apply scale,
    // then translate so (camera.cx, camera.cy) maps to that center.
    const scale = this.camera.scale || 1;
    ctx.translate(this.viewW / 2 + shakeX, this.viewH / 2 + shakeY);
    if (scale !== 1) ctx.scale(scale, scale);
    ctx.translate(-this.camera.cx, -this.camera.cy);

    this.drawBackground(ctx);
    this.drawNest(ctx);

    // Draw grass tufts
    this.grassTufts.forEach(g => g.draw(ctx, this.time));

    // Draw eggs (under ants)
    this.eggs.forEach(e => e.draw(ctx));

    // Draw uncarried foods (below ants)
    this.foods.forEach(f => { if (!f.beingCarried) f.draw(ctx); });

    // Pheromone trail (drawn under heal items / entities)
    if (this.trailPoints && this.trailPoints.length) {
      for (const p of this.trailPoints) {
        const a = (p.life / p.maxLife) * 0.18;
        ctx.fillStyle = `rgba(255, 255, 220, ${a})`;
        ctx.beginPath();
        ctx.arc(p.x, p.y, 2.4, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // Draw heal items
    this.healItems.forEach(h => h.draw(ctx));
    if (this.powerUps) this.powerUps.forEach(p => p.draw(ctx));

    // Draw ants and enemies sorted by Y. Visually compact "idle in nest" ants
    // when the colony grows large: only render the first NEST_VISIBLE_CAP
    // wandering inside the nest; the rest are summarised with a "+N匹" badge
    // drawn over the egg room.
    const NEST_VISIBLE_CAP = 18;
    const drawables = [];
    if (this.player) drawables.push(this.player);
    this.enemies.forEach(e => drawables.push(e));

    let nestIdleVisible = 0;
    let nestIdleHidden = 0;
    for (const f of this.friends) {
      if (f.dead) continue;
      const idleInNest = (f.state === 'idle' && inNest(f.x, f.y));
      if (idleInNest) {
        if (nestIdleVisible < NEST_VISIBLE_CAP) {
          drawables.push(f);
          nestIdleVisible++;
        } else {
          nestIdleHidden++;
        }
      } else {
        drawables.push(f);
      }
    }
    this._nestIdleHidden = nestIdleHidden;

    drawables.sort((a, b) => a.y - b.y);
    // LOD draw: skip entities completely off-screen (with margin).
    const dLeft   = this.camera.x - 60;
    const dTop    = this.camera.y - 60;
    const dRight  = this.camera.x + this.viewW + 60;
    const dBottom = this.camera.y + this.viewH + 60;
    drawables.forEach(d => {
      if (d.x < dLeft || d.x > dRight || d.y < dTop || d.y > dBottom) return;
      d.draw(ctx);
    });

    // Active power-up aura around the player.
    if (this.player && !this.player.dead && this.activePowerUp) {
      const def = POWERUP_DEFS[this.activePowerUp];
      const t = (this.time || 0) * 0.012;
      const pulse = 0.55 + 0.45 * Math.sin(t);
      ctx.save();
      ctx.strokeStyle = `rgba(${def.auraColor}, ${0.55 * pulse})`;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(this.player.x, this.player.y + 3, this.player.size + 12, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }

    // Call-stress aura around the player while the call window is hot.
    if (this.player && !this.player.dead && this.callStress > 0.4) {
      ctx.save();
      const pulse = 0.5 + 0.5 * Math.sin((this.time || 0) * 0.012);
      const alpha = (this.callStress - 0.3) * 0.6 * pulse;
      ctx.strokeStyle = `rgba(255, 60, 60, ${alpha})`;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(this.player.x, this.player.y + 3, 24, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }

    // "+N匹" badge inside the nest when many idle ants are hidden
    if (nestIdleHidden > 0) {
      const bx = NEST_X;
      const by = NEST_Y - EGG_ROOM_RADIUS - 14;
      const text = `🐜 +${nestIdleHidden}`;
      ctx.save();
      ctx.font = 'bold 13px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const metrics = ctx.measureText(text);
      const padX = 8;
      const padY = 4;
      const boxW = metrics.width + padX * 2;
      const boxH = 18;
      ctx.fillStyle = 'rgba(20, 12, 6, 0.78)';
      if (ctx.roundRect) {
        ctx.beginPath();
        ctx.roundRect(bx - boxW / 2, by - boxH / 2, boxW, boxH, 8);
        ctx.fill();
      } else {
        ctx.fillRect(bx - boxW / 2, by - boxH / 2, boxW, boxH);
      }
      ctx.fillStyle = '#ffe0a0';
      ctx.fillText(text, bx, by);
      ctx.restore();
    }

    // Draw carried foods (above ants — visible on top of carriers)
    this.foods.forEach(f => { if (f.beingCarried) f.draw(ctx); });

    // Particles
    this.particles.forEach(p => p.draw(ctx));
    this.damageNumbers.forEach(d => d.draw(ctx));

    // Optional: world bounds indicator
    ctx.restore();

    // Radar power-up: small green arrows at the screen edge for each
    // off-screen uncarried food, so the player can plan a route.
    if (this.player && this.gameState === 'playing' && this.activePowerUp === 'radar') {
      const cx = this.viewW / 2, cy = this.viewH / 2;
      const pad = 28;
      let drawn = 0;
      for (const f of this.foods) {
        if (f.deposited || f.beingCarried) continue;
        if (drawn >= 8) break; // cap to avoid clutter
        const sx = f.x - this.camera.x;
        const sy = f.y - this.camera.y;
        const onscreen = sx >= 0 && sy >= 0 && sx <= this.viewW && sy <= this.viewH;
        if (onscreen) continue;
        const dx = sx - cx, dy = sy - cy;
        const a = Math.atan2(dy, dx);
        const ex = clamp(cx + Math.cos(a) * 1000, pad, this.viewW - pad);
        const ey = clamp(cy + Math.sin(a) * 1000, pad, this.viewH - pad);
        const t = (this.time || 0) * 0.006;
        const pulse = 0.65 + 0.35 * Math.sin(t + drawn);
        ctx.save();
        ctx.translate(ex, ey);
        ctx.rotate(a);
        // Small arrow
        ctx.fillStyle = `rgba(110, 220, 110, ${0.65 * pulse})`;
        ctx.strokeStyle = 'rgba(20, 60, 20, 0.8)';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(11, 0);
        ctx.lineTo(-7, -7);
        ctx.lineTo(-2, 0);
        ctx.lineTo(-7, 7);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
        // Food-type indicator dot
        ctx.rotate(-a);
        ctx.fillStyle = f.color || '#caa37c';
        ctx.beginPath();
        ctx.arc(0, 0, 2.4, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
        drawn++;
      }
    }

    // Expansion direction arrow — big golden "→ 🌍 NEW" for 5s after a new
    // zone unlocks, so the player can find their way after the cinematic ends.
    if (this.expansionArrow && this.expansionArrow.timer > 0 && this.gameState === 'playing') {
      const ax = this.expansionArrow.zoneCx;
      const ay = this.expansionArrow.zoneCy;
      const sx = ax - this.camera.x;
      const sy = ay - this.camera.y;
      const cx = this.viewW / 2, cy = this.viewH / 2;
      const dx = sx - cx, dy = sy - cy;
      const a = Math.atan2(dy, dx);
      const pad = 70;
      const ex = clamp(cx + Math.cos(a) * 1000, pad, this.viewW - pad);
      const ey = clamp(cy + Math.sin(a) * 1000, pad, this.viewH - pad);
      const t = (this.time || 0) * 0.008;
      const pulse = 0.7 + 0.3 * Math.sin(t);
      ctx.save();
      ctx.translate(ex, ey);
      ctx.rotate(a);
      ctx.fillStyle = `rgba(255, 215, 60, ${0.85 * pulse})`;
      ctx.strokeStyle = 'rgba(80, 50, 0, 0.95)';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(28, 0);
      ctx.lineTo(-12, -18);
      ctx.lineTo(-4, 0);
      ctx.lineTo(-12, 18);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      ctx.rotate(-a);
      ctx.fillStyle = '#fff';
      ctx.strokeStyle = 'rgba(0,0,0,0.85)';
      ctx.lineWidth = 3;
      ctx.font = 'bold 13px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.strokeText('🌍 NEW', 0, 0);
      ctx.fillText('🌍 NEW', 0, 0);
      ctx.restore();
    }

    // Raid warning arrow — points toward nearest raider when raid active
    if (this.player && this.gameState === 'playing' && this.raidActive && this.raidEnemies.length > 0) {
      // Find nearest raider to player
      let nr = null, nd = Infinity;
      for (const e of this.raidEnemies) {
        if (e.dead) continue;
        const d = dist(this.player, e);
        if (d < nd) { nd = d; nr = e; }
      }
      if (nr) {
        const sx = nr.x - this.camera.x;
        const sy = nr.y - this.camera.y;
        const offscreen = sx < 0 || sy < 0 || sx > this.viewW || sy > this.viewH;
        if (offscreen) {
          // Clamp screen position to edge with padding
          const cx = this.viewW / 2, cy = this.viewH / 2;
          const dx = sx - cx, dy = sy - cy;
          const a = Math.atan2(dy, dx);
          const pad = 50;
          const ex = clamp(cx + Math.cos(a) * 1000, pad, this.viewW - pad);
          const ey = clamp(cy + Math.sin(a) * 1000, pad, this.viewH - pad);
          ctx.save();
          ctx.translate(ex, ey);
          ctx.rotate(a);
          const t = (this.time || 0) * 0.005;
          ctx.fillStyle = `rgba(255, 50, 50, ${0.7 + 0.3 * Math.sin(t)})`;
          ctx.strokeStyle = 'rgba(80,0,0,0.8)';
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.moveTo(18, 0);
          ctx.lineTo(-10, -12);
          ctx.lineTo(-4, 0);
          ctx.lineTo(-10, 12);
          ctx.closePath();
          ctx.fill();
          ctx.stroke();
          ctx.fillStyle = '#fff';
          ctx.font = 'bold 14px sans-serif';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.rotate(-a); // unrotate for text
          ctx.fillText('⚠', -2, 0);
          ctx.restore();
        }
      }
    }

    // Approaching enemies (non-raid): show a small arrow at the screen edge
    // for any nearby off-screen enemy that's about to close on the player.
    if (this.player && this.gameState === 'playing' && !this.player.dead) {
      const APPROACH_RANGE = 240;
      for (const e of this.enemies) {
        if (e.dead) continue;
        if (this.raidActive && this.raidEnemies && this.raidEnemies.indexOf(e) !== -1) continue;
        const d = dist(this.player, e);
        if (d > APPROACH_RANGE) continue;
        const sx = e.x - this.camera.x;
        const sy = e.y - this.camera.y;
        const offscreen = sx < 0 || sy < 0 || sx > this.viewW || sy > this.viewH;
        if (!offscreen) continue;
        const cx = this.viewW / 2, cy = this.viewH / 2;
        const dx = sx - cx, dy = sy - cy;
        const a = Math.atan2(dy, dx);
        const pad = 38;
        const ex = clamp(cx + Math.cos(a) * 1000, pad, this.viewW - pad);
        const ey = clamp(cy + Math.sin(a) * 1000, pad, this.viewH - pad);
        ctx.save();
        ctx.translate(ex, ey);
        ctx.rotate(a);
        const t = (this.time || 0) * 0.006;
        ctx.fillStyle = `rgba(255, 140, 60, ${0.55 + 0.25 * Math.sin(t)})`;
        ctx.strokeStyle = 'rgba(80,30,0,0.7)';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(12, 0);
        ctx.lineTo(-6, -8);
        ctx.lineTo(-2, 0);
        ctx.lineTo(-6, 8);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
        ctx.restore();
      }
    }

    // Draw nest direction indicator if player far from nest
    if (this.player && this.gameState === 'playing') {
      const dx = NEST_X - this.player.x;
      const dy = NEST_Y - this.player.y;
      const d = Math.hypot(dx, dy);
      if (d > 350 && this.player.carrying) {
        const sx = this.player.x - this.camera.x;
        const sy = this.player.y - this.camera.y;
        const a = Math.atan2(dy, dx);
        const r = 60;
        const ax = sx + Math.cos(a) * r;
        const ay = sy + Math.sin(a) * r;
        ctx.save();
        ctx.translate(ax, ay);
        ctx.rotate(a);
        ctx.fillStyle = 'rgba(255, 220, 80, 0.9)';
        ctx.strokeStyle = 'rgba(0,0,0,0.6)';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(15, 0);
        ctx.lineTo(0, -10);
        ctx.lineTo(0, -4);
        ctx.lineTo(-12, -4);
        ctx.lineTo(-12, 4);
        ctx.lineTo(0, 4);
        ctx.lineTo(0, 10);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
        ctx.restore();
      }
    }
  }

  drawBackground(ctx) {
    // Camera + viewport in world units (scale during cinematic).
    const scale = (this.camera && this.camera.scale) || 1;
    const vWw = this.viewW / scale;
    const vHw = this.viewH / scale;
    const visL = this.camera.x - 30;
    const visT = this.camera.y - 30;
    const visR = this.camera.x + vWw + 30;
    const visB = this.camera.y + vHw + 30;

    // ---- Phase 1: rocky wasteland everywhere (under everything) ----
    // Warm dark stone gradient as the base.
    const baseGrad = ctx.createLinearGradient(visL, visT, visL, visB);
    baseGrad.addColorStop(0, '#3b342c');
    baseGrad.addColorStop(1, '#2e2820');
    ctx.fillStyle = baseGrad;
    ctx.fillRect(visL, visT, visR - visL, visB - visT);
    this._drawRockClutter(visL, visT, visR, visB);

    // ---- Phase 2: each zone as a smooth organic biome shape ----
    if (this.zones) {
      for (const zone of this.zones) {
        if (zone.x1 < visL || zone.x0 > visR || zone.y1 < visT || zone.y0 > visB) continue;
        this._drawZoneBackground(ctx, zone);
      }
    }
  }

  // Stable per-cell pseudo-random in [0, 1) — for prop placement.
  _hash01(c, r, salt = 0) {
    const n = (c * 73856093) ^ (r * 19349663) ^ (salt * 83492791);
    return ((n >>> 0) % 100000) / 100000;
  }

  // Scatter chunky dark rocks/pebbles across the visible area, except where
  // they'd land inside an unlocked zone (those are biome territory).
  _drawRockClutter(visL, visT, visR, visB) {
    const ctx = this.ctx;
    const cell = 70;
    const c0 = Math.floor(visL / cell);
    const r0 = Math.floor(visT / cell);
    const c1 = Math.ceil(visR / cell);
    const r1 = Math.ceil(visB / cell);
    for (let r = r0; r < r1; r++) {
      for (let c = c0; c < c1; c++) {
        // Stable position within the cell
        const px = c * cell + this._hash01(c, r, 1) * cell;
        const py = r * cell + this._hash01(c, r, 2) * cell;
        if (this._isInsideAnyZone(px, py)) continue;
        const sz = 4 + this._hash01(c, r, 3) * 6;
        const tilt = this._hash01(c, r, 4) * Math.PI;
        // Rock body
        ctx.save();
        ctx.translate(px, py);
        ctx.rotate(tilt);
        ctx.fillStyle = '#1c1812';
        ctx.beginPath();
        ctx.ellipse(0, 0, sz, sz * 0.72, 0, 0, Math.PI * 2);
        ctx.fill();
        // Highlight chip
        ctx.fillStyle = 'rgba(180,160,130,0.32)';
        ctx.beginPath();
        ctx.ellipse(-sz * 0.35, -sz * 0.30, sz * 0.34, sz * 0.18, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }
    }
  }

  _isInsideAnyZone(x, y) {
    if (!this.zones) return false;
    for (const z of this.zones) {
      if (x >= z.x0 && x <= z.x1 && y >= z.y0 && y <= z.y1) return true;
    }
    return false;
  }

  _drawZoneBackground(ctx, zone) {
    const x = zone.x0, y = zone.y0;
    const w = zone.x1 - x, h = zone.y1 - y;
    const biome = zone.biome;
    // Soft drop-shadow under each zone for that "raised platform" feel.
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.45)';
    ctx.shadowBlur = 14;
    ctx.shadowOffsetY = 4;
    this._fillBiomeBase(ctx, x, y, w, h, biome);
    ctx.restore();
    // Decorative props on top
    this._drawZoneDeco(ctx, zone);
  }

  _roundedRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  _fillBiomeBase(ctx, x, y, w, h, biome) {
    const r = 60;
    if (biome === 'grass') {
      const g = ctx.createLinearGradient(x, y, x, y + h);
      g.addColorStop(0, '#6cae45');
      g.addColorStop(1, '#4f9430');
      ctx.fillStyle = g;
      this._roundedRect(ctx, x, y, w, h, r); ctx.fill();
    } else if (biome === 'pond') {
      const g = ctx.createRadialGradient(x + w/2, y + h/2, 30, x + w/2, y + h/2, Math.max(w, h) * 0.6);
      g.addColorStop(0, '#5aa1d9');
      g.addColorStop(1, '#27598a');
      ctx.fillStyle = g;
      this._roundedRect(ctx, x, y, w, h, r); ctx.fill();
    } else if (biome === 'sand') {
      const g = ctx.createLinearGradient(x, y, x, y + h);
      g.addColorStop(0, '#e6cd8d');
      g.addColorStop(1, '#cbab68');
      ctx.fillStyle = g;
      this._roundedRect(ctx, x, y, w, h, r); ctx.fill();
    } else if (biome === 'mud') {
      const g = ctx.createLinearGradient(x, y, x, y + h);
      g.addColorStop(0, '#6c4624');
      g.addColorStop(1, '#4a2e15');
      ctx.fillStyle = g;
      this._roundedRect(ctx, x, y, w, h, r); ctx.fill();
    } else if (biome === 'flower') {
      const g = ctx.createLinearGradient(x, y, x, y + h);
      g.addColorStop(0, '#74b746');
      g.addColorStop(1, '#558e30');
      ctx.fillStyle = g;
      this._roundedRect(ctx, x, y, w, h, r); ctx.fill();
    } else if (biome === 'leaves') {
      const g = ctx.createLinearGradient(x, y, x, y + h);
      g.addColorStop(0, '#8b5328');
      g.addColorStop(1, '#603a1c');
      ctx.fillStyle = g;
      this._roundedRect(ctx, x, y, w, h, r); ctx.fill();
    } else if (biome === 'concrete') {
      const g = ctx.createLinearGradient(x, y, x, y + h);
      g.addColorStop(0, '#a6a6a6');
      g.addColorStop(1, '#7e7e7e');
      ctx.fillStyle = g;
      this._roundedRect(ctx, x, y, w, h, r); ctx.fill();
    }
  }

  _drawZoneDeco(ctx, zone) {
    const { x0, y0, x1, y1, biome } = zone;
    const w = x1 - x0, h = y1 - y0;
    // Density per biome — denser for "decorative" biomes like flower/leaves.
    const density = biome === 'flower' ? 1.6
                  : biome === 'leaves' ? 1.4
                  : biome === 'sand'   ? 1.0
                  : biome === 'mud'    ? 0.8
                  : biome === 'concrete' ? 0.7
                  : biome === 'pond'   ? 0.6
                  : 0.5;
    const items = Math.floor((w * h) / 2200 * density);
    const animPhase = (this.time || 0) * 0.001;
    for (let i = 0; i < items; i++) {
      // Stable per-(zone, i)
      const ux = this._hash01(zone.x0 + i, zone.y0, 11);
      const uy = this._hash01(zone.x0 + i, zone.y0, 22);
      const px = x0 + 12 + ux * (w - 24);
      const py = y0 + 12 + uy * (h - 24);
      const seed = ((zone.x0 + i) * 7919) ^ (zone.y0 * 6857);
      this._drawDecoItem(ctx, px, py, biome, seed, animPhase);
    }
  }

  _drawDecoItem(ctx, x, y, biome, seed, anim) {
    const u = (s) => ((seed * (s + 1)) >>> 0) % 1000 / 1000;
    if (biome === 'flower') {
      // Cute 5-petal flower with sway
      const colors = ['#ff7eb1', '#ffd24a', '#ffffff', '#bb88ff', '#ff8042'];
      const c = colors[Math.floor(u(1) * colors.length)];
      const r = 3.2 + u(2) * 1.2;
      const sway = Math.sin(anim * 1.5 + u(3) * Math.PI * 2) * 1.2;
      // Stem
      ctx.strokeStyle = '#3d6a25';
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.moveTo(x, y + r * 1.6);
      ctx.quadraticCurveTo(x + sway * 0.5, y + r * 0.6, x + sway, y - r * 0.2);
      ctx.stroke();
      // Petals
      const cx = x + sway, cy = y;
      ctx.fillStyle = c;
      for (let p = 0; p < 5; p++) {
        const a = (p / 5) * Math.PI * 2;
        ctx.beginPath();
        ctx.arc(cx + Math.cos(a) * r, cy + Math.sin(a) * r, r * 0.7, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.fillStyle = '#ffe34a';
      ctx.beginPath(); ctx.arc(cx, cy, r * 0.65, 0, Math.PI * 2); ctx.fill();
    } else if (biome === 'leaves') {
      const colors = ['#a55a25', '#d68635', '#e0a040', '#7d4419', '#c46c20'];
      const c = colors[Math.floor(u(1) * colors.length)];
      const a = u(2) * Math.PI * 2;
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(a);
      ctx.fillStyle = c;
      ctx.strokeStyle = 'rgba(0,0,0,0.4)';
      ctx.lineWidth = 0.8;
      ctx.beginPath();
      ctx.ellipse(0, 0, 6, 3.5, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(-6, 0); ctx.lineTo(6, 0);
      ctx.stroke();
      ctx.restore();
    } else if (biome === 'pond') {
      // Lily pad with subtle ripple
      const ripple = (anim + u(1)) % 1;
      ctx.fillStyle = 'rgba(110, 200, 100, 0.85)';
      ctx.strokeStyle = 'rgba(40,80,40,0.35)';
      ctx.lineWidth = 0.8;
      ctx.beginPath();
      ctx.arc(x, y, 9 + u(2) * 3, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      // wedge cut for the lily pad
      ctx.fillStyle = 'rgba(50, 100, 140, 0.55)';
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.arc(x, y, 9.4, 0, Math.PI / 5);
      ctx.closePath();
      ctx.fill();
      // Ripple ring
      ctx.strokeStyle = `rgba(255,255,255,${0.30 * (1 - ripple)})`;
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.arc(x, y, 12 + ripple * 14, 0, Math.PI * 2);
      ctx.stroke();
    } else if (biome === 'sand') {
      ctx.fillStyle = 'rgba(120, 80, 40, 0.55)';
      ctx.beginPath();
      ctx.arc(x, y, 1.7 + u(1) * 1.5, 0, Math.PI * 2);
      ctx.fill();
      // Occasional bigger rock
      if (u(2) < 0.18) {
        ctx.fillStyle = '#c9a86c';
        ctx.beginPath();
        ctx.ellipse(x + 4, y + 2, 3.5, 2.4, u(3) * Math.PI, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = 'rgba(255,255,255,0.25)';
        ctx.beginPath();
        ctx.ellipse(x + 3, y + 1, 1.2, 0.8, 0, 0, Math.PI * 2);
        ctx.fill();
      }
    } else if (biome === 'mud') {
      // Dark wet patch
      ctx.fillStyle = 'rgba(28, 18, 8, 0.7)';
      ctx.beginPath();
      ctx.ellipse(x, y, 9, 5, u(1) * Math.PI, 0, Math.PI * 2);
      ctx.fill();
      // Gloss highlight
      ctx.fillStyle = 'rgba(150, 110, 70, 0.30)';
      ctx.beginPath();
      ctx.ellipse(x - 2, y - 1, 3, 1, 0, 0, Math.PI * 2);
      ctx.fill();
      // Reed sometimes
      if (u(2) < 0.22) {
        ctx.strokeStyle = 'rgba(40, 70, 30, 0.8)';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(x + 4, y);
        ctx.quadraticCurveTo(x + 5, y - 5, x + 4, y - 11);
        ctx.stroke();
      }
    } else if (biome === 'concrete') {
      // Crack
      ctx.strokeStyle = 'rgba(40,40,40,0.55)';
      ctx.lineWidth = 1.1;
      let cx = x, cy = y;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      for (let i = 0; i < 3; i++) {
        cx += (u(i + 1) - 0.5) * 16;
        cy += (u(i + 5) - 0.5) * 16;
        ctx.lineTo(cx, cy);
      }
      ctx.stroke();
      // Speckle
      ctx.fillStyle = 'rgba(70,70,70,0.4)';
      ctx.fillRect(x + 4, y + 4, 1.4, 1.4);
    }
  }

  drawNest(ctx) {
    const totalAnts = 1 + this.friends.length;
    const radius = NEST_RADIUS_BASE + Math.min(60, totalAnts * 0.5);

    // Sandy ground around nest
    const grad = ctx.createRadialGradient(NEST_X, NEST_Y, 20, NEST_X, NEST_Y, radius + 40);
    grad.addColorStop(0, '#4a3018');
    grad.addColorStop(0.4, '#7a5634');
    grad.addColorStop(0.8, '#9a7848');
    grad.addColorStop(1, '#8a7038');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(NEST_X, NEST_Y, radius + 30, 0, Math.PI * 2);
    ctx.fill();

    // Sand bumps around nest mound
    ctx.fillStyle = 'rgba(120, 90, 50, 0.5)';
    for (let i = 0; i < 16; i++) {
      const a = (i / 16) * Math.PI * 2;
      const r = radius + 10 + Math.sin(i * 1.3) * 8;
      const px = NEST_X + Math.cos(a) * r;
      const py = NEST_Y + Math.sin(a) * r;
      ctx.beginPath();
      ctx.arc(px, py, 8 + Math.sin(i * 2.1) * 3, 0, Math.PI * 2);
      ctx.fill();
    }

    // Inner sand (dirt floor)
    ctx.fillStyle = '#5e3a1c';
    ctx.beginPath();
    ctx.arc(NEST_X, NEST_Y, radius - 10, 0, Math.PI * 2);
    ctx.fill();

    // Egg room (inner)
    const eggGrad = ctx.createRadialGradient(NEST_X, NEST_Y, 5, NEST_X, NEST_Y, EGG_ROOM_RADIUS);
    eggGrad.addColorStop(0, '#3d2410');
    eggGrad.addColorStop(0.7, '#4a2f15');
    eggGrad.addColorStop(1, '#5a3a1c');
    ctx.fillStyle = eggGrad;
    ctx.beginPath();
    ctx.arc(NEST_X, NEST_Y, EGG_ROOM_RADIUS, 0, Math.PI * 2);
    ctx.fill();

    // Egg room rim
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.4)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(NEST_X, NEST_Y, EGG_ROOM_RADIUS, 0, Math.PI * 2);
    ctx.stroke();

    // Label
    ctx.fillStyle = 'rgba(255, 230, 180, 0.6)';
    ctx.font = 'bold 14px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('🥚 卵部屋', NEST_X, NEST_Y + EGG_ROOM_RADIUS + 18);

    // Nest entrance ring (boundary)
    ctx.strokeStyle = 'rgba(0,0,0,0.25)';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(NEST_X, NEST_Y, radius - 10, 0, Math.PI * 2);
    ctx.stroke();
  }

  // ---------- Main Loop ----------
  loop(time) {
    let dt = time - this.lastTime;
    if (dt > 100) dt = 100; // cap dt to avoid jumps when tab is hidden
    this.lastTime = time;
    this.time = time;

    this.update(dt);
    // Always render so background looks alive
    this.ctx.fillStyle = '#1a1a1a';
    this.ctx.fillRect(0, 0, this.viewW, this.viewH);
    if (this.player) {
      this.render();
    } else {
      // Pre-game: render world for show
      this.drawBackground(this.ctx);
    }

    requestAnimationFrame(this.loop.bind(this));
  }
}

// Polyfill for older browsers
if (!CanvasRenderingContext2D.prototype.roundRect) {
  CanvasRenderingContext2D.prototype.roundRect = function (x, y, w, h, r) {
    if (w < 2 * r) r = w / 2;
    if (h < 2 * r) r = h / 2;
    this.beginPath();
    this.moveTo(x + r, y);
    this.arcTo(x + w, y, x + w, y + h, r);
    this.arcTo(x + w, y + h, x, y + h, r);
    this.arcTo(x, y + h, x, y, r);
    this.arcTo(x, y, x + w, y, r);
    this.closePath();
    return this;
  };
}

// ---------- Init ----------
window.addEventListener('load', () => {
  window.game = new Game();
});

// Prevent pinch zoom on iOS
document.addEventListener('gesturestart', (e) => e.preventDefault());
document.addEventListener('gesturechange', (e) => e.preventDefault());
document.addEventListener('gestureend', (e) => e.preventDefault());
