/* ====================================================================
   アント (ANT) - One-handed mobile commute game
   ==================================================================== */

// ---------- Constants ----------
const WORLD_WIDTH = 1400;
const WORLD_HEIGHT = 2000;

const NEST_X = WORLD_WIDTH / 2;
const NEST_Y = WORLD_HEIGHT - 220;
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
const EXPANSION_THRESHOLD = 100;  // every N allies a new biome unlocks

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
        this.target.takeDamage(this.attackPower, game, this);
        this.attackCooldown = 700;
        game.spawnHitEffect(this.target.x, this.target.y);
      }
      this._moving = moving;
      return;
    } else if (this.state === 'attacking') {
      // Target dead or gone
      this.state = 'follow';
      this.target = null;
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

      // Auto-defend: if a nearby enemy is targeting us or close, fight
      const enemy = game.findClosestEnemy(this.x, this.y, 100);
      if (enemy && (enemy.target === this || dist(this, enemy) < 60)) {
        this.state = 'attacking';
        this.target = enemy;
      }

      // Follow times out — go back to idle
      if (this.callTimer <= 0 && d < 80) {
        this.state = 'idle';
      }

      this._moving = moving;
      return;
    }

    // idle: wander near nest
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
      this.x += (dx / d) * spd;
      this.y += (dy / d) * spd;
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
  giant:  { required: 12, eggs: 18, size: 42, color: '#e07ab0', label: '超特大' }
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
    // Spawn eggs
    for (let i = 0; i < this.eggs; i++) {
      const a = Math.random() * Math.PI * 2;
      const r = Math.random() * (EGG_ROOM_RADIUS - 15);
      game.eggs.push(new Egg(NEST_X + Math.cos(a) * r, NEST_Y + Math.sin(a) * r));
    }
    game.spawnDepositEffect(this.x, this.y);
    game.showMessage(`巣に運んだ！ 卵 +${this.eggs}`, 'success');
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
  }

  update(dt) {
    this.timer -= dt;
    this.wobble += dt * 0.005;
    if (this.timer <= 0) this.hatched = true;
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
  constructor(x, y, type = 'spider') {
    this.x = x;
    this.y = y;
    this.startX = x;
    this.startY = y;
    this.type = type;
    const def = ENEMY_DEFS[type] || ENEMY_DEFS.spider;
    this.maxHp = def.maxHp;
    this.hp = this.maxHp;
    this.attackPower = def.attackPower;
    this.speed = def.speed;
    this.size = def.size;
    this.detectRange = def.detectRange;
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

    // Lose target if it enters nest or gets too far
    if (this.target && (this.target.dead || inNest(this.target.x, this.target.y) ||
        dist(this, this.target) > this.detectRange * 2.5)) {
      this.target = null;
      this.behaviorState = 'approach';
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
        this.target.takeDamage(this.attackPower, game, this);
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
        if (!inNest(newX, newY)) {
          this.x = clamp(newX, 20, WORLD_WIDTH - 20);
          this.y = clamp(newY, 20, WORLD_HEIGHT - 20);
        }
        moving = true;
        // Hit detection vs target and other ants in path
        const allAnts = [game.player, ...game.friends];
        for (const a of allAnts) {
          if (a.dead || inNest(a.x, a.y)) continue;
          if (dist(this, a) < 24) {
            a.takeDamage(this.attackPower, game, this);
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
          this.target.takeDamage(this.attackPower, game, this);
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
      const nx = (dx / d) * spd;
      const ny = (dy / d) * spd;
      const newX = this.x + nx;
      const newY = this.y + ny;
      if (inNest(newX, newY)) {
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
      game.spawnEnemyDeath(this.x, this.y);
    } else if (attacker) {
      this.target = attacker;
    }
  }

  draw(ctx) {
    if (this.dead) return;
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

  startGame() {
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
    // Initial food
    this.spawnFood();
    this.spawnFood();
    this.spawnFood();
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
    // Bring nearby idle friends and even those wandering far
    let called = 0;
    this.friends.forEach(f => {
      if (f.dead) return;
      if (f.state === 'carrying') return;
      if (called >= 8) return;
      f.state = 'follow';
      f.target = null;
      f.callTimer = 12000;
      called++;
    });
    if (called > 0) {
      this.spawnCallEffect();
      this.showMessage(`仲間 ${called}匹を呼んだ！`, 'success', 1200);
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
  spawnFood() {
    if (this.foods.filter(f => !f.deposited).length >= MAX_FOODS) return;
    let x, y, attempts = 0;
    do {
      x = rand(60, WORLD_WIDTH - 60);
      y = rand(60, NEST_Y - NEST_RADIUS_BASE - 60);
      attempts++;
    } while ((Math.hypot(x - NEST_X, y - NEST_Y) < NEST_RADIUS_BASE + 80) && attempts < 10);

    // Progressive variety based on colony size
    const totalAnts = 1 + this.friends.filter(f => !f.dead).length;
    let type;
    const r = Math.random();
    if (totalAnts < 4) {
      // Almost only small at the start
      type = r < 0.85 ? 'small' : 'medium';
    } else if (totalAnts < 10) {
      type = r < 0.55 ? 'small' : r < 0.90 ? 'medium' : 'large';
    } else if (totalAnts < 20) {
      type = r < 0.35 ? 'small' : r < 0.70 ? 'medium' : r < 0.92 ? 'large' : 'huge';
    } else if (totalAnts < 40) {
      type = r < 0.25 ? 'small' : r < 0.50 ? 'medium' : r < 0.75 ? 'large' : r < 0.93 ? 'huge' : 'giant';
    } else {
      type = r < 0.18 ? 'small' : r < 0.38 ? 'medium' : r < 0.62 ? 'large' : r < 0.85 ? 'huge' : 'giant';
    }

    this.foods.push(new Food(x, y, type));
  }

  spawnEnemy() {
    if (this.enemies.filter(e => !e.dead).length >= MAX_ENEMIES) return;
    let x, y, attempts = 0;
    do {
      // Spawn near edges
      const edge = Math.floor(Math.random() * 4);
      if (edge === 0) { x = rand(60, WORLD_WIDTH - 60); y = rand(40, 100); }
      else if (edge === 1) { x = rand(60, WORLD_WIDTH - 60); y = rand(NEST_Y - NEST_RADIUS_BASE - 200, NEST_Y - NEST_RADIUS_BASE - 80); }
      else if (edge === 2) { x = rand(40, 120); y = rand(80, NEST_Y - NEST_RADIUS_BASE - 80); }
      else { x = rand(WORLD_WIDTH - 120, WORLD_WIDTH - 40); y = rand(80, NEST_Y - NEST_RADIUS_BASE - 80); }
      attempts++;
    } while ((Math.hypot(x - NEST_X, y - NEST_Y) < NEST_RADIUS_BASE + 100 ||
              dist({ x, y }, this.player) < 200) && attempts < 10);

    // Progressive enemy variety
    const totalAnts = 1 + this.friends.filter(f => !f.dead).length;
    let type;
    const r = Math.random();
    if (totalAnts < 6) {
      type = 'spider';
    } else if (totalAnts < 15) {
      type = r < 0.65 ? 'spider' : r < 0.90 ? 'wasp' : 'beetle';
    } else if (totalAnts < 30) {
      type = r < 0.45 ? 'spider' : r < 0.75 ? 'wasp' : 'beetle';
    } else {
      type = r < 0.35 ? 'spider' : r < 0.65 ? 'wasp' : 'beetle';
    }
    this.enemies.push(new Enemy(x, y, type));
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
  spawnEnemyDeath(x, y) {
    for (let i = 0; i < 14; i++) {
      const a = Math.random() * Math.PI * 2;
      const s = rand(2, 6);
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
      const baseInterval = Math.max(3500, 8000 - this.friends.length * 50);
      this.foodSpawnTimer = baseInterval + rand(0, 3000);
    }
    this.enemySpawnTimer -= dt;
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
    this.healSpawnTimer -= dt;
    if (this.healSpawnTimer <= 0) {
      this.spawnHealItem();
      this.healSpawnTimer = 22000 + rand(0, 12000);
      if (!this.firstHealSeen && this.healItems.length > 0) {
        this.firstHealSeen = true;
        setTimeout(() => this.showMessage('💖 ハートはHP回復アイテム', '', 3000), 800);
      }
    }

    // Update camera
    const targetCx = this.player.x - this.viewW / 2;
    const targetCy = this.player.y - this.viewH / 2;
    this.camera.x = lerp(this.camera.x, clamp(targetCx, 0, WORLD_WIDTH - this.viewW), 0.12);
    this.camera.y = lerp(this.camera.y, clamp(targetCy, 0, WORLD_HEIGHT - this.viewH), 0.12);

    // Update HUD
    const total = 1 + this.friends.length;
    document.getElementById('antCount').textContent = `🐜 ${total} / ${WIN_ANT_COUNT}`;
    const hpFill = document.getElementById('hpFill');
    const hpRatio = this.player.hp / this.player.maxHp;
    hpFill.style.width = (hpRatio * 100) + '%';
    hpFill.className = hpRatio > 0.6 ? 'high' : hpRatio > 0.3 ? 'medium' : '';

    // Win check
    if (total >= WIN_ANT_COUNT) {
      this.gameState = 'won';
      document.getElementById('winScreen').classList.remove('hidden');
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
    ctx.save();
    ctx.translate(-this.camera.x, -this.camera.y);

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

    // Draw all ants and enemies sorted by Y
    const drawables = [];
    if (this.player) drawables.push(this.player);
    this.friends.forEach(f => drawables.push(f));
    this.enemies.forEach(e => drawables.push(e));
    drawables.sort((a, b) => a.y - b.y);
    drawables.forEach(d => d.draw(ctx));

    // Draw carried foods (above ants — visible on top of carriers)
    this.foods.forEach(f => { if (f.beingCarried) f.draw(ctx); });

    // Particles
    this.particles.forEach(p => p.draw(ctx));
    this.damageNumbers.forEach(d => d.draw(ctx));

    // Optional: world bounds indicator
    ctx.restore();

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
