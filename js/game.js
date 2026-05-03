/* ====================================================================
   アント (ANT) - One-handed mobile commute game
   ==================================================================== */

// ---------- Constants ----------
// World dimensions are mutable to support runtime expansion (Issue #7).
let WORLD_WIDTH = 1400;
let WORLD_HEIGHT = 2000;

// Nest position is fixed at the original world center; world growth happens
// to the east (right). Coordinates remain stable for all existing entities.
let NEST_X = WORLD_WIDTH / 2;
let NEST_Y = WORLD_HEIGHT - 220;
const NEST_RADIUS_BASE = 120;
const EGG_ROOM_RADIUS = 70;

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
const EXPANSION_THRESHOLD = 50;        // every N allies a new biome unlocks
const MAX_EXPANSION_STAGE = 19;        // 1000/50 - 1 (final stage = win)
const WORLD_EXPAND_AMOUNT = 350;       // ≈25% of initial 1400 width
// Order in which biome regions appear. After the 6th unlock the cycle repeats.
const BIOME_SEQUENCE = ['mud', 'pond', 'flower', 'leaves', 'sand', 'concrete'];
const BIOME_UNLOCK_INFO = {
  mud:      { name: '🟫 泥',       intro: '体力じわじわ減・カブトムシ出現' },
  pond:     { name: '🟦 池',       intro: '大幅減速&HP減少・ハチ出現' },
  flower:   { name: '🌸 花畑',     intro: '餌が豊富&HP微回復' },
  leaves:   { name: '🍂 落ち葉',   intro: 'クモが多く隠れる' },
  sand:     { name: '🟨 砂',       intro: '歩きづらい' },
  concrete: { name: '⬜ コンクリ', intro: '強敵&大型餌 (人の落とし物)' }
};

