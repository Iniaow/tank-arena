(() => {
  'use strict';

  const PRESETS = [
    { id: 'hunter', label: '追猎', description: '沿通道追击，预判对手方向。' },
    { id: 'guard', label: '守角', description: '寻找视野，保持距离压制。' },
    { id: 'scout', label: '游击', description: '移动交火，优先避开飞弹。' },
    { id: 'charge', label: '突袭', description: '快速接近对手，主动交火。' }
  ];

  function decide(state) {
    const { self, tanks, bullets, map } = state;
    const pi = Math.PI;
    const wrap = (angle) => Math.atan2(Math.sin(angle), Math.cos(angle));
    const cap = (n, min, max) => Math.max(min, Math.min(max, n));
    const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

    function clear(x, y, tx, ty, padding = 4) {
      const dx = tx - x;
      const dy = ty - y;
      for (const [x1, y1, x2, y2] of map.walls) {
        const left = x1 - padding;
        const right = x2 + padding;
        const top = y1 - padding;
        const bottom = y2 + padding;
        if (Math.max(x, tx) < left || Math.min(x, tx) > right ||
            Math.max(y, ty) < top || Math.min(y, ty) > bottom) continue;
        const ax = dx ? (left - x) / dx : -Infinity;
        const bx = dx ? (right - x) / dx : Infinity;
        const ay = dy ? (top - y) / dy : -Infinity;
        const by = dy ? (bottom - y) / dy : Infinity;
        if (Math.max(Math.min(ax, bx), Math.min(ay, by), 0) <=
            Math.min(Math.max(ax, bx), Math.max(ay, by), 1)) return false;
      }
      return true;
    }

    const enemy = tanks.filter((tank) => tank.alive && tank.id !== self.id)
      .sort((a, b) => distance(self, a) - distance(self, b))[0];
    if (!enemy) return {};

    const range = distance(self, enemy);
    const direct = clear(self.x, self.y, enemy.x, enemy.y, 6);
    const cell = (point) => Math.floor(point.x / map.cellSize) + map.cols * Math.floor(point.y / map.cellSize);

    function waypoint() {
      const here = cell(self);
      const there = cell(enemy);
      const visited = new Set([here]);
      const queue = [{ index: here, first: here }];
      for (let i = 0; i < queue.length; i++) {
        const { index, first } = queue[i];
        if (index === there) {
          const second = queue[i].second;
          const center = (n) => ({
            x: (n % map.cols + 0.5) * map.cellSize,
            y: (Math.floor(n / map.cols) + 0.5) * map.cellSize
          });
          const next = center(first);
          if (second !== undefined) {
            const farther = center(second);
            if (clear(self.x, self.y, farther.x, farther.y, 16)) return farther;
          }
          return first === here ? enemy : next;
        }
        for (const next of map.exits[index]) {
          if (visited.has(next)) continue;
          visited.add(next);
          queue.push({ index: next, first: index === here ? next : first, second: queue[i].second ?? (first === here ? undefined : next) });
        }
      }
      return enemy;
    }

    const goal = direct && clear(self.x, self.y, enemy.x, enemy.y, 16) ? enemy : waypoint();
    let heading = Math.atan2(goal.y - self.y, goal.x - self.x);
    const sightAngle = Math.atan2(enemy.y - self.y, enemy.x - self.x);
    const lead = STYLE === 'hunter' ? Math.min(range * 0.16, 34) : 0;
    const leadX = enemy.x + Math.cos(enemy.angle) * lead;
    const leadY = enemy.y + Math.sin(enemy.angle) * lead;
    const shotHeading = direct && clear(self.x, self.y, leadX, leadY, 6)
      ? Math.atan2(leadY - self.y, leadX - self.x) : sightAngle;
    const flanking = direct && STYLE === 'scout' && range < 170 && self.cooldown > 0.34;
    let evading = false;

    if (direct && STYLE === 'guard' && range < 102) heading = sightAngle + pi;
    if (flanking) {
      const side = Math.sin(state.tick / 220) > 0 ? 1 : -1;
      const flank = sightAngle + side * pi / 2;
      if (clear(self.x, self.y, self.x + Math.cos(flank) * 34, self.y + Math.sin(flank) * 34, 16)) heading = flank;
    }
    if (STYLE !== 'charge') {
      for (const bullet of bullets) {
        if (bullet.ownerId === self.id && bullet.bounces === 0) continue;
        const dx = self.x - bullet.x;
        const dy = self.y - bullet.y;
        const untilImpact = (dx * bullet.vx + dy * bullet.vy) / (bullet.vx ** 2 + bullet.vy ** 2);
        if (untilImpact <= 0 || untilImpact > 0.38 ||
            Math.hypot(dx - bullet.vx * untilImpact, dy - bullet.vy * untilImpact) > 17 ||
            !clear(bullet.x, bullet.y, self.x, self.y, 5)) continue;
        const side = Math.atan2(bullet.vy, bullet.vx) + pi / 2;
        const options = [side, side + pi].filter((angle) => clear(
          self.x, self.y, self.x + Math.cos(angle) * 28, self.y + Math.sin(angle) * 28, 16
        ));
        if (options.length) {
          heading = options.sort((a, b) => Math.abs(wrap(a - self.angle)) - Math.abs(wrap(b - self.angle)))[0];
          evading = true;
          break;
        }
      }
    }

    if (!clear(self.x, self.y, self.x + Math.cos(heading) * 20, self.y + Math.sin(heading) * 20, 13)) {
      const here = cell(self);
      const x = (here % map.cols + 0.5) * map.cellSize;
      const y = (Math.floor(here / map.cols) + 0.5) * map.cellSize;
      if (Math.hypot(self.x - x, self.y - y) > 4) heading = Math.atan2(y - self.y, x - self.x);
    }

    const tracking = direct && !evading && !flanking;
    let facing = heading;
    let direction = 1;
    if (tracking) {
      facing = shotHeading;
      const travelAngle = Math.abs(wrap(heading - facing));
      direction = travelAngle < 0.7 ? 1 : travelAngle > pi - 0.7 ? -1 : 0;
    } else if (STYLE !== 'charge' && Math.abs(wrap(heading - self.angle)) > pi * 0.66) {
      facing = heading + pi;
      direction = -1;
    }
    const turn = wrap(facing - self.angle);
    const pace = STYLE === 'guard' && direct && range > 115 ? 0.69 : 1;
    return {
      turn: cap(turn * 2.25, -1, 1),
      throttle: Math.abs(turn) > 1.1 ? 0 : direction * pace,
      fire: Math.abs(turn) < (tracking ? 0.14 : 0.11) && (tracking || (!direct && STYLE === 'charge'))
    };
  }

  function presetCode(id) {
    return 'const STYLE = ' + JSON.stringify(id) + ';\n\n' + decide.toString();
  }

  const EXAMPLE = [
    'function decide(state) {',
    '  const { self, tanks } = state;',
    '  const enemy = tanks.find(tank => tank.alive && tank.id !== self.id);',
    '  if (!enemy) return {};',
    '  const targetAngle = Math.atan2(enemy.y - self.y, enemy.x - self.x);',
    '  const delta = targetAngle - self.angle;',
    '  const error = Math.atan2(Math.sin(delta), Math.cos(delta));',
    '  return {',
    '    throttle: Math.abs(error) < 0.7 ? 1 : 0,',
    '    turn: Math.max(-1, Math.min(1, 2.25 * error)),',
    '    fire: Math.abs(error) < 0.12',
    '  };',
    '}'
  ].join('\n');

  // The worker has no DOM. Only the action fields cross back into the game.
  function workerProgram(load, seed) {
    'use strict';
    const send = globalThis.postMessage.bind(globalThis);
    const listen = globalThis.addEventListener.bind(globalThis);
    const finite = Number.isFinite;
    const description = (error) => String(error?.message ?? error).slice(0, 220);
    let decide;
    try {
      Math.random = () => {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        return seed / 4294967296;
      };
      decide = load();
      if (typeof decide !== 'function') throw new Error('需要定义 function decide(state)');
      send({ kind: 'ready' });
    } catch (error) {
      send({ kind: 'error', message: description(error) });
      return;
    }

    listen('message', (event) => {
      const { seq, state } = event.data;
      try {
        const action = decide(state);
        if (action && typeof action.then === 'function') throw new Error('decide 必须同步返回动作对象');
        if (!action || typeof action !== 'object' || Array.isArray(action)) throw new Error('decide 必须返回动作对象');
        const { throttle, turn, fire } = action;
        send({
          kind: 'action', seq,
          action: {
            throttle: finite(throttle) ? throttle : 0,
            turn: finite(turn) ? turn : 0,
            fire: fire === true
          }
        });
      } catch (error) {
        send({ kind: 'error', seq, message: description(error) });
      }
    });
  }

  // The opaque iframe restricts its worker to local computation with its CSP.
  function sandboxHost() {
    'use strict';
    let worker;
    let token;
    let pending;
    let ready = false;
    function respond(data) {
      parent.postMessage({ token, ...data }, '*');
    }
    function fail(message) {
      respond({ kind: 'error', seq: pending, message: String(message).slice(0, 220) });
      pending = undefined;
    }
    addEventListener('message', (event) => {
      if (event.source !== parent) return;
      const data = event.data;
      if (data.kind === 'init' && !worker) {
        token = data.token;
        const source = '(' + data.program + ')(function () {\n"use strict";\n' +
          data.code + '\n;return typeof decide === "function" ? decide : null;\n}, ' + data.seed + ');';
        const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
        try {
          worker = new Worker(url);
          worker.onmessage = (message) => {
            const reply = message.data;
            if (!reply || typeof reply !== 'object') return;
            if (reply.kind === 'ready' && !ready) {
              ready = true;
              respond({ kind: 'ready' });
            } else if (reply.kind === 'error' && (!ready || reply.seq === pending)) {
              fail(reply.message);
            } else if (reply.kind === 'action' && pending !== undefined && reply.seq === pending) {
              const { throttle, turn, fire } = reply.action ?? {};
              respond({
                kind: 'action', seq: pending,
                action: {
                  throttle: Number.isFinite(throttle) ? throttle : 0,
                  turn: Number.isFinite(turn) ? turn : 0,
                  fire: fire === true
                }
              });
              pending = undefined;
            }
          };
          worker.onerror = (error) => {
            error.preventDefault();
            fail(error.message || '策略加载失败');
          };
        } catch (error) {
          fail(error.message);
        } finally {
          URL.revokeObjectURL(url);
        }
      } else if (data.kind === 'step' && worker && ready && data.token === token) {
        pending = data.seq;
        worker.postMessage({ seq: data.seq, state: data.state });
      }
    });
  }

  const sandboxPage = '<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" ' +
    'content="default-src \'none\'; script-src \'unsafe-inline\' blob:; worker-src blob:; connect-src \'none\'; base-uri \'none\'; form-action \'none\'">' +
    '<script>(' + sandboxHost.toString() + ')();<\/script>';

  class StrategyRunner {
    constructor(code, seed) {
      this.seq = 0;
      this.token = crypto.getRandomValues(new Uint32Array(4)).join('-');
      this.frame = document.createElement('iframe');
      this.frame.setAttribute('sandbox', 'allow-scripts');
      this.frame.hidden = true;
      this.frame.title = '坦克策略运行环境';
      this.receive = this.receive.bind(this);
      window.addEventListener('message', this.receive);
      this.ready = this.wait(undefined, 2600, '策略加载超时');
      this.frame.addEventListener('load', () => {
        this.frame.contentWindow?.postMessage({
          kind: 'init', token: this.token, code, program: workerProgram.toString(), seed
        }, '*');
      }, { once: true });
      this.frame.srcdoc = sandboxPage;
      document.body.append(this.frame);
    }

    wait(seq, ms, timeoutMessage) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          this.pending = null;
          this.close();
          reject(new Error(timeoutMessage));
        }, ms);
        this.pending = { seq, timer, resolve, reject };
      });
    }

    receive(event) {
      if (!this.pending || event.source !== this.frame.contentWindow || event.data?.token !== this.token) return;
      const data = event.data;
      if (this.pending.seq !== data.seq) return;
      const { timer, resolve, reject } = this.pending;
      clearTimeout(timer);
      this.pending = null;
      if (data.kind === 'error') reject(new Error(data.message || '策略运行失败'));
      else resolve(data.action);
    }

    run(state) {
      const seq = ++this.seq;
      const response = this.wait(seq, 240, '单次策略执行超过 240 毫秒');
      this.frame.contentWindow.postMessage({ kind: 'step', token: this.token, seq, state }, '*');
      return response;
    }

    close() {
      window.removeEventListener('message', this.receive);
      this.frame.remove();
      if (this.pending) {
        clearTimeout(this.pending.timer);
        this.pending.reject(new Error('策略运行已取消'));
        this.pending = null;
      }
    }
  }

  globalThis.ArenaStrategies = { PRESETS, EXAMPLE, presetCode, StrategyRunner };
})();
