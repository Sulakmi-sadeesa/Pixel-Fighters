(() => {
  'use strict';

  const canvas = document.getElementById('game');
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = false;

  const W = canvas.width;
  const H = canvas.height;

  const GROUND_Y = 460;
  const GRAVITY = 0.85;
  const MOVE_SPEED = 4.2;
  const JUMP_POWER = -15;
  const FRICTION = 0.78;

  const ROUND_TIME = 60;
  const ROUNDS_TO_WIN = 2;

  const $ = (id) => document.getElementById(id);

  const startScreen = $('startScreen');
  const roundScreen = $('roundScreen');
  const endScreen = $('endScreen');
  const roundText = $('roundText');
  const roundSub = $('roundSub');
  const endTitle = $('endTitle');
  const endSub = $('endSub');

  const keys = {};
  let state = 'menu';
  let mode = 'cpu';
  let matchState = 'idle';

  let p1, p2;
  let roundNumber = 1;
  let p1Rounds = 0;
  let p2Rounds = 0;
  let roundTimer = ROUND_TIME;
  let timerAccum = 0;
  let hitSparks = [];

  // ---------- Audio ----------
  const audioCtx = (() => {
    let a = null;
    return {
      get() {
        if (!a) {
          try { a = new (window.AudioContext || window.webkitAudioContext)(); }
          catch (e) { a = null; }
        }
        if (a && a.state === 'suspended') a.resume();
        return a;
      }
    };
  })();

  function beep(freq, duration, type = 'square', volume = 0.08) {
    const ac = audioCtx.get();
    if (!ac) return;
    const osc = ac.createOscillator();
    const gain = ac.createGain();
    osc.type = type;
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(volume, ac.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ac.currentTime + duration);
    osc.connect(gain);
    gain.connect(ac.destination);
    osc.start();
    osc.stop(ac.currentTime + duration);
  }

  function sfxHitLight() { beep(320, 0.08, 'square', 0.09); }
  function sfxHitHeavy() { beep(180, 0.16, 'sawtooth', 0.12); setTimeout(() => beep(90, 0.2, 'sawtooth', 0.1), 60); }
  function sfxBlock() { beep(520, 0.06, 'square', 0.06); }
  function sfxJump() { beep(440, 0.1, 'square', 0.05); setTimeout(() => beep(660, 0.09, 'square', 0.04), 50); }
  function sfxRound() { [523, 659, 784].forEach((f, i) => setTimeout(() => beep(f, 0.15, 'square', 0.08), i * 100)); }
  function sfxFight() { beep(880, 0.2, 'square', 0.1); }
  function sfxKO() { [220, 180, 140].forEach((f, i) => setTimeout(() => beep(f, 0.3, 'sawtooth', 0.12), i * 150)); }

  // ---------- Fighter ----------
  const ATTACKS = {
    light:  { startup: 4, active: 3, recovery: 6,  damage: 6,  reach: 55, height: 22, knockback: 3, hitstun: 12, sfx: 'light' },
    heavy:  { startup: 8, active: 5, recovery: 14, damage: 14, reach: 70, height: 30, knockback: 8, hitstun: 22, sfx: 'heavy' }
  };

  class Fighter {
    constructor(opts) {
      this.name = opts.name;
      this.color = opts.color;
      this.accentColor = opts.accentColor;
      this.controls = opts.controls;
      this.isCPU = !!opts.isCPU;
      this.x = opts.x;
      this.y = GROUND_Y;
      this.vx = 0;
      this.vy = 0;
      this.w = 60;
      this.h = 110;
      this.facing = opts.facing;
      this.onGround = true;
      this.crouching = false;
      this.blocking = false;
      this.health = 100;
      this.maxHealth = 100;
      this.attack = null;       // {type, data, timer, hasHit}
      this.hitstun = 0;
      this.blockstun = 0;
      this.hurtFlash = 0;
      this.animTimer = 0;
    }

    get left() { return this.x - this.w / 2; }
    get right() { return this.x + this.w / 2; }
    get top() { return this.y - this.h; }
    get bottom() { return this.y; }

    getBox() {
      const h = this.crouching ? this.h * 0.65 : this.h;
      return {
        left: this.x - this.w / 2,
        right: this.x + this.w / 2,
        top: this.y - h,
        bottom: this.y
      };
    }

    getAttackBox() {
      if (!this.attack) return null;
      const d = this.attack.data;
      const cx = this.facing === 1 ? this.x + this.w / 2 : this.x - this.w / 2 - d.reach;
      return {
        left: cx,
        right: cx + d.reach,
        top: this.y - this.h * 0.7,
        bottom: this.y - this.h * 0.7 + d.height
      };
    }

    update(opponent, input) {
      if (this.hurtFlash > 0) this.hurtFlash--;
      this.animTimer++;

      // Hitstun freezes control
      if (this.hitstun > 0) {
        this.hitstun--;
        this.applyPhysics(opponent);
        return;
      }
      if (this.blockstun > 0) {
        this.blockstun--;
        this.applyPhysics(opponent);
        return;
      }

      // Advance attack timeline
      if (this.attack) {
        this.attack.timer--;
        if (this.attack.timer <= 0) this.attack = null;
      }

      // Auto-face opponent
      if (this.attack === null) {
        this.facing = opponent.x > this.x ? 1 : -1;
      }

      // ----- Input handling -----
      this.crouching = false;
      this.blocking = false;

      const onGround = this.onGround;

      // Crouch (ground only, no attack)
      if (input.down && onGround && !this.attack) {
        this.crouching = true;
      }

      // Horizontal movement (blocked while attacking on ground)
      let moving = false;
      if (!this.crouching && (!this.attack || !onGround)) {
        if (input.left)  { this.vx = -MOVE_SPEED; moving = true; }
        if (input.right) { this.vx = MOVE_SPEED; moving = true; }
      }

      // Block: holding back while grounded and not attacking
      if (!this.attack && onGround && !moving) {
        // no auto block here; handled below
      }
      const holdingBack =
        (this.facing === 1 && input.left) ||
        (this.facing === -1 && input.right);
      if (holdingBack && onGround && !this.attack && !this.crouching) {
        this.blocking = true;
      }

      if (!input.left && !input.right) this.vx *= FRICTION;

      // Jump
      if (input.up && onGround && !this.crouching) {
        this.vy = JUMP_POWER;
        this.onGround = false;
        if (!this.isCPU) sfxJump();
      }

      // Attack
      if (!this.attack && !this.crouching && (input.light || input.heavy)) {
        const type = input.heavy ? 'heavy' : 'light';
        const d = ATTACKS[type];
        this.attack = {
          type,
          data: d,
          timer: d.startup + d.active + d.recovery,
          phase: 'startup',
          startupLeft: d.startup,
          activeLeft: 0,
          hasHit: false
        };
      }

      this.applyPhysics(opponent);
    }

    applyPhysics(opponent) {
      this.x += this.vx;
      this.y += this.vy;

      if (!this.onGround || this.y < GROUND_Y) {
        this.vy += GRAVITY;
      }

      if (this.y >= GROUND_Y) {
        this.y = GROUND_Y;
        this.vy = 0;
        this.onGround = true;
      } else {
        this.onGround = false;
      }

      // Keep fighters apart (simple body push)
      const minDist = (this.w + opponent.w) / 2 - 6;
      const dx = opponent.x - this.x;
      if (Math.abs(dx) < minDist && Math.abs(this.y - opponent.y) < 60) {
        const push = (minDist - Math.abs(dx)) / 2;
        if (dx > 0) { this.x -= push; opponent.x += push; }
        else { this.x += push; opponent.x -= push; }
      }

      // Arena bounds
      const HALF = this.w / 2;
      if (this.x < HALF) this.x = HALF;
      if (this.x > W - HALF) this.x = W - HALF;
    }

    updateAttackPhase() {
      if (!this.attack) return;
      const a = this.attack;
      if (a.startupLeft > 0) {
        a.startupLeft--;
        if (a.startupLeft === 0) a.activeLeft = a.data.active;
      } else if (a.activeLeft > 0) {
        a.activeLeft--;
      }
    }

    takeHit(damage, knockback, hitstun, blocked) {
      if (blocked) {
        const chip = Math.max(1, Math.floor(damage * 0.15));
        this.health -= chip;
        this.blockstun = 8;
        this.vx = -this.facing * knockback * 0.4;
        sfxBlock();
        spawnSpark(this.x + this.facing * 40, this.y - this.h * 0.7, '#88aaff', 6);
      } else {
        this.health -= damage;
        this.hitstun = hitstun;
        this.hurtFlash = 6;
        this.vx = -this.facing * knockback;
        if (!this.onGround) this.vy -= 4;
        spawnSpark(this.x + this.facing * 30, this.y - this.h * 0.7, '#ffcc44', 12);
        if (damage >= 12) sfxHitHeavy(); else sfxHitLight();
      }
      if (this.health < 0) this.health = 0;
    }

    draw() {
      const bodyH = this.crouching ? this.h * 0.65 : this.h;
      const x = this.x;
      const y = this.y;

      // Shadow
      ctx.fillStyle = 'rgba(0,0,0,0.4)';
      ctx.beginPath();
      ctx.ellipse(x, GROUND_Y + 4, 30, 8, 0, 0, Math.PI * 2);
      ctx.fill();

      const flash = this.hurtFlash > 0 && Math.floor(this.hurtFlash / 2) % 2 === 0;
      const bodyColor = flash ? '#ffffff' : this.color;
      const accent = flash ? '#ffffff' : this.accentColor;

      // Legs
      ctx.fillStyle = accent;
      const legOffset = this.attack ? 0 : (Math.sin(this.animTimer * 0.15) * 3);
      ctx.fillRect(x - 18, y - 30, 14, 30 + legOffset);
      ctx.fillRect(x + 4,  y - 30, 14, 30 - legOffset);

      // Body
      ctx.fillStyle = bodyColor;
      ctx.fillRect(x - 20, y - bodyH + 20, 40, bodyH - 50);

      // Chest stripe
      ctx.fillStyle = accent;
      ctx.fillRect(x - 20, y - bodyH + 30, 40, 6);

      // Head
      ctx.fillStyle = bodyColor;
      ctx.fillRect(x - 16, y - bodyH, 32, 28);
      ctx.fillStyle = accent;
      ctx.fillRect(x - 16, y - bodyH, 32, 5);

      // Eye
      ctx.fillStyle = '#fff';
      const eyeX = this.facing === 1 ? x + 4 : x - 10;
      ctx.fillRect(eyeX, y - bodyH + 10, 6, 6);
      ctx.fillStyle = '#1a1a2e';
      ctx.fillRect(eyeX + (this.facing === 1 ? 2 : 0), y - bodyH + 12, 3, 3);

      // Arm / attack pose
      ctx.fillStyle = accent;
      if (this.attack && this.attack.activeLeft > 0) {
        const a = this.attack;
        const armLen = a.data.reach;
        const armY = y - bodyH + (a.type === 'heavy' ? 30 : 42);
        const armX = this.facing === 1 ? x + 20 : x - 20 - armLen;
        ctx.fillRect(armX, armY, armLen, 12);
        // Fist
        ctx.fillStyle = '#fff';
        const fistX = this.facing === 1 ? x + 20 + armLen - 6 : x - 20 - armLen;
        ctx.fillRect(fistX, armY - 2, 14, 16);
      } else {
        // Idle arms
        ctx.fillRect(x - 24, y - bodyH + 40, 8, 24);
        ctx.fillRect(x + 16, y - bodyH + 40, 8, 24);
      }

      // Blocking shield hint
      if (this.blocking) {
        ctx.strokeStyle = 'rgba(136,170,255,0.8)';
        ctx.lineWidth = 3;
        ctx.beginPath();
        const shieldX = this.facing === 1 ? x - 34 : x + 34;
        ctx.arc(shieldX, y - bodyH / 2, 40, -Math.PI / 2, Math.PI / 2, this.facing !== 1);
        ctx.stroke();
      }

      // Attack hitbox debug (uncomment to visualize):
      // const ab = this.getAttackBox();
      // if (ab) { ctx.strokeStyle = 'red'; ctx.strokeRect(ab.left, ab.top, ab.right-ab.left, ab.bottom-ab.top); }
    }
  }

  // ---------- CPU AI ----------
  function cpuInput(me, foe) {
    const input = { left: false, right: false, up: false, down: false, light: false, heavy: false };
    if (matchState !== 'fighting') return input;

    const dx = foe.x - me.x;
    const dist = Math.abs(dx);
    const toward = dx > 0 ? 'right' : 'left';
    const away = dx > 0 ? 'left' : 'right';

    // Simple state machine with a bit of randomness
    if (Math.random() < 0.02) me._cpuMode = ['approach','attack','retreat','wait'][Math.floor(Math.random()*4)];
    if (!me._cpuMode) me._cpuMode = 'approach';

    // React to opponent attacking
    const foeAttacking = foe.attack && foe.attack.activeLeft > 0;
    if (foeAttacking && dist < 100 && Math.random() < 0.7) {
      input[away] = true;   // hold back to block
    } else if (me._cpuMode === 'approach') {
      if (dist > 90) input[toward] = true;
      else me._cpuMode = 'attack';
    } else if (me._cpuMode === 'attack') {
      if (dist < 90) {
        if (Math.random() < 0.05) input.heavy = true;
        else if (Math.random() < 0.15) input.light = true;
      } else {
        input[toward] = true;
      }
      if (Math.random() < 0.02) me._cpuMode = 'approach';
    } else if (me._cpuMode === 'retreat') {
      input[away] = true;
      if (Math.random() < 0.03) me._cpuMode = 'approach';
    } else {
      // wait: occasionally jump or block
      if (Math.random() < 0.01) input.up = true;
    }
    return input;
  }

  // ---------- Input reading ----------
  function readP1Input() {
    return {
      left:  !!(keys['a'] || keys['A']),
      right: !!(keys['d'] || keys['D']),
      up:    !!(keys['w'] || keys['W']),
      down:  !!(keys['s'] || keys['S']),
      light: !!(keys['f'] || keys['F']),
      heavy: !!(keys['g'] || keys['G'])
    };
  }

  function readP2Input() {
    return {
      left:  !!keys['ArrowLeft'],
      right: !!keys['ArrowRight'],
      up:    !!keys['ArrowUp'],
      down:  !!keys['ArrowDown'],
      light: !!(keys['k'] || keys['K']),
      heavy: !!(keys['l'] || keys['L'])
    };
  }

  // ---------- Hit detection ----------
  function checkAttack(attacker, defender) {
    if (!attacker.attack) return;
    const a = attacker.attack;
    if (a.activeLeft <= 0) return;
    if (a.hasHit) return;

    const ab = attacker.getAttackBox();
    const db = defender.getBox();
    if (!ab) return;

    const overlaps = ab.left < db.right && ab.right > db.left &&
                     ab.top < db.bottom && ab.bottom > db.top;
    if (!overlaps) return;

    // Determine block
    const facingAwayFromAttacker = (defender.facing === -1 && attacker.x > defender.x) ||
                                   (defender.facing === 1 && attacker.x < defender.x);
    const attackerInFront = (defender.facing === 1 && attacker.x > defender.x) ||
                            (defender.facing === -1 && attacker.x < defender.x);
    const blocked = defender.blocking && attackerInFront;

    defender.takeHit(a.data.damage, a.data.knockback, a.data.hitstun, blocked);
    a.hasHit = true;
  }

  // ---------- Sparks ----------
  function spawnSpark(x, y, color, count) {
    for (let i = 0; i < count; i++) {
      const angle = Math.random() * Math.PI * 2;
      const speed = 1 + Math.random() * 5;
      hitSparks.push({
        x, y,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed - 1,
        life: 20 + Math.random() * 15,
        maxLife: 35,
        color,
        size: 2 + Math.random() * 4
      });
    }
  }

  function updateSparks() {
    for (let i = hitSparks.length - 1; i >= 0; i--) {
      const s = hitSparks[i];
      s.x += s.vx;
      s.y += s.vy;
      s.vy += 0.3;
      s.vx *= 0.96;
      s.life--;
      if (s.life <= 0) hitSparks.splice(i, 1);
    }
  }

  function drawSparks() {
    for (const s of hitSparks) {
      ctx.globalAlpha = Math.max(0, s.life / s.maxLife);
      ctx.fillStyle = s.color;
      ctx.fillRect(Math.round(s.x), Math.round(s.y), s.size, s.size);
    }
    ctx.globalAlpha = 1;
  }

  // ---------- Rounds / match ----------
  function newRound() {
    p1.x = 300; p1.y = GROUND_Y; p1.vx = 0; p1.vy = 0;
    p1.health = p1.maxHealth; p1.hitstun = 0; p1.blockstun = 0;
    p1.attack = null; p1.crouching = false; p1.blocking = false; p1.facing = 1;
    p1.onGround = true; p1.hurtFlash = 0; p1._cpuMode = null;

    p2.x = W - 300; p2.y = GROUND_Y; p2.vx = 0; p2.vy = 0;
    p2.health = p2.maxHealth; p2.hitstun = 0; p2.blockstun = 0;
    p2.attack = null; p2.crouching = false; p2.blocking = false; p2.facing = -1;
    p2.onGround = true; p2.hurtFlash = 0; p2._cpuMode = null;

    roundTimer = ROUND_TIME;
    timerAccum = 0;
    hitSparks = [];

    roundText.textContent = 'ROUND ' + roundNumber;
    roundSub.textContent = 'READY';
    roundScreen.classList.remove('hidden');

    sfxRound();

    setTimeout(() => { roundSub.textContent = 'FIGHT!'; sfxFight(); }, 900);
    setTimeout(() => {
      roundScreen.classList.add('hidden');
      matchState = 'fighting';
    }, 1700);
  }

  function startMatch(newMode) {
    mode = newMode;
    p1 = new Fighter({
      name: 'Player 1', color: '#4aa3ff', accentColor: '#2a6bbf',
      controls: 'p1', x: 300, facing: 1
    });
    p2 = new Fighter({
      name: mode === 'cpu' ? 'CPU' : 'Player 2',
      color: '#ff5566', accentColor: '#b83345',
      controls: 'p2', x: W - 300, facing: -1,
      isCPU: mode === 'cpu'
    });

    roundNumber = 1;
    p1Rounds = 0;
    p2Rounds = 0;
    matchState = 'idle';

    startScreen.classList.add('hidden');
    endScreen.classList.add('hidden');
    roundScreen.classList.add('hidden');

    setTimeout(newRound, 300);
  }

  function endRound(reason) {
    matchState = 'over';

    let winner;
    if (reason === 'ko') {
      winner = p1.health <= 0 ? p2 : p1;
    } else {
      // time over: higher HP wins; tie goes to P1
      winner = p2.health > p1.health ? p2 : p1;
    }

    if (winner === p1) p1Rounds++; else p2Rounds++;

    sfxKO();

    endTitle.textContent = reason === 'ko' ? 'K.O.' : 'TIME UP';
    endSub.textContent = winner.name + ' wins the round!';

    if (p1Rounds >= ROUNDS_TO_WIN || p2Rounds >= ROUNDS_TO_WIN) {
      endTitle.textContent = reason === 'ko' ? 'K.O.' : 'TIME UP';
      endSub.textContent = winner.name + ' wins the match! ' +
        '(P1: ' + p1Rounds + ' — P2: ' + p2Rounds + ')';
      endScreen.classList.remove('hidden');
    } else {
      // Brief round-end overlay, then next round
      roundText.textContent = 'ROUND ' + roundNumber + ' — ' + (winner === p1 ? 'P1' : 'P2');
      roundSub.textContent = winner.name + ' takes it';
      roundScreen.classList.remove('hidden');

      setTimeout(() => {
        roundScreen.classList.add('hidden');
        roundNumber++;
        newRound();
      }, 1800);
    }
  }

  // ---------- Update ----------
  function update(dt) {
    if (!p1 || !p2) return;

    if (matchState === 'fighting') {
      const in1 = readP1Input();
      const in2 = p2.isCPU ? cpuInput(p2, p1) : readP2Input();

      p1.update(p2, in1);
      p2.update(p1, in2);

      p1.updateAttackPhase();
      p2.updateAttackPhase();

      checkAttack(p1, p2);
      checkAttack(p2, p1);

      // Round timer
      timerAccum += dt;
      if (timerAccum >= 1) {
        timerAccum -= 1;
        roundTimer--;
        if (roundTimer <= 0) {
          roundTimer = 0;
          endRound('time');
        }
      }

      // KO check
      if (p1.health <= 0 && matchState === 'fighting') endRound('ko');
      else if (p2.health <= 0 && matchState === 'fighting') endRound('ko');
    } else {
      // Still apply physics while in round intro
      p1.applyPhysics(p2);
      p2.applyPhysics(p1);
    }

    updateSparks();
  }

  // ---------- Draw ----------
  function drawBackground() {
    const grad = ctx.createLinearGradient(0, 0, 0, H);
    grad.addColorStop(0, '#1a1530');
    grad.addColorStop(0.55, '#3a2050');
    grad.addColorStop(1, '#5a2840');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, W, H);

    // Moon
    ctx.fillStyle = '#ffe8a8';
    ctx.beginPath();
    ctx.arc(820, 100, 50, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#1a1530';
    ctx.beginPath();
    ctx.arc(840, 90, 42, 0, Math.PI * 2);
    ctx.fill();

    // Distant skyline
    ctx.fillStyle = '#0f0a20';
    for (let i = 0; i < 14; i++) {
      const bw = 60 + (i * 37) % 50;
      const bh = 90 + (i * 53) % 130;
      ctx.fillRect(i * 70, H - 130 - bh, bw, bh + 130);
    }

    // Ring floor
    ctx.fillStyle = '#2a1e3a';
    ctx.fillRect(0, GROUND_Y, W, H - GROUND_Y);
    ctx.fillStyle = '#3a2a50';
    ctx.fillRect(0, GROUND_Y, W, 6);

    // Ring border lines
    ctx.strokeStyle = 'rgba(255,200,100,0.25)';
    ctx.lineWidth = 2;
    for (let x = 0; x < W; x += 60) {
      ctx.beginPath();
      ctx.moveTo(x, GROUND_Y + 8);
      ctx.lineTo(x + 30, H);
      ctx.stroke();
    }
  }

  function drawHUD() {
    // Health bar background
    ctx.fillStyle = 'rgba(10,10,26,0.85)';
    ctx.fillRect(0, 0, W, 80);
    ctx.fillStyle = 'rgba(255,200,100,0.25)';
    ctx.fillRect(0, 78, W, 2);

    const barW = 360;
    const barH = 26;
    const barY = 22;

    // P1 bar
    ctx.fillStyle = '#1a1a2e';
    ctx.fillRect(30, barY, barW, barH);
    ctx.fillStyle = p1 ? '#4aa3ff' : '#444';
    if (p1) ctx.fillRect(30, barY, barW * (p1.health / p1.maxHealth), barH);
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 3;
    ctx.strokeRect(30, barY, barW, barH);

    // P2 bar (mirrored)
    ctx.fillStyle = '#1a1a2e';
    ctx.fillRect(W - 30 - barW, barY, barW, barH);
    ctx.fillStyle = p2 ? '#ff5566' : '#444';
    if (p2) {
      const w = barW * (p2.health / p2.maxHealth);
      ctx.fillRect(W - 30 - w, barY, w, barH);
    }
    ctx.strokeRect(W - 30 - barW, barY, barW, barH);

    // Names
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 16px Courier New';
    ctx.textAlign = 'left';
    ctx.fillText(p1 ? p1.name : 'P1', 30, 74);
    ctx.textAlign = 'right';
    ctx.fillText(p2 ? p2.name : 'P2', W - 30, 74);

    // Timer
    ctx.fillStyle = '#ffd166';
    ctx.font = 'bold 44px Courier New';
    ctx.textAlign = 'center';
    ctx.fillText(String(roundTimer), W / 2, 52);

    // Round win indicators (dots)
    for (let i = 0; i < ROUNDS_TO_WIN; i++) {
      ctx.fillStyle = i < p1Rounds ? '#ffd166' : 'rgba(255,209,102,0.2)';
      ctx.beginPath();
      ctx.arc(60 + i * 22, barY + barH + 14, 7, 0, Math.PI * 2);
      ctx.fill();

      ctx.fillStyle = i < p2Rounds ? '#ffd166' : 'rgba(255,209,102,0.2)';
      ctx.beginPath();
      ctx.arc(W - 60 - i * 22, barY + barH + 14, 7, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.textAlign = 'left';
  }

  function render() {
    drawBackground();
    if (p1 && p2) {
      // Draw the fighter that is further back first (higher Y means closer to camera)
      p2.draw();
      p1.draw();
      drawSparks();
    }
    if (p1 && p2) drawHUD();
  }

  // ---------- Game loop ----------
  let lastTime = performance.now();
  function loop(now) {
    const dt = Math.min(0.05, (now - lastTime) / 1000);
    lastTime = now;
    update(dt);
    render();
    requestAnimationFrame(loop);
  }

  // ---------- Input ----------
  window.addEventListener('keydown', e => {
    if ([' ', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) {
      e.preventDefault();
    }
    keys[e.key] = true;
  });
  window.addEventListener('keyup', e => {
    keys[e.key] = false;
  });

  // ---------- Buttons (delegated) ----------
  document.addEventListener('click', e => {
    const id = e.target && e.target.id;
    if (id === 'cpuBtn') {
      audioCtx.get();
      startMatch('cpu');
    } else if (id === 'pvpBtn') {
      audioCtx.get();
      startMatch('pvp');
    } else if (id === 'rematchBtn') {
      startMatch(mode);
    } else if (id === 'menuBtn') {
      state = 'menu';
      matchState = 'idle';
      startScreen.classList.remove('hidden');
      endScreen.classList.add('hidden');
      roundScreen.classList.add('hidden');
    }
  });

  requestAnimationFrame(loop);
})();