const MAX_ENEMIES = 4;
const MAX_FOODS = 6;

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
    this.size = isPlayer ? 11 : 9;
    this.state = isPlayer ? 'player' : 'idle';  // idle, follow, carrying, attacking
    this.target = null;
    this.carrying = null;
    this.attackCooldown = 0;
    this.invuln = 0;
    this.legPhase = Math.random() * Math.PI * 2;
    this.dead = false;
    this.wanderTarget = null;
    this.wanderTimer = 0;
    this.color = isPlayer ? '#3a1f0a' : '#5a3416';
    this.bodyHighlight = isPlayer ? '#6a3a18' : '#8a5a2c';
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
    if (game.terrain && !inNest(this.x, this.y)) {
      const t = game.terrain.getAt(this.x, this.y);
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
    const input = game.input;
    let moving = false;
    let speed = this.speed;

    // Slow down when carrying heavy food
    if (this.carrying) {
      const carriers = this.carrying.carriers.length;
      const required = this.carrying.required;
      if (required >= 5) speed *= 0.40;
      else if (required >= 3) speed *= 0.55;
      else speed *= 0.85;
    }

    // Apply terrain slowdown
    speed *= this._terrainSpeedMul || 1;

    if (input.moving) {
      const dx = input.moveX;
      const dy = input.moveY;
      const m = Math.hypot(dx, dy);
      if (m > 0.1) {
        const nx = dx / m;
        const ny = dy / m;
        this.x += nx * speed;
        this.y += ny * speed;
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
        this.moveToward({ x: NEST_X, y: NEST_Y }, this.speed * slow);
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
        this.moveToward(this.target, this.speed * 0.95);
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
      const d = dist(this, player);
      if (d > 50) {
        this.moveToward(player, this.speed * 0.95);
        moving = true;
      } else if (d > 30) {
        this.moveToward(player, this.speed * 0.5);
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

      // Follow times out — go back to idle
      if (this.callTimer <= 0 && d < 80) {
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

    // 2) Wander near nest
    this.wanderTimer -= dt;
    if (!this.wanderTarget || this.wanderTimer <= 0 ||
        dist(this, this.wanderTarget) < 15) {
      const a = Math.random() * Math.PI * 2;
      const r = Math.random() * (NEST_RADIUS_BASE * 0.8);
      this.wanderTarget = {
        x: NEST_X + Math.cos(a) * r,
        y: NEST_Y + Math.sin(a) * r
      };
      this.wanderTimer = rand(2000, 4500);
    }
    this.moveToward(this.wanderTarget, this.speed * 0.35);
    moving = true;
    this._moving = moving;
  }

  moveToward(target, spd) {
    const dx = target.x - this.x;
    const dy = target.y - this.y;
    const d = Math.hypot(dx, dy);
    if (d > 0.5) {
      const eff = spd * (this._terrainSpeedMul || 1);
      this.x += (dx / d) * eff;
      this.y += (dy / d) * eff;
      this.targetAngle = Math.atan2(dy, dx);
    }
  }

  takeDamage(dmg, game, attacker) {
    if (this.dead || this.invuln > 0) return;
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
    ctx.save();
    ctx.translate(this.x, this.y);
    ctx.rotate(this.angle + Math.PI / 2);

    if (this.invuln > 0 && Math.floor(this.invuln / 60) % 2 === 0) {
      ctx.globalAlpha = 0.45;
    }

    const s = this.size / 11;
    const legSwing = Math.sin(this.legPhase) * 0.6;
    const legSwing2 = Math.sin(this.legPhase + Math.PI) * 0.6;

    // Legs (drawn under body)
    ctx.strokeStyle = this.color;
    ctx.lineWidth = 1.6 * s;
    ctx.lineCap = 'round';
    const legPositions = [
      { y: -3 * s, swing: legSwing },
      { y: 0, swing: legSwing2 },
      { y: 3 * s, swing: legSwing }
    ];
    legPositions.forEach(lp => {
      // Left leg
      ctx.beginPath();
      ctx.moveTo(-2 * s, lp.y);
      ctx.quadraticCurveTo(-7 * s, lp.y + lp.swing * 2, -10 * s, lp.y + lp.swing * 4);
      ctx.stroke();
      // Right leg
      ctx.beginPath();
      ctx.moveTo(2 * s, lp.y);
      ctx.quadraticCurveTo(7 * s, lp.y - lp.swing * 2, 10 * s, lp.y - lp.swing * 4);
      ctx.stroke();
    });

    // Abdomen (rear)
    ctx.fillStyle = this.color;
    ctx.beginPath();
    ctx.ellipse(0, 6 * s, 5 * s, 7 * s, 0, 0, Math.PI * 2);
    ctx.fill();
    // Highlight
    ctx.fillStyle = this.bodyHighlight;
    ctx.beginPath();
    ctx.ellipse(-1.2 * s, 5 * s, 2 * s, 3.5 * s, 0, 0, Math.PI * 2);
    ctx.fill();

    // Thorax (middle)
    ctx.fillStyle = this.color;
    ctx.beginPath();
    ctx.ellipse(0, 0, 3.5 * s, 4 * s, 0, 0, Math.PI * 2);
    ctx.fill();

    // Head
    ctx.fillStyle = this.color;
    ctx.beginPath();
    ctx.ellipse(0, -6 * s, 4 * s, 4.5 * s, 0, 0, Math.PI * 2);
    ctx.fill();
    // Head highlight
    ctx.fillStyle = this.bodyHighlight;
    ctx.beginPath();
    ctx.ellipse(-1 * s, -6.5 * s, 1.4 * s, 2 * s, 0, 0, Math.PI * 2);
    ctx.fill();

    // Antennae
    ctx.strokeStyle = this.color;
    ctx.lineWidth = 1.3 * s;
    ctx.beginPath();
    ctx.moveTo(-1.5 * s, -8 * s);
    ctx.quadraticCurveTo(-3.5 * s, -11 * s, -3 * s, -13 * s);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(1.5 * s, -8 * s);
    ctx.quadraticCurveTo(3.5 * s, -11 * s, 3 * s, -13 * s);
    ctx.stroke();

    // Eyes (player only, distinguishing)
    if (this.isPlayer) {
      ctx.fillStyle = '#fff';
      ctx.beginPath();
      ctx.arc(-1.6 * s, -7 * s, 0.7 * s, 0, Math.PI * 2);
      ctx.arc(1.6 * s, -7 * s, 0.7 * s, 0, Math.PI * 2);
      ctx.fill();
    }

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
  }
}

// ---------- Food ----------
// ---------- Food ----------
const FOOD_DEFS = {
  small:  { required: 1,  eggs: 1,  size: 9,  color: '#caa37c', label: '小' },
  medium: { required: 3,  eggs: 4,  size: 16, color: '#5fa83a', label: '中' },
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
    // Spawn eggs (with risk-reward bonus from harsh terrain)
    const eggsToSpawn = Math.max(1, Math.round(this.eggs * (this.eggBonus || 1)));
    for (let i = 0; i < eggsToSpawn; i++) {
      const a = Math.random() * Math.PI * 2;
      const r = Math.random() * (EGG_ROOM_RADIUS - 15);
      game.eggs.push(new Egg(NEST_X + Math.cos(a) * r, NEST_Y + Math.sin(a) * r));
    }
    game.spawnDepositEffect(this.x, this.y);
    const bonusTxt = (this.eggBonus && this.eggBonus > 1.0)
      ? ` (✨ボーナス! +${eggsToSpawn - this.eggs})`
      : '';
    game.showMessage(`巣に運んだ！ 卵 +${eggsToSpawn}${bonusTxt}`, 'success');
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
    maxHp: 45, attackPower: 8, speed: 1.4, size: 16,
    detectRange: 140, attackRange: 28, attackCooldownMax: 1100,
    color: '#502050', headColor: '#3d1a3d', legColor: '#2a0d2a', markColor: '#7a307a'
  },
  beetle: {
    // Slow, tough, charges in straight line
    maxHp: 95, attackPower: 14, speed: 0.95, size: 20,
    detectRange: 160, attackRange: 32, attackCooldownMax: 1600,
    color: '#3a4a1a', headColor: '#1f2a10', legColor: '#1a1a0a', markColor: '#6a8a30'
  },
  wasp: {
    // Fast, fragile, hover-and-dive
    maxHp: 28, attackPower: 6, speed: 2.5, size: 13,
    detectRange: 200, attackRange: 22, attackCooldownMax: 800,
    color: '#e0b020', headColor: '#3a2a08', legColor: '#1a1408', markColor: '#1a1408'
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

    if (this.type === 'spider') {
      this.updateSpider(dt, game);
    } else if (this.type === 'beetle') {
      this.updateBeetle(dt, game);
    } else if (this.type === 'wasp') {
      this.updateWasp(dt, game);
    }

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
        this.moveToward(this.target, this.speed);
        moving = true;
      } else if (this.attackCooldown <= 0) {
        if (this.target.takeDamage) this.target.takeDamage(this.attackPower, game, this);
        this.attackCooldown = this.attackCooldownMax;
        game.spawnHitEffect(this.target.x, this.target.y);
      }
    } else {
      this.wander(dt);
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
          this.moveToward(this.target, this.speed);
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
          this.x = clamp(newX, 20, WORLD_WIDTH - 20);
          this.y = clamp(newY, 20, WORLD_HEIGHT - 20);
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
      this.wander(dt);
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
          this.x += tangentX * this.speed + radialX * this.speed;
          this.y += tangentY * this.speed + radialY * this.speed;
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
        this.x += nx;
        this.y += ny;
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
          this.x += (dx / m) * speed;
          this.y += (dy / m) * speed;
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
      this.wander(dt);
      moving = !!this.wanderTarget;
      this.behaviorState = 'approach';
    }
    this._moving = moving;
  }

  wander(dt) {
    this.wanderTimer -= dt;
    if (!this.wanderTarget || this.wanderTimer <= 0 ||
        dist(this, this.wanderTarget) < 10) {
      const a = Math.random() * Math.PI * 2;
      const r = rand(40, 140);
      this.wanderTarget = {
        x: clamp(this.startX + Math.cos(a) * r, 30, WORLD_WIDTH - 30),
        y: clamp(this.startY + Math.sin(a) * r, 30, WORLD_HEIGHT - 30)
      };
      this.wanderTimer = rand(2000, 4000);
    }
    if (this.wanderTarget && !inNest(this.wanderTarget.x, this.wanderTarget.y)) {
      this.moveToward(this.wanderTarget, this.speed * 0.55);
    }
  }

  moveToward(t, spd) {
    const dx = t.x - this.x;
    const dy = t.y - this.y;
    const d = Math.hypot(dx, dy);
    if (d > 0.5) {
      const eff = spd * (this._terrainSpeedMul || 1);
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
        this.x = newX;
        this.y = newY;
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
    } else if (this.type === 'beetle') {
      this.drawBeetle(ctx);
    } else if (this.type === 'wasp') {
      this.drawWasp(ctx);
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
const TERRAIN_TYPES = ['grass', 'pond', 'sand', 'mud', 'flower', 'leaves', 'concrete'];

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
const TERRAIN_DEFS = {
  grass:    { speed: 1.00, dpsOnGround:  0,   flyingImmune: false, footstepColor: null },
  pond:     { speed: 0.45, dpsOnGround:  1.5, flyingImmune: true,  footstepColor: '#a0d8ff' },
  sand:     { speed: 0.75, dpsOnGround:  0,   flyingImmune: false, footstepColor: '#e8c98a' },
  mud:      { speed: 0.55, dpsOnGround:  0.6, flyingImmune: false, footstepColor: '#5a3a1f' },
  flower:   { speed: 1.00, dpsOnGround: -0.2, flyingImmune: false, footstepColor: null },
  leaves:   { speed: 0.85, dpsOnGround:  0,   flyingImmune: false, footstepColor: '#b8742a' },
  concrete: { speed: 1.15, dpsOnGround:  0,   flyingImmune: false, footstepColor: null }
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
      const row = new Array(this.cols).fill('grass');
      this.tiles.push(row);
    }
    this.animPhase = 0;
  }

  // World-space coords → terrain type
  getAt(x, y) {
    const tx = Math.floor(x / this.tileSize);
    const ty = Math.floor(y / this.tileSize);
    if (ty < 0 || ty >= this.rows || tx < 0 || tx >= this.cols) return 'grass';
    return this.tiles[ty][tx];
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
    this.camera = { x: 0, y: 0 };
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
    this.raidTimer = 90000;  // first raid possible after ~90s
    this.raidActive = false;
    this.raidEnemies = [];
    this.unlockedBiomes = new Set();

    this.resize();
    window.addEventListener('resize', () => this.resize());
    window.addEventListener('orientationchange', () => setTimeout(() => this.resize(), 100));
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
    // Lots of grass tufts in the outside area
    for (let i = 0; i < 80; i++) {
      const x = rand(40, WORLD_WIDTH - 40);
      const y = rand(40, NEST_Y - NEST_RADIUS_BASE - 40);
      this.grassTufts.push(new GrassTuft(x, y, rand(0.7, 1.2)));
    }
    // Some around the nest
    for (let i = 0; i < 20; i++) {
      const a = Math.random() * Math.PI * 2;
      const r = rand(NEST_RADIUS_BASE + 30, NEST_RADIUS_BASE + 100);
      this.grassTufts.push(new GrassTuft(
        NEST_X + Math.cos(a) * r,
        NEST_Y + Math.sin(a) * r - 20,
        rand(0.7, 1)
      ));
    }
  }

  // Field expansion — appends a new biome region east of the current world.
  // Each expansion adds ~25% of the initial playable area, dedicated to one
  // biome type drawn from BIOME_SEQUENCE (cycling for later stages).
  expandWorld() {
    const oldWidth = WORLD_WIDTH;
    const newWidth = WORLD_WIDTH + WORLD_EXPAND_AMOUNT;
    WORLD_WIDTH = newWidth;
    this.expansionStage++;

    const biomeType = BIOME_SEQUENCE[(this.expansionStage - 1) % BIOME_SEQUENCE.length];
    const isFirstUnlock = !this.unlockedBiomes.has(biomeType);
    this.unlockedBiomes.add(biomeType);

    // Extend the terrain grid and fill the new east strip with this biome
    // (≈80% biome, ≈20% grass clearings).
    if (this.terrain) {
      this.terrain.extend(newWidth, WORLD_HEIGHT);
      this.terrain.fillBiome({
        x0: oldWidth - 10, y0: 40,
        x1: newWidth - 10,
        y1: NEST_Y - NEST_RADIUS_BASE - 40
      }, biomeType, 0.8);
    }

    // Add grass tufts in the new strip (skip dense biome cells visually).
    for (let i = 0; i < 12; i++) {
      const x = rand(oldWidth + 20, newWidth - 40);
      const y = rand(40, NEST_Y - NEST_RADIUS_BASE - 40);
      this.grassTufts.push(new GrassTuft(x, y, rand(0.7, 1.2)));
    }

    // Visual feedback + 2-line announcement: headline + biome-specific detail.
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

    // Sparkle particles along the new edge
    for (let i = 0; i < 24; i++) {
      const x = rand(oldWidth - 10, newWidth);
      const y = rand(40, NEST_Y - NEST_RADIUS_BASE - 40);
      this.particles.push(new Particle(x, y, rand(-0.5, 0.5), rand(-1.5, -0.5), rand(800, 1400), '#ffe680', rand(2, 3)));
    }

    // Welcome gift: drop a heart in the new region as a small reward.
    const giftX = oldWidth + WORLD_EXPAND_AMOUNT / 2;
    const giftY = clamp(NEST_Y - NEST_RADIUS_BASE - 100, 80, NEST_Y - NEST_RADIUS_BASE - 60);
    this.healItems.push(new HealItem(giftX, giftY));
  }

  // Begin a nest raid — a coordinated attack heading straight for the nest.
  startRaid() {
    if (this.raidActive) return;
    if (this.friends.filter(f => !f.dead).length < 10) return;
    const totalAnts = 1 + this.friends.length;
    // Squad size scales with colony
    const count = clamp(3 + Math.floor(totalAnts / 80), 3, 10);

    // Pick a random edge to spawn the formation
    const edge = Math.floor(Math.random() * 4);
    let baseX, baseY, dx, dy;
    if (edge === 0)      { baseX = rand(120, WORLD_WIDTH - 120); baseY = 60;             dx = 30; dy = 0;  }
    else if (edge === 1) { baseX = 60;                            baseY = rand(80, NEST_Y - NEST_RADIUS_BASE - 80); dx = 0; dy = 30; }
    else                 { baseX = WORLD_WIDTH - 60;              baseY = rand(80, NEST_Y - NEST_RADIUS_BASE - 80); dx = 0; dy = 30; }
    if (edge === 0) {} // top
    if (edge >= 3) { baseX = rand(120, WORLD_WIDTH - 120); baseY = NEST_Y - NEST_RADIUS_BASE - 60; dx = 30; dy = 0; }

    this.raidEnemies = [];
    for (let i = 0; i < count; i++) {
      const sx = clamp(baseX + (i - count / 2) * dx, 40, WORLD_WIDTH - 40);
      const sy = clamp(baseY + (i - count / 2) * dy, 40, WORLD_HEIGHT - 40);
      // Type mix: mostly spider, some beetle, occasional wasp
      const r = Math.random();
      const type = r < 0.6 ? 'spider' : r < 0.85 ? 'beetle' : 'wasp';
      const e = new Enemy(sx, sy, type, 1.0, true);
      this.enemies.push(e);
      this.raidEnemies.push(e);
    }
    this.raidActive = true;
    this.shakeTimer = 700;
    this.shakeMag = 4;
    this.raidWarningGiven = false;
    this.raidImminent = false;
    this.showMessage(`⚠️ 巣に敵が来る！ (${count}体)`, 'warn', 3500);
  }

  endRaid(success) {
    this.raidActive = false;
    this.raidEnemies = [];
    this.raidWarningGiven = false;
    this.raidImminent = false;
    if (success) {
      this.showMessage('🛡️ 巣を守った！ 回復アイテムが現れた！', 'success', 3000);
      // Spawn a heart bonus near the nest
      let x, y, attempts = 0;
      do {
        x = NEST_X + rand(-160, 160);
        y = NEST_Y - NEST_RADIUS_BASE - rand(20, 80);
        attempts++;
      } while ((y < 40 || x < 60 || x > WORLD_WIDTH - 60) && attempts < 8);
      if (attempts < 8) this.healItems.push(new HealItem(x, y));
    }
    // Schedule next raid
    this.raidTimer = rand(90000, 180000);
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

  startGame() {
    // Reset world dimensions in case of replay after expansion
    WORLD_WIDTH = 1400;
    WORLD_HEIGHT = 2000;
    NEST_X = WORLD_WIDTH / 2;
    NEST_Y = WORLD_HEIGHT - 220;

    this.player = new Ant(NEST_X, NEST_Y - 60, true);
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
    this.raidTimer = 90000;
    this.raidActive = false;
    this.raidEnemies = [];
    this.raidWarningGiven = false;
    this.raidImminent = false;
    // Call-window suspense: rises to 1.0 when calling friends, decays to 0 over ~5s.
    this.callStress = 0;
    // Set of biome types unlocked so far (drives enemy/food unlock gates).
    this.unlockedBiomes = new Set();
    // Initial terrain: pure grass. New biomes appear east as the colony grows.
    this.terrain = new TerrainGrid(WORLD_WIDTH, WORLD_HEIGHT);
    // Regenerate grass for the (reset) initial world
    this.generateGrass();
    // Initial food
    this.spawnInitialFoods();
    this.firstFoodSeen = false;
    this.firstEnemySeen = false;
    this.firstBigFoodSeen = false;
    this.firstHealSeen = false;
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
    const setupBtn = (btn, handler) => {
      btn.addEventListener('touchstart', (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (this.gameState !== 'playing') return;
        handler();
      }, { passive: false });
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        if (this.gameState !== 'playing') return;
        handler();
      });
    };
    setupBtn(document.getElementById('attackBtn'), () => this.playerAttack());
    setupBtn(document.getElementById('callBtn'), () => this.playerCallFriends());
  }

  setupUI() {
    document.getElementById('startBtn').addEventListener('click', () => {
      document.getElementById('startScreen').classList.add('hidden');
      this.startGame();
    });
    document.getElementById('playAgainBtn').addEventListener('click', () => {
      document.getElementById('winScreen').classList.add('hidden');
      this.startGame();
    });
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
      closest.takeDamage(this.player.attackPower, this, this.player);
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
    const MAX_NEW_CALLS = 12;
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
      const nearbyFriend = this.friends.find(f =>
        !f.dead && f.state === 'follow' && dist(f, food) < 36
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
  // Initial foods placed at the start of a fresh game: 5 small (1-carrier)
  // pieces fanned across the north hemisphere of the nest at two distances,
  // so the player always has plenty of easy targets visible on screen.
  spawnInitialFoods() {
    const placements = [
      { angleFrac: 0.10, r: NEST_RADIUS_BASE + 90  },
      { angleFrac: 0.30, r: NEST_RADIUS_BASE + 170 },
      { angleFrac: 0.50, r: NEST_RADIUS_BASE + 100 },
      { angleFrac: 0.70, r: NEST_RADIUS_BASE + 170 },
      { angleFrac: 0.90, r: NEST_RADIUS_BASE + 90  }
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
    const cap = MAX_FOODS + Math.min(8, Math.floor(this.friends.length / 100));
    if (this.foods.filter(f => !f.deposited).length >= cap) return;

    // Per-terrain spawn weight & sampling. Higher = more likely to keep this candidate.
    const FOOD_TERRAIN_WEIGHT = {
      grass: 1.0, pond: 0, sand: 0.6, mud: 0.4, flower: 2.5, leaves: 1.2, concrete: 0.5
    };

    // Early stages keep food close to the nest so the player can find easy
    // wins right away. The radius grows as the colony expands.
    const _stage = this.expansionStage;
    const maxFromNest = _stage === 0 ? 380
                      : _stage === 1 ? 580
                      : _stage === 2 ? 800
                      : Infinity;

    // Find a candidate position weighted by terrain. Reject pond cells.
    // Keep best-seen candidate so we always place something when possible.
    let x = 0, y = 0, terrainHere = 'grass', accepted = false;
    let bestX = 0, bestY = 0, bestTerrain = 'grass', haveBest = false;
    for (let attempt = 0; attempt < 14; attempt++) {
      x = rand(60, WORLD_WIDTH - 60);
      y = rand(60, NEST_Y - NEST_RADIUS_BASE - 60);
      const dn = Math.hypot(x - NEST_X, y - NEST_Y);
      if (dn < NEST_RADIUS_BASE + 80) continue;
      if (dn > maxFromNest) continue;
      terrainHere = this.terrain ? this.terrain.getAt(x, y) : 'grass';
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

    // Food types unlock with biome stages:
    //   stage 0  → small / medium
    //   stage 1+ → + large    (mud unlocked, 50 friends)
    //   stage 2+ → + huge     (pond unlocked, 100 friends)
    //   stage 3+ → + giant    (flower unlocked, 150 friends)
    const stage = this.expansionStage;
    let type;
    const r = Math.random();
    if (stage < 1) {
      type = r < 0.80 ? 'small' : 'medium';
    } else if (stage < 2) {
      type = r < 0.55 ? 'small' : r < 0.90 ? 'medium' : 'large';
    } else if (stage < 3) {
      type = r < 0.35 ? 'small' : r < 0.70 ? 'medium' : r < 0.92 ? 'large' : 'huge';
    } else if (stage < 5) {
      type = r < 0.25 ? 'small' : r < 0.50 ? 'medium' : r < 0.75 ? 'large' : r < 0.93 ? 'huge' : 'giant';
    } else {
      type = r < 0.18 ? 'small' : r < 0.38 ? 'medium' : r < 0.62 ? 'large' : r < 0.85 ? 'huge' : 'giant';
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
    // Slowly grow cap as colony grows: 4 → 12 over 1000 ants.
    return Math.min(12, MAX_ENEMIES + Math.floor(totalAnts / 125));
  }

  spawnEnemy() {
    if (this.enemies.filter(e => !e.dead).length >= this.getMaxEnemies()) return;

    let x = 0, y = 0, terrainHere = 'grass', accepted = false;
    let bestX = 0, bestY = 0, bestTerrain = 'grass', haveBest = false;
    for (let attempt = 0; attempt < 16; attempt++) {
      // Spawn near edges
      const edge = Math.floor(Math.random() * 4);
      if (edge === 0) { x = rand(60, WORLD_WIDTH - 60); y = rand(40, 100); }
      else if (edge === 1) { x = rand(60, WORLD_WIDTH - 60); y = rand(NEST_Y - NEST_RADIUS_BASE - 200, NEST_Y - NEST_RADIUS_BASE - 80); }
      else if (edge === 2) { x = rand(40, 120); y = rand(80, NEST_Y - NEST_RADIUS_BASE - 80); }
      else { x = rand(WORLD_WIDTH - 120, WORLD_WIDTH - 40); y = rand(80, NEST_Y - NEST_RADIUS_BASE - 80); }
      if (Math.hypot(x - NEST_X, y - NEST_Y) < NEST_RADIUS_BASE + 100) continue;
      if (this.player && dist({ x, y }, this.player) < 200) continue;
      terrainHere = this.terrain ? this.terrain.getAt(x, y) : 'grass';
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

    // Type unlocks are tied to biome unlocks: beetle on mud, wasp on pond.
    const hasMud = this.unlockedBiomes.has('mud');
    const hasPond = this.unlockedBiomes.has('pond');
    const r = Math.random();
    let type;
    if (!hasMud && !hasPond) {
      type = 'spider';
    } else if (hasMud && !hasPond) {
      type = r < 0.65 ? 'spider' : 'beetle';
    } else if (!hasMud && hasPond) {
      type = r < 0.65 ? 'spider' : 'wasp';
    } else {
      // Both unlocked — full variety. Proportions weighted by stage depth.
      if (this.expansionStage < 6) {
        type = r < 0.45 ? 'spider' : r < 0.75 ? 'wasp' : 'beetle';
      } else {
        type = r < 0.35 ? 'spider' : r < 0.65 ? 'wasp' : 'beetle';
      }
    }

    // Apply terrain bias only if the biased type is actually unlocked.
    if (cfg.bias && Math.random() < 0.5) {
      const biasOK =
        cfg.bias === 'spider' ||
        (cfg.bias === 'beetle' && hasMud) ||
        (cfg.bias === 'wasp'   && hasPond);
      if (biasOK) type = cfg.bias;
    }

    this.enemies.push(new Enemy(x, y, type, cfg.scale));
  }

  // Carry-time ambush spawn: place an enemy at a random angle from (cx, cy),
  // 90-160px away, outside the nest. Uses normal spawnEnemy logic for type
  // selection by calling spawnEnemy() against a temporarily-set bias point.
  _spawnAmbushNear(cx, cy) {
    let x = 0, y = 0, ok = false;
    for (let i = 0; i < 8; i++) {
      const a = Math.random() * Math.PI * 2;
      const r = rand(90, 160);
      x = clamp(cx + Math.cos(a) * r, 30, WORLD_WIDTH - 30);
      y = clamp(cy + Math.sin(a) * r, 30, NEST_Y - NEST_RADIUS_BASE - 30);
      if (Math.hypot(x - NEST_X, y - NEST_Y) < NEST_RADIUS_BASE + 60) continue;
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

  spawnHealItem() {
    if (this.healItems.length >= 2) return;
    let x, y, attempts = 0;
    do {
      x = rand(80, WORLD_WIDTH - 80);
      y = rand(80, NEST_Y - NEST_RADIUS_BASE - 60);
      attempts++;
    } while ((Math.hypot(x - NEST_X, y - NEST_Y) < NEST_RADIUS_BASE + 100) && attempts < 10);
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
    this.player.invuln = 1500;
    this.player.state = 'player';
    this.gameState = 'playing';
    document.getElementById('deathScreen').classList.add('hidden');
    this.showMessage('もう一度がんばろう！', 'success', 2000);
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

    // Update entities
    this.player.update(dt, this);
    this.friends.forEach(f => f.update(dt, this));
    this.enemies.forEach(e => e.update(dt, this));
    this.foods.forEach(f => f.update(dt, this));
    this.eggs.forEach(eg => eg.update(dt));
    this.healItems.forEach(h => h.update(dt));
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
        const friendsTxt = friendsHealed > 0 ? ` 仲間${friendsHealed}匹も回復` : '';
        this.showMessage(`💖 HP +${healed}!${friendsTxt}`, 'success', 1800);
      }
    });

    // Player deposit when entering egg room while carrying
    if (this.player.carrying && inEggRoom(this.player.x, this.player.y) && !this.player.carrying.deposited) {
      this.player.carrying.deposit(this);
      this.player.carrying = null;
    }

    // Process eggs
    this.eggs = this.eggs.filter(eg => {
      if (eg.dead) return false;
      if (eg.hatched) {
        // Hatch into friend ant
        const newAnt = new Ant(eg.x, eg.y, false);
        newAnt.state = 'idle';
        this.friends.push(newAnt);
        this.spawnHatchEffect(eg.x, eg.y);
        return false;
      }
      return true;
    });

    // Remove dead/expired things
    this.enemies = this.enemies.filter(e => !e.dead);
    this.foods = this.foods.filter(f => !f.deposited);
    this.friends = this.friends.filter(f => !f.dead);
    this.healItems = this.healItems.filter(i => !i.collected);
    this.particles = this.particles.filter(p => !p.dead);
    this.damageNumbers = this.damageNumbers.filter(d => !d.dead);

    // Spawning
    this.foodSpawnTimer -= dt;
    if (this.foodSpawnTimer <= 0) {
      this.spawnFood();
      // Spawn an extra food at higher colony sizes to keep the pace.
      if (this.friends.length >= 200 && Math.random() < 0.5) this.spawnFood();
      const floor = this.friends.length >= 300 ? 2000 : this.friends.length >= 100 ? 2800 : 3500;
      const baseInterval = Math.max(floor, 8000 - this.friends.length * 50);
      this.foodSpawnTimer = baseInterval + rand(0, 3000);
    }
    // Decay call-stress over ~5s after a call.
    if (this.callStress > 0) this.callStress = Math.max(0, this.callStress - dt / 5000);

    // Enemy spawn timer ticks faster while call stress is active (raid pause kept normal).
    const stressMul = this.raidActive ? 1 : 1 + this.callStress;
    this.enemySpawnTimer -= dt * stressMul;
    if (this.enemySpawnTimer <= 0) {
      this.spawnEnemy();
      const totalAnts = 1 + this.friends.length;
      const baseInt = Math.max(7000, 18000 - totalAnts * 100);
      this.enemySpawnTimer = baseInt + rand(0, 5000);
      if (!this.firstEnemySeen) {
        this.firstEnemySeen = true;
        setTimeout(() => this.showMessage('敵だ！攻撃か仲間を呼ぼう！', 'warn', 3000), 500);
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
          this.raidWarningGiven = true;
        }
        if (!this.raidImminent && this.raidTimer < 3000 && this.raidTimer > 0) {
          this.showMessage('⚠️ もうすぐ襲撃!', 'warn', 2500);
          this.raidImminent = true;
        }
      }
      if (this.raidTimer <= 0) {
        this.startRaid();
        if (!this.raidActive) {
          // Failed precondition — try again later
          this.raidTimer = rand(40000, 60000);
          this.raidWarningGiven = false;
          this.raidImminent = false;
        }
      }
    } else {
      // Drop any dead raiders from tracking; if all dead → success
      this.raidEnemies = this.raidEnemies.filter(e => !e.dead);
      if (this.raidEnemies.length === 0) {
        this.endRaid(true);
      }
    }

    // Update camera
    const targetCx = this.player.x - this.viewW / 2;
    const targetCy = this.player.y - this.viewH / 2;
    this.camera.x = lerp(this.camera.x, clamp(targetCx, 0, WORLD_WIDTH - this.viewW), 0.12);
    this.camera.y = lerp(this.camera.y, clamp(targetCy, 0, WORLD_HEIGHT - this.viewH), 0.12);

    // Update HUD
    const total = 1 + this.friends.length;
    const stageLabel = this.expansionStage > 0 ? ` 🌍${this.expansionStage}` : '';
    document.getElementById('antCount').textContent = `🐜 ${total} / ${WIN_ANT_COUNT}${stageLabel}`;
    const hpFill = document.getElementById('hpFill');
    const hpRatio = this.player.hp / this.player.maxHp;
    hpFill.style.width = (hpRatio * 100) + '%';
    hpFill.className = hpRatio > 0.6 ? 'high' : hpRatio > 0.3 ? 'medium' : '';

    // Field expansion check (every EXPANSION_THRESHOLD friends)
    const expectedStage = Math.min(MAX_EXPANSION_STAGE, Math.floor(total / EXPANSION_THRESHOLD));
    while (expectedStage > this.expansionStage && total < WIN_ANT_COUNT) {
      this.expandWorld();
    }

    // Win check
    if (total >= WIN_ANT_COUNT) {
      this.gameState = 'won';
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
    ctx.translate(-this.camera.x + shakeX, -this.camera.y + shakeY);

    this.drawBackground(ctx);
    this.drawNest(ctx);

    // Draw grass tufts
    this.grassTufts.forEach(g => g.draw(ctx, this.time));

    // Draw eggs (under ants)
    this.eggs.forEach(e => e.draw(ctx));

    // Draw uncarried foods (below ants)
    this.foods.forEach(f => { if (!f.beingCarried) f.draw(ctx); });

    // Draw heal items
    this.healItems.forEach(h => h.draw(ctx));

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
    drawables.forEach(d => d.draw(ctx));

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
    // Outside grass area
    const grad = ctx.createLinearGradient(0, 0, 0, WORLD_HEIGHT);
    grad.addColorStop(0, '#4d8a32');
    grad.addColorStop(0.6, '#5a9b3a');
    grad.addColorStop(0.85, '#6d7530');
    grad.addColorStop(1, '#8a6a3a');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, WORLD_WIDTH, WORLD_HEIGHT);

    // Texture dots (small specks for grass detail)
    ctx.fillStyle = 'rgba(60, 110, 50, 0.25)';
    const cx0 = Math.max(0, Math.floor(this.camera.x / 50) * 50);
    const cy0 = Math.max(0, Math.floor(this.camera.y / 50) * 50);
    const cx1 = Math.min(WORLD_WIDTH, this.camera.x + this.viewW + 50);
    const cy1 = Math.min(WORLD_HEIGHT, this.camera.y + this.viewH + 50);
    for (let x = cx0; x < cx1; x += 50) {
      for (let y = cy0; y < cy1; y += 50) {
        // pseudo-random but stable speck positions
        const seed = (x * 7919 + y * 6857) % 1000;
        const sx = x + (seed % 50);
        const sy = y + ((seed * 13) % 50);
        ctx.fillRect(sx, sy, 2, 2);
      }
    }

    // Terrain patches on top of base grass
    if (this.terrain) {
      this.terrain.draw(ctx, this.camera.x, this.camera.y, this.viewW, this.viewH);
    }

    // World boundary
    ctx.strokeStyle = 'rgba(0,0,0,0.2)';
    ctx.lineWidth = 4;
    ctx.strokeRect(0, 0, WORLD_WIDTH, WORLD_HEIGHT);
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
