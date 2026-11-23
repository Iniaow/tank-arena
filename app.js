(() => {
  'use strict';

  const { Battle, generateMap, sanitize, STEP, DURATION, IDLE } = ArenaEngine;
  const { PRESETS, EXAMPLE, presetCode, StrategyRunner } = ArenaStrategies;
  const COLORS = ['#0b888e', '#c98512', '#cf4a42', '#8059ab', '#398046', '#c45f23', '#3077b5', '#ae4974'];
  const NAMES = ['追猎者', '守望者', '游击手', '突袭者', '夜行者', '前锋', '巡逻者', '先锋'];
  const STORE = 'ai-tank-arena.v1';
  const MATCH_PREFIX = STORE + '.match.';
  const MAX_CODE = 64 * 1024;
  const $ = (id) => document.getElementById(id);
  const tankCount = $('tank-count');
  const roundCount = $('match-rounds');
  const speedSelect = $('speed-select');
  const start = $('start-match');
  const pause = $('pause-match');
  const skip = $('skip-round');
  const end = $('end-match');
  const editor = $('strategy-dialog');
  const codeField = $('strategy-code');
  const strategyType = $('strategy-type');
  const nameField = $('tank-name');
  const historyDialog = $('history-dialog');
  const clearHistory = $('clear-history');
  const view = new ArenaView($('arena-canvas'));

  const defaults = NAMES.map((name, i) => ({
    id: 'tank-' + (i + 1), name, color: COLORS[i], type: PRESETS[i % PRESETS.length].id, code: '', version: 1
  }));
  let canStore = true;
  function read(key, fallback) {
    try {
      const value = localStorage.getItem(STORE + '.' + key);
      return value ? JSON.parse(value) : fallback;
    } catch {
      canStore = false;
      return fallback;
    }
  }

  function store(key, value) {
    try {
      localStorage.setItem(STORE + '.' + key, JSON.stringify(value));
      canStore = true;
      return true;
    } catch {
      canStore = false;
      message('浏览器未能写入本地存储。当前页仍可继续对战和查看记录。', true);
      return false;
    }
  }

  function loadSetup(source, fallback) {
    const { count, rounds, entries } = source ?? {};
    return {
      count: Number.isInteger(count) && count >= 2 && count <= 8 ? count : fallback.count,
      rounds: [1, 5, 10, 20].includes(rounds) ? rounds : fallback.rounds,
      entries: fallback.entries.map((entry, i) => {
        const configured = entries?.[i];
        if (!configured || typeof configured.name !== 'string' || typeof configured.code !== 'string' ||
            !Number.isInteger(configured.version) || !isStrategy(configured.type)) return { ...entry };
        const { name, code, type, version } = configured;
        return { ...entry, name, code, type, version };
      })
    };
  }

  const stockSetup = { count: 4, rounds: 5, entries: defaults };
  const publishedRoster = globalThis.ArenaPublishedRoster;
  const publishedSetup = publishedRoster?.formatVersion === 1 ? loadSetup(publishedRoster, stockSetup) : null;
  const config = loadSetup(read('setup', null), publishedSetup ?? stockSetup);
  const unsavedHistory = new Map();
  let session = null;
  let battle;
  let previewMap = generateMap(seed());
  let editIndex = 0;
  let customDraft = '';
  let validating = false;
  let lastFrame = performance.now();
  let displayedTenth = -1;
  let speed = 1;

  function seed() {
    return crypto.getRandomValues(new Uint32Array(1))[0];
  }

  function isStrategy(type) {
    return type === 'custom' || PRESETS.some((preset) => preset.id === type);
  }

  function strategyLabel(type) {
    return type === 'custom' ? '自定义 JavaScript' : PRESETS.find((preset) => preset.id === type)?.label;
  }

  function codeFor(entry) {
    return entry.type === 'custom' ? entry.code : presetCode(entry.type);
  }

  function make(tag, className, value) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (value !== undefined) element.textContent = value;
    return element;
  }

  function active() {
    return session && session.phase !== 'complete';
  }

  function message(value, error = false) {
    const target = $('match-message');
    target.textContent = value;
    target.dataset.error = String(error);
  }

  function editorMessage(value, error = false) {
    const target = $('strategy-message');
    target.textContent = value;
    target.dataset.error = String(error);
  }

  function activeEntries() {
    return config.entries.slice(0, config.count);
  }

  function battleEntries() {
    const entries = activeEntries();
    return entries.map((entry, i) => {
      const repeated = entries.some((other) => other !== entry && other.name.toLowerCase() === entry.name.toLowerCase());
      return { ...entry, displayName: repeated ? entry.name + ' #' + (i + 1) : entry.name };
    });
  }

  function renderSetup() {
    const rows = activeEntries().map((entry, i) => {
      const row = make('li', 'tank-row');
      row.style.setProperty('--tank-color', entry.color);
      const icon = make('span', 'tank-badge');
      icon.setAttribute('aria-hidden', 'true');
      const info = make('span', 'tank-info');
      const name = make('strong', '', entry.name);
      name.title = entry.name;
      info.append(name, make('small', '', strategyLabel(entry.type) + ' · v' + entry.version));
      const edit = make('button', 'button button-outline', '编辑');
      edit.type = 'button';
      edit.disabled = Boolean(active());
      edit.setAttribute('aria-label', '编辑 ' + entry.name);
      edit.addEventListener('click', () => openEditor(i));
      row.append(icon, info, edit);
      return row;
    });
    $('tank-list').replaceChildren(...rows);
    tankCount.disabled = roundCount.disabled = Boolean(active());
    $('load-published-roster').disabled = Boolean(active());
  }

  function scoreOrder(a, b) {
    return b.points - a.points || b.wins - a.wins || b.kills - a.kills || a.id.localeCompare(b.id, 'en', { numeric: true });
  }

  function scoresFor(entries) {
    return entries.map(({ id, name, displayName, color, type, version }) => ({
      id, name, displayName, color, type, version, wins: 0, kills: 0, points: 0
    }));
  }

  function renderScores() {
    const scores = session?.scores ?? scoresFor(battleEntries());
    const rows = [...scores].sort(scoreOrder).map((score) => {
      const row = make('tr');
      const nameCell = make('td');
      nameCell.style.setProperty('--tank-color', score.color);
      const name = make('span', 'score-name');
      name.title = score.displayName;
      name.append(make('span', 'score-dot'), document.createTextNode(score.displayName));
      nameCell.append(name);
      row.append(nameCell, make('td', '', score.wins), make('td', '', score.kills), make('td', '', score.points));
      return row;
    });
    $('score-list').replaceChildren(...rows);
  }

  function status(label, kind) {
    const target = $('arena-status');
    target.textContent = label;
    target.dataset.state = kind;
  }

  function overlay(label, title, detail) {
    $('overlay-label').textContent = label;
    $('overlay-title').textContent = title;
    $('overlay-description').textContent = detail;
    $('arena-overlay').hidden = false;
  }

  function hideOverlay() {
    $('arena-overlay').hidden = true;
  }

  function renderHud(force = false) {
    const tenth = Math.ceil(battle.timeLeft * 10);
    if (force || tenth !== displayedTenth) {
      displayedTenth = tenth;
      $('round-timer').textContent = (tenth / 10).toFixed(1) + ' s';
    }
    if (!force) return;
    $('map-size').textContent = battle.map.label;
    $('map-id').textContent = '#' + battle.map.id;
    $('map-id').title = battle.map.cols + ' × ' + battle.map.rows + ' 格';
    $('alive-count').textContent = battle.tanks.filter((tank) => tank.alive).length + ' / ' + battle.tanks.length;
    const shownRound = session?.phase === 'complete' ? session.records.length : session?.round ?? 0;
    $('round-display').textContent = shownRound + ' / ' + (session?.total ?? config.rounds);
  }

  function controls() {
    const running = Boolean(active());
    start.disabled = running;
    pause.disabled = !running;
    skip.disabled = !running || session.phase === 'intermission';
    end.disabled = !running;
    $('pause-text').textContent = session?.paused ? '继续' : '暂停';
    pause.setAttribute('aria-pressed', String(Boolean(session?.paused)));
    $('start-text').textContent = session?.phase === 'complete' ? '开始新比赛' : '开始对战';
  }

  function renderPreview() {
    if (session) return;
    battle = new Battle(previewMap, battleEntries(), 0);
    renderHud(true);
    renderScores();
    view.draw(battle);
  }

  function applySetup() {
    config.count = Number(tankCount.value);
    config.rounds = Number(roundCount.value);
    store('setup', config);
    renderSetup();
    renderPreview();
  }

  function exportRoster() {
    const roster = {
      formatVersion: 1,
      count: config.count,
      rounds: config.rounds,
      entries: activeEntries().map(({ name, type, code, version }) => ({
        name, type, code: type === 'custom' ? code : '', version
      }))
    };
    const data = JSON.stringify(roster, null, 2);
    const script = 'globalThis.ArenaPublishedRoster = ' + data + ';\n';
    const url = URL.createObjectURL(new Blob([script], { type: 'text/javascript;charset=utf-8' }));
    const link = make('a');
    link.href = url;
    link.download = 'published-roster.js';
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function usePublishedRoster() {
    if (!publishedSetup || active()) return;
    const { count, rounds, entries } = publishedSetup;
    if (!window.confirm('载入发布阵容？这会替换前 ' + count + ' 个坦克的当前配置。')) return;
    config.entries.splice(0, count, ...entries.slice(0, count).map((entry) => ({ ...entry })));
    tankCount.value = count;
    roundCount.value = rounds;
    applySetup();
  }

  function openEditor(i) {
    if (active()) return;
    editIndex = i;
    const entry = config.entries[i];
    $('strategy-heading').textContent = '编辑 ' + entry.name;
    nameField.value = entry.name;
    strategyType.value = entry.type;
    customDraft = entry.code;
    renderEditorCode();
    editorMessage('');
    editor.showModal();
    nameField.focus();
  }

  function renderEditorCode() {
    const custom = strategyType.value === 'custom';
    codeField.readOnly = !custom;
    codeField.value = custom ? customDraft : presetCode(strategyType.value);
    $('editor-note').innerHTML = custom
      ? '定义一个同步的 <code>function decide(state)</code>，返回移动、转向和开火指令。炮筒随车身转动。'
      : '这里显示内置策略的源代码。选择「自定义 JavaScript」即可基于它编辑。';
  }

  function setCustom(code) {
    customDraft = code;
    strategyType.value = 'custom';
    renderEditorCode();
    codeField.focus();
  }

  function setValidating(busy) {
    validating = busy;
    for (const control of [
      nameField, strategyType, codeField, $('load-example'), $('import-code'), $('check-strategy'), $('save-strategy'),
      editor.querySelector('[data-close]')
    ]) control.disabled = busy;
  }

  async function validateEditor(commit) {
    if (validating) return;
    const entry = config.entries[editIndex];
    const name = nameField.value.trim();
    const type = strategyType.value;
    const code = type === 'custom' ? customDraft.trim() : '';
    if (commit && !name) {
      editorMessage('请输入坦克名称。', true);
      nameField.focus();
      return;
    }
    if (type === 'custom' && (!code || new TextEncoder().encode(code).length > MAX_CODE)) {
      editorMessage(code ? '策略大小需在 64 KB 以内。' : '请粘贴或导入策略代码。', true);
      return;
    }
    if (!commit || type === 'custom') {
      setValidating(true);
      editorMessage('正在检查策略…');
      let runner;
      try {
        const test = new Battle(generateMap(1357), defaults.slice(0, 2), 1);
        runner = new StrategyRunner(codeFor({ type, code }), 9375);
        await runner.ready;
        const snapshot = test.snapshot();
        await runner.run({ ...snapshot, self: snapshot.tanks[0] });
        editorMessage('通过加载和首帧决策检查。');
      } catch (error) {
        editorMessage(error.message, true);
        return;
      } finally {
        runner?.close();
        setValidating(false);
      }
    }
    if (!commit) return;
    if (entry.type !== type || entry.code !== code) entry.version++;
    Object.assign(entry, { name, type, code });
    store('setup', config);
    editor.close();
    renderSetup();
    renderPreview();
    $('tank-list').children[editIndex]?.querySelector('button')?.focus();
  }

  function closeRunners(current) {
    for (const runner of current.runners.values()) runner.close();
    current.runners.clear();
  }

  function startMatch() {
    if (active()) return;
    const entries = battleEntries();
    session = {
      id: seed().toString(16) + '-' + Date.now(), started: new Date().toISOString(),
      entries, total: config.rounds, round: 0, scores: scoresFor(entries), records: [],
      runners: new Map(), previousSize: null, mapIds: new Set(), phase: 'loading', paused: false
    };
    message(canStore ? '' : '浏览器未提供可用的本地存储，记录可能仅在本页可见。', !canStore);
    renderSetup();
    renderScores();
    void beginRound(session);
  }

  async function beginRound(current) {
    closeRunners(current);
    let map;
    do {
      map = generateMap(seed(), current.previousSize);
    } while (current.mapIds.has(map.id));
    current.previousSize = map.label;
    current.mapIds.add(map.id);
    current.round++;
    current.phase = 'loading';
    current.accumulator = 0;
    current.decisionTick = -1;
    current.waiting = false;
    current.actions = Object.create(null);
    const game = new Battle(map, current.entries, current.round);
    battle = game;
    const launch = current.entries.map(async (entry, i) => {
      let runner;
      try {
        runner = new StrategyRunner(codeFor(entry), (map.seed ^ Math.imul(i + 1, 71389)) >>> 0);
        current.runners.set(entry.id, runner);
        await runner.ready;
      } catch (error) {
        runner?.close();
        if (battle !== game || current.phase !== 'loading') return;
        current.runners.delete(entry.id);
        game.remove(game.tanks[i], null, error.message);
      }
    });
    status(current.paused ? '已暂停' : '载入中', current.paused ? 'paused' : 'ready');
    overlay('第 ' + current.round + ' 局', current.paused ? '已暂停' : '载入策略', map.label + '地图 · #' + map.id);
    renderHud(true);
    controls();
    view.draw(game);

    await Promise.all(launch);
    if (battle !== game || current.phase !== 'loading') return;
    current.phase = 'playing';
    if (!current.paused) {
      status('对战中', 'live');
      hideOverlay();
    }
  }

  async function decisions(current, game) {
    current.waiting = true;
    current.decisionTick = game.tick;
    const snapshot = game.snapshot();
    const work = snapshot.tanks.filter((tank) => tank.alive).map(async (tank) => {
      const runner = current.runners.get(tank.id);
      if (!runner) return [tank.id, IDLE, null];
      try {
        const action = await runner.run({ ...snapshot, self: tank });
        return [tank.id, sanitize(action), null];
      } catch (error) {
        return [tank.id, IDLE, error.message];
      }
    });
    const results = await Promise.all(work);
    if (battle !== game || current.phase !== 'playing') return;
    for (const [id, action, error] of results) {
      current.actions[id] = action;
      if (!error) continue;
      current.runners.get(id)?.close();
      current.runners.delete(id);
      game.remove(game.tanks.find((tank) => tank.id === id), null, error);
    }
    current.waiting = false;
  }

  function processEvents(game) {
    if (!game.events.length) return;
    const events = game.events.splice(0);
    view.addEvents(events);
    const noteworthy = events.filter((event) => event.kind !== 'fire');
    if (!noteworthy.length) return;
    renderHud(true);
    const errors = noteworthy.filter((event) => event.kind === 'error');
    if (errors.length) {
      message(errors.map(({ tank }) => tank.name + ' 退出本局 · ' + tank.error).join('　'), true);
      return;
    }
    const hit = noteworthy.at(-1);
    message(hit.owner === hit.tank ? hit.tank.name + ' 被自己的反弹弹丸淘汰' :
      (hit.owner ? hit.owner.name + ' 淘汰了 ' + hit.tank.name : hit.tank.name + ' 已淘汰'));
  }

  function persist(current) {
    const match = {
      id: current.id, started: current.started, total: current.total, endedEarly: Boolean(current.endedEarly),
      scores: current.scores.map((score) => ({ ...score })), rounds: [...current.records]
    };
    if (store('match.' + match.id, match)) unsavedHistory.delete(match.id);
    else unsavedHistory.set(match.id, match);
    if (historyDialog.open) renderHistory();
  }

  function finishMatch(current, result, endedEarly = false) {
    current.phase = 'complete';
    current.paused = false;
    current.endedEarly = endedEarly;
    status(endedEarly ? '已提前结束' : '已结束', 'ready');
    const ranked = [...current.scores].sort(scoreOrder);
    const leaders = ranked.filter((score) => score.points === ranked[0].points);
    const names = leaders.map((score) => score.displayName).join('、');
    const detail = ranked[0].points > 0
      ? (leaders.length > 1 ? '并列第一 · ' : '最高分 · ') + names + ' · ' + ranked[0].points + ' 分'
      : '全场 0 分';
    overlay(result, '比赛结束', detail);
    renderSetup();
  }

  function endMatch() {
    if (!active() || !window.confirm('提前结束这场比赛？已结算的局会保留，未结算的局不计分。')) return;
    const current = session;
    closeRunners(current);
    finishMatch(current, '提前结束 · ' + current.records.length + ' / ' + current.total + ' 局', true);
    renderHud(true);
    controls();
    message('比赛已提前结束，保留 ' + current.records.length + ' 局记录。');
    persist(current);
    start.focus();
  }

  function finishRound(skipped = false) {
    const current = session;
    const game = battle;
    if (!current || !['playing', 'loading'].includes(current.phase)) return;
    closeRunners(current);
    processEvents(game);
    const winner = skipped ? null : game.result.winner;
    const kills = skipped ? [] : game.tanks.filter((tank) => tank.kills > 0).map(({ id, kills }) => ({ id, kills }));
    for (const score of current.scores) {
      const roundKills = kills.find((tank) => tank.id === score.id)?.kills ?? 0;
      const win = score.id === winner ? 1 : 0;
      score.kills += roundKills;
      score.wins += win;
      score.points += win * 3 + roundKills;
    }
    current.records.push({
      round: current.round, map: game.map.id, size: game.map.label, skipped, winner, kills,
      errors: game.tanks.filter((tank) => tank.error).map(({ id, error }) => ({ id, error })),
      reason: skipped ? 'skip' : game.result.reason
    });
    const name = current.entries.find((entry) => entry.id === winner)?.displayName;
    const result = skipped ? '本局已跳过' : name ? name + ' 获胜' : '本局平局';
    if (skipped) message('第 ' + current.round + ' 局已跳过，本局积分不计入。');
    if (current.round === current.total) {
      finishMatch(current, result);
    } else {
      current.phase = 'intermission';
      current.intermission = 2;
      status(current.paused ? '已暂停' : '局间休息', current.paused ? 'paused' : 'ready');
      overlay('第 ' + current.round + ' 局', result,
        current.paused ? '继续后自动开始下一局' : '下一局将生成新地图');
    }
    renderHud(true);
    renderScores();
    controls();
    persist(current);
  }

  function togglePause() {
    const current = session;
    if (!active()) return;
    current.paused = !current.paused;
    current.accumulator = 0;
    if (current.paused) {
      status('已暂停', 'paused');
      overlay('第 ' + current.round + ' 局', '已暂停', '点「继续」恢复比赛');
    } else if (current.phase === 'playing') {
      status('对战中', 'live');
      hideOverlay();
    } else if (current.phase === 'loading') {
      status('载入中', 'ready');
      overlay('第 ' + current.round + ' 局', '载入策略', battle.map.label + '地图 · #' + battle.map.id);
    } else {
      status('局间休息', 'ready');
      overlay('第 ' + current.round + ' 局', '准备下一局', '下一局将生成新地图');
    }
    controls();
  }

  function frame(now) {
    view.syncPixelRatio();
    const wallTime = Math.min((now - lastFrame) / 1000, 0.06);
    lastFrame = now;
    const current = session;
    if (current?.phase === 'playing' && !current.paused && !document.hidden) {
      const game = battle;
      current.accumulator = Math.min(current.accumulator + wallTime * speed, 0.15);
      while (current.accumulator >= STEP && !current.waiting && !game.result) {
        if (game.tick % 15 === 0 && current.decisionTick !== game.tick) {
          void decisions(current, game);
          break;
        }
        game.step(current.actions);
        current.accumulator -= STEP;
      }
      processEvents(game);
      renderHud();
      view.draw(game, wallTime * speed);
      if (game.result) finishRound();
    } else if (current?.phase === 'intermission' && !current.paused && !document.hidden) {
      view.draw(battle, wallTime * speed);
      current.intermission -= wallTime * speed;
      if (current.intermission <= 0) void beginRound(current);
    }
    requestAnimationFrame(frame);
  }

  function archiveTable(headers, rows) {
    const table = make('table', 'archive-table');
    const head = make('thead');
    const header = make('tr');
    for (const column of headers) {
      const th = make('th', '', column);
      th.scope = 'col';
      header.append(th);
    }
    head.append(header);
    const body = make('tbody');
    for (const cells of rows) {
      const row = make('tr');
      row.append(...cells.map((value) => make('td', '', value)));
      body.append(row);
    }
    table.append(head, body);
    return table;
  }

  function historyMatches() {
    const matches = new Map(unsavedHistory);
    try {
      for (const key of Object.keys(localStorage)) {
        if (!key.startsWith(MATCH_PREFIX)) continue;
        const id = key.slice(MATCH_PREFIX.length);
        if (matches.has(id)) continue;
        const match = read('match.' + id, null);
        if (match?.id === id && Number.isFinite(Date.parse(match.started)) &&
            Array.isArray(match.rounds) && Array.isArray(match.scores)) matches.set(id, match);
      }
    } catch {
      canStore = false;
    }
    return [...matches.values()].sort((a, b) => b.started.localeCompare(a.started));
  }

  function isLiveMatch(match) {
    return active() && match.id === session.id;
  }

  function historyMessage(value, error = false) {
    const label = $('history-message');
    label.textContent = value;
    label.dataset.error = String(error);
  }

  function deleteHistory(matches, confirmation) {
    const targets = matches.filter((match) => !isLiveMatch(match));
    if (!targets.length || !window.confirm(confirmation)) return;
    let deleted = 0;
    for (const match of targets) {
      try {
        localStorage.removeItem(MATCH_PREFIX + match.id);
      } catch {
        continue;
      }
      unsavedHistory.delete(match.id);
      deleted++;
    }
    renderHistory();
    historyMessage(deleted === targets.length
      ? '已删除 ' + deleted + ' 场比赛记录。'
      : '已删除 ' + deleted + ' 场。浏览器未能删除其余 ' + (targets.length - deleted) + ' 场。',
    deleted !== targets.length);
    const focus = clearHistory.disabled ? historyDialog.querySelector('[data-close]') : clearHistory;
    focus.focus();
  }

  function renderHistory() {
    const list = $('history-list');
    const matches = historyMatches();
    clearHistory.disabled = !matches.some((match) => !isLiveMatch(match));
    if (!matches.length) {
      list.replaceChildren(make('p', 'history-empty', '还没有比赛记录。'));
      return;
    }
    const formatDate = new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' });
    list.replaceChildren(...matches.map((match, i) => {
      const record = make('div', 'history-record');
      const details = make('details');
      details.open = i === 0;
      const date = formatDate.format(new Date(match.started));
      const live = isLiveMatch(match);
      const progress = live ? ' · 进行中' :
        match.endedEarly ? ' · 提前结束' : match.rounds.length < match.total ? ' · 未完成' : '';
      const summary = make('summary', '', date + ' · ' + match.scores.length + ' 辆坦克 · ' +
        match.rounds.length + '/' + match.total + ' 局' + progress);
      const body = make('div', 'history-body');
      const ranking = [...match.scores].sort(scoreOrder).map(
        ({ displayName, type, version, wins, kills, points }) => [displayName, strategyLabel(type) + ' v' + version, wins, kills, points]
      );
      const name = (id) => match.scores.find((tank) => tank.id === id)?.displayName ?? '';
      const rounds = match.rounds.map((record) => {
        const { round, map, size, skipped, winner, kills, errors } = record;
        const result = skipped ? '跳过' : winner ? name(winner) + ' 获胜' : record.reason === 'time' ? '超时平局' : '平局';
        const hits = kills.map(({ id, kills: count }) => name(id) + ' ×' + count);
        const issues = errors.map(({ id, error }) => name(id) + ' · ' + error);
        return ['第 ' + round + ' 局', size + ' #' + map, result, [...hits, ...issues].join('；') || '—'];
      });
      body.append(
        make('h3', '', '本场排名'), archiveTable(['坦克', '策略版本', '胜局', '击杀', '总分'], ranking),
        make('h3', '', '逐局结果'),
        rounds.length ? archiveTable(['局数', '地图', '结果', '击杀与异常'], rounds) :
          make('p', 'history-no-rounds', '本场尚无结算局。')
      );
      details.append(summary, body);
      record.append(details);
      if (!live) {
        const remove = make('button', 'button button-danger history-delete', '删除');
        remove.type = 'button';
        remove.setAttribute('aria-label', '删除 ' + date + ' 的比赛记录');
        remove.addEventListener('click', () => {
          deleteHistory([match], '删除这场比赛的记录？删除后无法恢复。');
        });
        record.append(remove);
      }
      return record;
    }));
  }

  const prompt = [
    '为 AI 坦克竞技场编写一段 JavaScript 策略，只输出纯 JavaScript 源码。使用同步 function decide(state)，可在同一文件声明辅助函数和跨帧变量。不要使用 import、export、DOM、网络或异步 API。每局会重新加载代码，每 0.125 个游戏秒调用一次，单次执行上限 240 毫秒。',
    'state.self 是自己的坦克，state.tanks 是所有坦克。坦克字段为 id, x, y, angle, turret, cooldown, alive, kills。angle 是车身和炮筒的共同朝向，turret 是为旧策略保留的同一读数。state.bullets 记录 id, ownerId, x, y, vx, vy, bounces。弹丸会反弹，反弹后能击中发射者，一次命中淘汰。每枚弹丸最长存在 8 个游戏秒，每辆坦克最多同时有 5 枚弹丸在场。',
    'state.map 提供 id, width, height, cols, rows, cellSize, wallWidth, walls, exits。walls 是从小坐标到大坐标的水平或竖直墙中心线段 [x1,y1,x2,y2]。exits[i] 是第 i 个格子的相邻可达格子，格子按行从 0 编号。原点在左上角，车身和炮筒朝右时为 0 弧度，顺时针为正。state.tick 是 120 Hz 的帧编号，state.round 从 1 开始，state.timeLeft 为剩余秒数。',
    '返回 { throttle, turn, fire }。throttle 与 turn 取 -1 到 1，分别表示车速和转向。用 turn 把整个车身转向目标，再用 fire: true 沿正前方开火。每局 45 秒，唯一幸存者得 3 分，击杀对手得 1 分。请设计能在未知地图里寻路、避弹和交火的策略。',
    '最小示例：\n' + EXAMPLE
  ].join('\n\n');

  async function copyGuide() {
    const label = $('copy-message');
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(prompt);
      } else {
        const field = make('textarea');
        field.value = prompt;
        $('guide-dialog').append(field);
        field.select();
        const copied = document.execCommand('copy');
        field.remove();
        if (!copied) throw new Error('copy');
      }
      label.textContent = '已复制';
    } catch {
      const manual = $('guide-dialog').querySelector('[data-copy-fallback]') ?? make('textarea');
      manual.dataset.copyFallback = '';
      manual.value = prompt;
      manual.readOnly = true;
      manual.setAttribute('aria-label', '策略提示词');
      $('guide-dialog').querySelector('.dialog-inner').append(manual);
      manual.select();
      label.textContent = '提示词已选中，按 Ctrl+C 复制';
    }
  }

  for (const { id, label } of PRESETS) strategyType.add(new Option('内置 · ' + label, id));
  strategyType.add(new Option('自定义 JavaScript', 'custom'));
  tankCount.value = config.count;
  roundCount.value = config.rounds;
  $('export-roster').addEventListener('click', exportRoster);
  $('load-published-roster').hidden = !publishedSetup;
  $('load-published-roster').addEventListener('click', usePublishedRoster);
  tankCount.addEventListener('change', applySetup);
  roundCount.addEventListener('change', applySetup);
  speedSelect.addEventListener('change', () => { speed = Number(speedSelect.value); });
  start.addEventListener('click', startMatch);
  pause.addEventListener('click', togglePause);
  skip.addEventListener('click', () => finishRound(true));
  end.addEventListener('click', endMatch);
  nameField.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') void validateEditor(true);
  });
  strategyType.addEventListener('change', () => {
    if (strategyType.value === 'custom' && !customDraft) customDraft = codeField.value || EXAMPLE;
    renderEditorCode();
    editorMessage('');
  });
  codeField.addEventListener('input', () => {
    customDraft = codeField.value;
    editorMessage('');
  });
  $('load-example').addEventListener('click', () => {
    setCustom(EXAMPLE);
    editorMessage('示例已载入编辑区。');
  });
  $('import-code').addEventListener('click', () => $('strategy-file').click());
  $('strategy-file').addEventListener('change', async (event) => {
    const file = event.target.files[0];
    event.target.value = '';
    if (!file) return;
    if (file.size > MAX_CODE) {
      editorMessage('导入文件需在 64 KB 以内。', true);
      return;
    }
    const index = editIndex;
    try {
      const source = await file.text();
      if (!editor.open || index !== editIndex || validating) return;
      setCustom(source);
      editorMessage('已导入 ' + file.name + '，可先检查再保存。');
    } catch {
      editorMessage('读取文件失败。', true);
    }
  });
  $('check-strategy').addEventListener('click', () => void validateEditor(false));
  $('save-strategy').addEventListener('click', () => void validateEditor(true));
  $('guide-example').textContent = EXAMPLE;
  $('copy-guide').addEventListener('click', () => void copyGuide());
  $('open-guide').addEventListener('click', () => {
    $('copy-message').textContent = '';
    $('guide-dialog').showModal();
  });
  $('open-history').addEventListener('click', () => {
    historyMessage('');
    renderHistory();
    historyDialog.showModal();
  });
  clearHistory.addEventListener('click', () => {
    deleteHistory(historyMatches(), '清空历史记录？删除后无法恢复。');
  });
  window.addEventListener('storage', (event) => {
    if (historyDialog.open && (event.key === null || event.key.startsWith(MATCH_PREFIX))) renderHistory();
  });
  for (const button of document.querySelectorAll('[data-close]')) {
    button.addEventListener('click', () => button.closest('dialog').close());
  }
  editor.addEventListener('cancel', (event) => { if (validating) event.preventDefault(); });

  renderSetup();
  renderPreview();
  controls();
  if (!canStore) message('浏览器未提供可用的本地存储，记录可能仅在本页可见。', true);
  requestAnimationFrame(frame);
})();
