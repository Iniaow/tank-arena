(() => {
  'use strict';

  const CELL = 64;
  const WALL = 6;
  const RADIUS = 12;
  const BULLET_SPEED = 175.95;
  const STEP = 1 / 120;
  const BULLET_LIFETIME_TICKS = 8 / STEP;
  const TANK_BULLET_LIMIT = 5;
  const DURATION = 45;
  const SIZES = [
    { label: '小型', cols: 9, rows: 6 },
    { label: '中型', cols: 12, rows: 8 },
    { label: '大型', cols: 15, rows: 10 }
  ];
  const IDLE = Object.freeze({ throttle: 0, turn: 0, fire: false });
  const clamp = (n, min, max) => Math.max(min, Math.min(max, n));
  const wrap = (angle) => Math.atan2(Math.sin(angle), Math.cos(angle));
  const distance2 = (a, b) => (a.x - b.x) ** 2 + (a.y - b.y) ** 2;

  function randomSource(seed) {
    return () => {
      seed = (seed + 0x6D2B79F5) >>> 0;
      let n = Math.imul(seed ^ (seed >>> 15), seed | 1);
      n ^= n + Math.imul(n ^ (n >>> 7), n | 61);
      return ((n ^ (n >>> 14)) >>> 0) / 4294967296;
    };
  }

  function shuffle(items, random) {
    for (let i = items.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [items[i], items[j]] = [items[j], items[i]];
    }
    return items;
  }

  function generateMap(seed, previousSize) {
    const random = randomSource(seed);
    const choices = SIZES.filter((size) => size.label !== previousSize);
    const { label, cols, rows } = choices[Math.floor(random() * choices.length)];
    const width = cols * CELL;
    const height = rows * CELL;
    const walls = [[0, 0, width, 0], [width, 0, width, height], [0, height, width, height], [0, 0, 0, height]];
    const cells = Array.from({ length: cols * rows }, (_, i) => ({
      x: (i % cols + 0.5) * CELL, y: (Math.floor(i / cols) + 0.5) * CELL
    }));
    const exits = cells.map(() => []);
    const edges = [];
    cells.forEach((_, i) => {
      const x = i % cols * CELL;
      const y = Math.floor(i / cols) * CELL;
      if (i % cols < cols - 1) edges.push({ a: i, b: i + 1, wall: [x + CELL, y, x + CELL, y + CELL] });
      if (i + cols < cells.length) edges.push({ a: i, b: i + cols, wall: [x, y + CELL, x + CELL, y + CELL] });
    });

    const parent = cells.map((_, i) => i);
    function root(i) {
      while (parent[i] !== i) {
        parent[i] = parent[parent[i]];
        i = parent[i];
      }
      return i;
    }

    // Open a spanning tree first, then open additional routes through the maze.
    for (const { a, b, wall } of shuffle(edges, random)) {
      const first = root(a);
      const second = root(b);
      if (first !== second || random() < 0.27) {
        parent[first] = second;
        exits[a].push(b);
        exits[b].push(a);
      } else {
        walls.push(wall);
      }
    }
    const boxes = walls.map(([x1, y1, x2, y2]) => ({
      left: x1 - WALL / 2, right: x2 + WALL / 2, top: y1 - WALL / 2, bottom: y2 + WALL / 2
    }));
    const id = seed.toString(16).toUpperCase().padStart(8, '0');
    return { id, seed, label, cols, rows, width, height, cellSize: CELL, wallWidth: WALL, walls, boxes, cells, exits };
  }

  function spawnPoints(map, count) {
    const random = randomSource(map.seed ^ 0x81AA11F3);
    const candidates = shuffle([...map.cells], random);
    const points = [candidates.pop()];
    while (points.length < count) {
      let bestIndex = 0;
      let bestDistance = -1;
      for (let i = 0; i < candidates.length; i++) {
        const nearest = Math.min(...points.map((point) => distance2(point, candidates[i])));
        if (nearest > bestDistance) {
          bestDistance = nearest;
          bestIndex = i;
        }
      }
      points.push(candidates.splice(bestIndex, 1)[0]);
    }
    return shuffle(points, random).map((point) => ({ ...point, angle: random() * 2 * Math.PI - Math.PI }));
  }

  function hitsWall(map, x, y, radius) {
    for (const { left, right, top, bottom } of map.boxes) {
      const dx = x - clamp(x, left, right);
      const dy = y - clamp(y, top, bottom);
      if (dx * dx + dy * dy < radius * radius) return true;
    }
    return false;
  }

  function firstWall(map, x, y, dx, dy, radius) {
    let best = null;
    const endX = x + dx;
    const endY = y + dy;
    for (const box of map.boxes) {
      const left = box.left - radius;
      const right = box.right + radius;
      const top = box.top - radius;
      const bottom = box.bottom + radius;
      if (Math.max(x, endX) < left || Math.min(x, endX) > right ||
          Math.max(y, endY) < top || Math.min(y, endY) > bottom) continue;
      const tx = dx === 0 ? -Infinity : ((dx > 0 ? left : right) - x) / dx;
      const ty = dy === 0 ? -Infinity : ((dy > 0 ? top : bottom) - y) / dy;
      const exitX = dx === 0 ? Infinity : ((dx > 0 ? right : left) - x) / dx;
      const exitY = dy === 0 ? Infinity : ((dy > 0 ? bottom : top) - y) / dy;
      const t = Math.max(tx, ty);
      if (t < -1e-8 || t > Math.min(1, exitX, exitY)) continue;
      const nx = tx >= ty - 1e-8 ? -Math.sign(dx) : 0;
      const ny = ty >= tx - 1e-8 ? -Math.sign(dy) : 0;
      if (!best || t < best.t - 1e-8) {
        best = { t: Math.max(0, t), nx, ny };
      } else if (Math.abs(t - best.t) < 1e-8) {
        best.nx ||= nx;
        best.ny ||= ny;
      }
    }
    return best;
  }

  function hitTime(x, y, dx, dy, tank) {
    const rx = x - tank.x;
    const ry = y - tank.y;
    const c = rx * rx + ry * ry - (RADIUS + 2) ** 2;
    if (c <= 0) return 0;
    const a = dx * dx + dy * dy;
    const b = rx * dx + ry * dy;
    const discriminant = b * b - a * c;
    return discriminant >= 0 ? (-b - Math.sqrt(discriminant)) / a : Infinity;
  }

  function sanitize(action) {
    const number = (n) => typeof n === 'number' && Number.isFinite(n);
    if (!action || typeof action !== 'object') return IDLE;
    return {
      throttle: number(action.throttle) ? clamp(action.throttle, -1, 1) : 0,
      turn: number(action.turn) ? clamp(action.turn, -1, 1) : 0,
      fire: action.fire === true
    };
  }

  class Battle {
    constructor(map, entries, round) {
      this.map = map;
      this.round = round;
      this.tick = 0;
      this.bullets = [];
      this.events = [];
      this.result = null;
      this.bulletId = 0;
      this.mapState = {
        id: map.id, width: map.width, height: map.height, cellSize: CELL, wallWidth: WALL,
        cols: map.cols, rows: map.rows, walls: map.walls, exits: map.exits
      };
      const spawns = spawnPoints(map, entries.length);
      this.tanks = entries.map((entry, i) => ({
        id: entry.id, name: entry.displayName ?? entry.name, color: entry.color,
        ...spawns[i], alive: true, cooldown: 0, kills: 0, error: null
      }));
    }

    get timeLeft() {
      return Math.max(0, DURATION - this.tick * STEP);
    }

    snapshot() {
      return {
        tick: this.tick, round: this.round, timeLeft: this.timeLeft,
        tanks: this.tanks.map(({ id, x, y, angle, cooldown, alive, kills }) => (
          { id, x, y, angle, turret: angle, cooldown, alive, kills }
        )),
        bullets: this.bullets.map(({ id, ownerId, x, y, vx, vy, bounces }) => (
          { id, ownerId, x, y, vx, vy, bounces }
        )),
        map: this.mapState
      };
    }

    remove(tank, owner, error = null) {
      if (!tank.alive) return;
      tank.alive = false;
      tank.error = error;
      if (owner && owner !== tank) owner.kills++;
      this.events.push({ kind: error ? 'error' : 'hit', tank, owner });
    }

    step(actions) {
      const moving = this.tanks.filter((tank) => tank.alive);
      const offset = moving.length ? this.tick % moving.length : 0;
      for (let i = 0; i < moving.length; i++) {
        const tank = moving[(offset + i) % moving.length];
        const action = actions[tank.id] ?? IDLE;
        this.moveTank(tank, action);
      }
      this.bullets = this.bullets.filter((bullet) => this.moveBullet(bullet));
      this.tick++;
      const alive = this.tanks.filter((tank) => tank.alive);
      if (alive.length <= 1 || this.timeLeft <= 0) {
        this.result = { winner: alive.length === 1 ? alive[0].id : null, reason: alive.length > 1 ? 'time' : 'elimination' };
      }
    }

    moveTank(tank, action) {
      tank.angle = wrap(tank.angle + action.turn * 3.5 * STEP);
      const speed = (action.throttle < 0 ? 58 : 95) * action.throttle * STEP;
      const tryMove = (x, y) => !hitsWall(this.map, x, y, RADIUS) && !this.tanks.some(
        (other) => other !== tank && other.alive && distance2(other, { x, y }) < (RADIUS * 2) ** 2
      );
      const x = tank.x + Math.cos(tank.angle) * speed;
      const y = tank.y + Math.sin(tank.angle) * speed;
      if (speed && tryMove(x, tank.y)) tank.x = x;
      if (speed && tryMove(tank.x, y)) tank.y = y;
      tank.cooldown = Math.max(0, tank.cooldown - STEP);
      if (!action.fire || tank.cooldown > 0 || this.bullets.filter((bullet) => bullet.ownerId === tank.id).length >= TANK_BULLET_LIMIT) return;
      const vx = Math.cos(tank.angle);
      const vy = Math.sin(tank.angle);
      if (firstWall(this.map, tank.x, tank.y, vx * 16, vy * 16, 2)) return;
      tank.cooldown = 0.62;
      this.bullets.push({
        id: ++this.bulletId, ownerId: tank.id, x: tank.x + vx * 16, y: tank.y + vy * 16,
        vx: vx * BULLET_SPEED, vy: vy * BULLET_SPEED, bounces: 0, ticksLeft: BULLET_LIFETIME_TICKS
      });
      this.events.push({ kind: 'fire', tank });
    }

    moveBullet(bullet) {
      if (--bullet.ticksLeft <= 0) return false;
      let remaining = STEP;
      for (let reflections = 0; reflections < 4 && remaining > 1e-8; reflections++) {
        const { x, y } = bullet;
        const dx = bullet.vx * remaining;
        const dy = bullet.vy * remaining;
        const wall = firstWall(this.map, x, y, dx, dy, 2);
        let time = wall ? wall.t : 1;
        let hit = null;
        for (const tank of this.tanks) {
          if (!tank.alive || (tank.id === bullet.ownerId && !bullet.bounces)) continue;
          const t = hitTime(x, y, dx, dy, tank);
          if (t >= 0 && t <= time) {
            hit = tank;
            time = t;
          }
        }
        bullet.x += dx * time;
        bullet.y += dy * time;
        if (hit) {
          this.remove(hit, this.tanks.find((tank) => tank.id === bullet.ownerId));
          return false;
        }
        if (!wall) return true;
        if (++bullet.bounces > 5) return false;
        if (wall.nx) bullet.vx *= -1;
        if (wall.ny) bullet.vy *= -1;
        bullet.x += wall.nx * 0.005;
        bullet.y += wall.ny * 0.005;
        remaining *= 1 - time;
      }
      return bullet.x >= 0 && bullet.y >= 0 && bullet.x <= this.map.width && bullet.y <= this.map.height;
    }
  }

  globalThis.ArenaEngine = { Battle, generateMap, randomSource, sanitize, STEP, DURATION, IDLE };
})();
