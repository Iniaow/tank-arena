(() => {
  'use strict';

  class ArenaView {
    constructor(canvas) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.backdrop = document.createElement('canvas');
      this.map = null;
      this.lastBattle = null;
      this.particles = [];
      this.viewport = { width: canvas.width, height: canvas.height, ratio: 1, scaleX: 1, scaleY: 1 };

      this.resizeObserver = new ResizeObserver(([entry]) => {
        const { width, height } = entry.contentRect;
        this.resize(width, height);
      });
      this.resizeObserver.observe(canvas);

      const { width, height } = canvas.getBoundingClientRect();
      this.resize(width, height);
    }

    syncPixelRatio() {
      const ratio = window.devicePixelRatio || 1;
      const { width, height } = this.viewport;
      if (ratio !== this.viewport.ratio) this.resize(width, height, ratio);
    }

    resize(width, height, ratio = window.devicePixelRatio || 1) {
      if (!width || !height) return;
      const pixelWidth = Math.max(1, Math.round(width * ratio));
      const pixelHeight = Math.max(1, Math.round(height * ratio));
      const { canvas, viewport } = this;
      if (viewport.width === width && viewport.height === height && viewport.ratio === ratio &&
          canvas.width === pixelWidth && canvas.height === pixelHeight) return;

      if (canvas.width !== pixelWidth) canvas.width = pixelWidth;
      if (canvas.height !== pixelHeight) canvas.height = pixelHeight;
      this.viewport = { width, height, ratio, scaleX: pixelWidth / width, scaleY: pixelHeight / height };
      this.map = null;
      if (this.lastBattle) this.draw(this.lastBattle);
    }

    background(map) {
      const { width, height, scaleX, scaleY } = this.viewport;
      this.backdrop.width = this.canvas.width;
      this.backdrop.height = this.canvas.height;
      const ctx = this.backdrop.getContext('2d');
      ctx.setTransform(scaleX, 0, 0, scaleY, 0, 0);

      const paddingX = Math.min(48, width * 0.05);
      const paddingY = Math.min(34, height * 0.052);
      const scale = Math.min((width - paddingX) / map.width, (height - paddingY) / map.height);
      const x = (width - map.width * scale) / 2;
      const y = (height - map.height * scale) / 2;
      this.transform = { x, y, scale };

      const surround = ctx.createLinearGradient(0, 0, width, height);
      surround.addColorStop(0, '#f2eee3');
      surround.addColorStop(1, '#eae4d5');
      ctx.fillStyle = surround;
      ctx.fillRect(0, 0, width, height);

      ctx.save();
      ctx.translate(x, y);
      ctx.scale(scale, scale);
      ctx.fillStyle = '#9c8d7135';
      ctx.beginPath();
      ctx.roundRect(-5, -4, map.width + 10, map.height + 11, 6);
      ctx.fill();

      const floor = ctx.createLinearGradient(0, 0, map.width, map.height);
      floor.addColorStop(0, '#f5f0e3');
      floor.addColorStop(0.59, '#ede7d9');
      floor.addColorStop(1, '#e9e1d1');
      ctx.fillStyle = floor;
      ctx.fillRect(0, 0, map.width, map.height);

      const grain = ArenaEngine.randomSource(map.seed ^ 0x243F6A88);
      ctx.fillStyle = '#63533713';
      for (let i = 0; i < map.width * map.height / 105; i++) {
        ctx.fillRect(grain() * map.width, grain() * map.height, 0.85 + grain() * 0.55, 0.8);
      }

      const cell = map.cellSize;
      ctx.lineWidth = 0.8 / scale;
      ctx.strokeStyle = '#8c80682b';
      ctx.beginPath();
      for (let i = cell; i < map.width; i += cell) {
        ctx.moveTo(i, 0);
        ctx.lineTo(i, map.height);
      }
      for (let i = cell; i < map.height; i += cell) {
        ctx.moveTo(0, i);
        ctx.lineTo(map.width, i);
      }
      ctx.stroke();

      ctx.restore();

      // Align the wall strokes to whole device pixels so straight edges stay sharp.
      const thickness = Math.max(2, Math.round(map.wallWidth * scale * (scaleX + scaleY) / 2));
      const inset = thickness % 2 / 2;
      const snap = (pixel) => Math.round(pixel - inset) + inset;
      const pixelX = (unit) => snap((x + unit * scale) * scaleX);
      const pixelY = (unit) => snap((y + unit * scale) * scaleY);
      ctx.resetTransform();
      ctx.lineWidth = thickness;
      ctx.lineCap = 'round';
      ctx.strokeStyle = '#504b40';
      ctx.beginPath();
      for (const [x1, y1, x2, y2] of map.walls.slice(4)) {
        ctx.moveTo(pixelX(x1), pixelY(y1));
        ctx.lineTo(pixelX(x2), pixelY(y2));
      }
      ctx.stroke();

      const left = pixelX(0);
      const top = pixelY(0);
      const corner = 5 * scale * Math.min(scaleX, scaleY);
      ctx.strokeStyle = '#403d33';
      ctx.beginPath();
      ctx.roundRect(left, top, pixelX(map.width) - left, pixelY(map.height) - top, corner);
      ctx.stroke();
    }

    addEvents(events) {
      for (const event of events) {
        if (event.kind === 'fire') continue;
        for (let i = 0; i < 13; i++) {
          const direction = Math.random() * Math.PI * 2;
          const speed = 22 + Math.random() * 60;
          this.particles.push({
            x: event.tank.x, y: event.tank.y, color: event.tank.color,
            vx: Math.cos(direction) * speed, vy: Math.sin(direction) * speed,
            life: 0.28 + Math.random() * 0.3
          });
        }
      }
    }

    draw(battle, elapsed = 0) {
      if (this.lastBattle !== battle) {
        this.lastBattle = battle;
        this.particles = [];
      }
      if (this.map !== battle.map) {
        this.map = battle.map;
        this.background(battle.map);
      }
      const ctx = this.ctx;
      ctx.drawImage(this.backdrop, 0, 0);
      const { x, y, scale } = this.transform;
      const { scaleX, scaleY } = this.viewport;
      ctx.save();
      ctx.setTransform(scaleX, 0, 0, scaleY, 0, 0);
      ctx.translate(x, y);
      ctx.scale(scale, scale);
      ctx.beginPath();
      ctx.rect(4, 4, battle.map.width - 8, battle.map.height - 8);
      ctx.clip();

      for (const tank of battle.tanks) {
        if (tank.alive) continue;
        ctx.fillStyle = '#594a3023';
        ctx.beginPath();
        ctx.arc(tank.x, tank.y, 13, 0, 2 * Math.PI);
        ctx.fill();
        ctx.strokeStyle = tank.color + '90';
        ctx.lineWidth = 1.4;
        ctx.beginPath();
        ctx.moveTo(tank.x - 5, tank.y - 5);
        ctx.lineTo(tank.x + 5, tank.y + 5);
        ctx.moveTo(tank.x + 5, tank.y - 5);
        ctx.lineTo(tank.x - 5, tank.y + 5);
        ctx.stroke();
      }
      for (const tank of battle.tanks) {
        if (tank.alive) this.drawTank(tank, battle.map);
      }
      this.particles = this.particles.filter((particle) => particle.life > 0);
      for (const particle of this.particles) {
        particle.x += particle.vx * elapsed;
        particle.y += particle.vy * elapsed;
        particle.life -= elapsed;
        ctx.globalAlpha = Math.max(0, Math.min(1, particle.life * 3));
        ctx.fillStyle = particle.color;
        ctx.fillRect(particle.x, particle.y, 2, 2);
      }

      // Keep moving shots visible even where they cross tank labels.
      ctx.globalAlpha = 1;
      for (const bullet of battle.bullets) {
        const owner = battle.tanks.find((tank) => tank.id === bullet.ownerId);
        ctx.strokeStyle = (owner?.color ?? '#625744') + '90';
        ctx.lineWidth = 2;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(bullet.x, bullet.y);
        ctx.lineTo(bullet.x - bullet.vx * 0.029, bullet.y - bullet.vy * 0.029);
        ctx.stroke();
        const radius = Math.max(3.25, 1.5 / scale);
        ctx.fillStyle = '#fff9e9';
        ctx.beginPath();
        ctx.arc(bullet.x, bullet.y, radius + 0.85 / scale, 0, 2 * Math.PI);
        ctx.fill();
        ctx.fillStyle = '#3d392f';
        ctx.beginPath();
        ctx.arc(bullet.x, bullet.y, radius, 0, 2 * Math.PI);
        ctx.fill();
      }
      ctx.restore();
    }

    drawTank(tank, map) {
      const ctx = this.ctx;
      ctx.save();
      ctx.translate(tank.x, tank.y);
      ctx.rotate(tank.angle);
      ctx.fillStyle = '#463e34';
      for (const track of [-11, 6]) {
        ctx.beginPath();
        ctx.roundRect(-11, track, 22, 5, 1.5);
        ctx.fill();
      }
      ctx.fillStyle = tank.color;
      ctx.strokeStyle = '#4b3d3263';
      ctx.lineWidth = 0.9;
      ctx.beginPath();
      ctx.roundRect(-10, -7.5, 20, 15, 2.5);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = '#fff8e568';
      ctx.fillRect(-8, -5.5, 16, 1.5);

      ctx.fillStyle = tank.color;
      ctx.strokeStyle = '#44382b80';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.roundRect(1, -2.2, 17, 4.4, 1.5);
      ctx.fill();
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(0, 0, 4.7, 0, 2 * Math.PI);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = '#fff7e8bc';
      ctx.beginPath();
      ctx.arc(-0.8, -1, 1.7, 0, 2 * Math.PI);
      ctx.fill();
      ctx.restore();

      const pixelsPerUnit = this.transform.scale;
      const readableSize = this.viewport.width >= 640 ? 12 : 10;
      const fontSize = Math.max(13, readableSize / pixelsPerUnit);
      ctx.font = '700 ' + fontSize + 'px "Segoe UI", "Microsoft YaHei UI", sans-serif';
      const limit = Math.min(map.width - 25, 110 / pixelsPerUnit);
      const fitted = Array.from(tank.name);
      let label = fitted.join('');
      while (fitted.length > 1 && ctx.measureText(label).width > limit) {
        fitted.pop();
        label = fitted.join('').trimEnd() + '\u2026';
      }
      const width = ctx.measureText(label).width;
      const height = fontSize + 4;
      const left = Math.max(7, Math.min(map.width - 7 - width, tank.x - width / 2));
      const top = tank.y < height + 23 ? tank.y + 16 : tank.y - height - 15;
      const baseline = top + height / 2;
      ctx.textBaseline = 'middle';
      ctx.lineJoin = 'round';
      ctx.lineWidth = 2.4 / pixelsPerUnit;
      ctx.strokeStyle = '#faf6eb';
      ctx.strokeText(label, left, baseline);
      ctx.fillStyle = '#302b21';
      ctx.fillText(label, left, baseline);
    }
  }

  globalThis.ArenaView = ArenaView;
})();
