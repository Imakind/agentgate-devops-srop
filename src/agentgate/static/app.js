/* AgentGate: deterministic evaluation of supplied logs. No model or tool execution. */
(() => {
  'use strict';

  const MAX_BYTES = 512 * 1024;
  const MAX_STEPS = 100;
  const $ = (id) => document.getElementById(id);
  const format = (number) => new Intl.NumberFormat('ru-RU').format(Number(number) || 0);
  const state = {
    examples: [], defaultPolicy: null, policy: null, trace: null, result: null,
    selectedId: null, filter: 'all', busy: false, requestId: 0,
    controller: null, retry: null, toastTimer: null, imported: false, rawTrace: null, importController: null,
  };

  function node(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined && text !== null) element.textContent = String(text);
    return element;
  }

  function icon(name, className = '') {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', `icon ${className}`.trim());
    svg.setAttribute('aria-hidden', 'true');
    const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    use.setAttribute('href', `#i-${name}`);
    svg.append(use);
    return svg;
  }

  function setText(id, text) { $(id).textContent = String(text ?? ''); }
  function clone(value) { return JSON.parse(JSON.stringify(value)); }
  function safeDetail(value) {
    if (typeof value === 'string') return value;
    if (Array.isArray(value)) return value.map(safeDetail).join(' · ');
    if (value && typeof value === 'object') return JSON.stringify(value);
    return String(value ?? '');
  }

  async function request(path, options = {}, asBlob = false) {
    let response;
    try {
      response = await fetch(path, { cache: 'no-store', ...options });
    } catch (error) {
      if (error.name === 'AbortError') throw error;
      throw new Error('Сервис недоступен. Проверьте, что локальный сервер AgentGate запущен.');
    }
    if (!response.ok) {
      let data;
      try { data = await response.json(); } catch { /* An error response may not be JSON. */ }
      const error = new Error(data?.error?.message || `Сервис вернул ошибку HTTP ${response.status}.`);
      error.details = Array.isArray(data?.error?.details) ? data.error.details.map(safeDetail).join('\n') : '';
      throw error;
    }
    if (asBlob) return response.blob();
    try { return await response.json(); }
    catch { throw new Error('Сервис вернул некорректный JSON. Проверьте журнал локального сервера.'); }
  }

  function showError(error, retry) {
    setText('app-error-title', error.message || 'Не удалось завершить проверку.');
    setText('app-error-details', error.details || 'Вы можете исправить данные и попробовать ещё раз.');
    $('app-error').hidden = false;
    state.retry = retry || null;
    $('retry-button').hidden = !state.retry;
  }
  function hideError() { $('app-error').hidden = true; state.retry = null; }
  function toast(message) {
    clearTimeout(state.toastTimer);
    setText('toast-text', message);
    $('toast').hidden = false;
    state.toastTimer = setTimeout(() => { $('toast').hidden = true; }, 4000);
  }

  function setBusy(busy) {
    state.busy = busy;
    $('run-button').disabled = busy || !state.trace || !state.policy;
    $('example-select').disabled = !state.examples.length;
    $('export-json').disabled = busy || !state.result;
    $('export-junit').disabled = busy || !state.result;
    $('run-button').replaceChildren(
      busy ? node('span', 'loading-spinner') : icon('play'),
      node('span', '', busy ? 'Проверяем…' : 'Проверить трассу'),
    );
    $('run-button').setAttribute('aria-busy', String(busy));
  }

  function updatePolicyPreview() {
    if (!state.policy) return;
    const custom = ['allowed_tools', 'allowed_domains', 'approval_required_tools'].some((key) =>
      JSON.stringify([...state.policy[key]].sort()) !== JSON.stringify([...state.defaultPolicy[key]].sort()))
      || state.policy.max_tokens !== state.defaultPolicy.max_tokens
      || state.policy.max_tool_calls !== state.defaultPolicy.max_tool_calls;
    setText('policy-name', custom ? 'Custom policy' : 'Default policy');
    setText('policy-limits', `${format(state.policy.max_tokens)} токенов · ${format(state.policy.max_tool_calls)} вызовов`);
  }

  function renderSource() {
    if (!state.trace) return;
    setText('source-badge', state.imported ? 'Импортированный лог' : 'Учебный сценарий');
    setText('scenario-description', state.trace.description || 'Проверьте инструменты, домены, подтверждения и лимиты этой трассы.');
    setText('trace-id', `TRACE / ${state.trace.id || 'imported'}`);
    updatePolicyPreview();
  }

  function renderMetrics() {
    const summary = state.result?.summary;
    const total = summary?.total_steps ?? state.trace?.steps?.length ?? 0;
    setText('metric-steps', state.trace ? format(total) : '—');
    setText('metric-steps-detail', state.trace ? `Вызовов инструментов: ${format(summary?.tool_calls ?? total)}` : 'Ожидание трассы');
    setText('metric-passed', summary ? format(summary.passed_steps) : '—');
    const percent = total ? Math.round((summary?.passed_steps || 0) / total * 100) : 0;
    setText('metric-passed-detail', summary ? `${percent}% шагов прошли проверку` : 'Ожидание проверки');
    $('pass-track').value = Math.min(100, Math.max(0, percent));
    $('metric-tokens').replaceChildren(document.createTextNode(summary ? format(summary.total_tokens) : '—'));
    $('metric-tokens').append(node('span', 'metric-unit', state.policy ? `/ ${format(state.policy.max_tokens)}` : ''));
    const overBudget = summary && summary.total_tokens > state.policy.max_tokens;
    $('metric-tokens').classList.toggle('over-budget', Boolean(overBudget));
    setText('metric-tokens-detail', overBudget ? 'Лимит токенов превышен' : 'Из предоставленного лога');
    const tokenPercent = state.policy?.max_tokens > 0 ? (summary?.total_tokens || 0) / state.policy.max_tokens * 100 : (summary?.total_tokens ? 100 : 0);
    $('token-track').value = Math.min(100, Math.max(0, tokenPercent));
    $('token-track').classList.toggle('over-budget', Boolean(overBudget));
    const violations = summary?.violations ?? state.result?.violations?.length ?? 0;
    setText('metric-violations', summary ? format(violations) : '—');
    $('metric-violations').classList.toggle('has-violations', Boolean(summary && violations));
    $('metric-violations').classList.toggle('clear-violations', Boolean(summary && !violations));
    setText('metric-violations-detail', summary ? (violations ? 'Требуют вашего внимания' : 'Все правила соблюдены') : 'Ожидание проверки');
    $('violation-dot').classList.toggle('has-violations', Boolean(summary && violations));
    $('violation-dot').classList.toggle('clear-violations', Boolean(summary && !violations));
  }

  function renderBanner(mode, error) {
    const banner = $('result-banner');
    banner.className = `result-banner ${mode}`;
    const result = state.result;
    if (mode === 'loading') {
      $('result-icon').replaceChildren(node('span', 'loading-spinner'));
      setText('result-title', 'Проверяем каждый шаг');
      setText('result-status', 'EVALUATING');
      setText('result-description', 'Сверяем предоставленный лог с текущей политикой.');
    } else if (mode === 'error') {
      $('result-icon').replaceChildren(icon('alert'));
      setText('result-title', 'Проверка не завершена');
      setText('result-status', 'ERROR');
      setText('result-description', error || 'Исправьте данные или повторите запрос.');
    } else if (mode === 'passed') {
      $('result-icon').replaceChildren(icon('check'));
      setText('result-title', 'Трасса прошла проверку');
      setText('result-status', 'PASSED');
      setText('result-description', `Проверено шагов: ${format(result.summary.total_steps)}. Все действия соответствуют заданной политике.`);
    } else if (mode === 'failed') {
      $('result-icon').replaceChildren(icon('alert'));
      setText('result-title', 'Обнаружены нарушения политики');
      setText('result-status', 'FAILED');
      setText('result-description', `Нарушений: ${format(result.summary.violations ?? result.violations.length)}. Откройте шаг, чтобы разобраться в причинах.`);
    } else {
      $('result-icon').replaceChildren(icon('activity'));
      setText('result-title', 'Трасса готова к проверке');
      setText('result-status', 'READY');
      setText('result-description', 'Запустите проверку с текущей политикой.');
    }
    $('result-status').className = `badge badge-${['passed', 'failed'].includes(mode) ? mode : 'neutral'}`;
    if (!['passed', 'failed'].includes(mode)) setText('result-time', '');
  }

  function toolIcon(tool) {
    const value = String(tool).toLowerCase();
    if (/web|http|fetch|browse|search/.test(value)) return 'globe';
    if (/shell|exec|terminal|command/.test(value)) return 'terminal';
    if (/send|mail|write|publish/.test(value)) return 'arrow';
    return 'code';
  }

  function emptyState(title, description, name = 'activity') {
    const box = node('div', 'empty-state');
    box.append(icon(name, 'large'), node('h3', '', title), node('p', '', description));
    return box;
  }

  function renderSteps() {
    const list = $('trace-list');
    list.replaceChildren();
    const steps = state.result?.steps || state.trace?.steps || [];
    const failed = steps.filter((step) => step.status === 'failed').length;
    setText('step-count', steps.length);
    setText('issue-filter-count', failed);
    const visibleSteps = state.filter === 'issues' ? steps.filter((step) => step.status === 'failed') : steps;
    if (!visibleSteps.length) {
      list.append(emptyState(state.filter === 'issues' ? 'Шагов с нарушениями нет' : 'В трассе пока нет шагов', state.filter === 'issues' ? 'Посмотрите общие проверки ниже или вернитесь ко всем шагам.' : 'Выберите учебный сценарий или импортируйте свой JSON.', state.filter === 'issues' ? 'check' : 'code'));
    }
    visibleSteps.forEach((step) => {
      const index = steps.indexOf(step);
      const row = node('button', `trace-row${state.selectedId === step.id ? ' selected' : ''}`);
      row.type = 'button';
      row.setAttribute('aria-pressed', String(state.selectedId === step.id));
      const readableStatus = step.status === 'passed' ? 'пройден' : step.status === 'failed' ? 'с нарушениями' : 'ожидает проверки';
      row.setAttribute('aria-label', `Шаг ${index + 1}: ${step.tool}, ${readableStatus}`);
      const tool = node('span', 'step-tool-icon');
      tool.append(icon(toolIcon(step.tool)));
      const info = node('span', 'step-row-info');
      const name = node('span', 'step-tool-line');
      name.append(node('strong', 'mono', step.tool));
      info.append(name, node('p', '', step.description || 'Описание отсутствует'));
      if (step.violations?.length) {
        const message = node('p', 'inline-violation');
        message.append(icon('alert'), document.createTextNode(step.violations[0].message || step.violations[0].code));
        info.append(message);
      }
      const tokens = node('span', 'step-token mono');
      tokens.append(document.createTextNode(format(step.tokens)));
      if (step.status) tokens.append(icon(step.status === 'passed' ? 'check' : 'alert', `row-status ${step.status === 'failed' ? 'failed' : ''}`));
      row.append(node('span', 'step-number mono', String(index + 1).padStart(2, '0')), tool, info, tokens);
      row.addEventListener('click', () => {
        state.selectedId = step.id;
        renderSteps();
        renderDetail();
        // Preserve focus when rebuilding the list after selection.
        const next = [...list.querySelectorAll('button')].find((item) => item.getAttribute('aria-pressed') === 'true');
        next?.focus({ preventScroll: true });
      });
      list.append(row);
    });
  }

  function property(label, value, mono = false) {
    const property = node('div', 'detail-property');
    property.append(node('span', '', label), node('strong', mono ? 'mono' : '', value));
    return property;
  }

  function renderDetail() {
    const container = $('step-detail');
    container.replaceChildren();
    const steps = state.result?.steps || state.trace?.steps || [];
    const step = steps.find((item) => item.id === state.selectedId);
    if (!step) {
      setText('inspector-index', '— / —');
      container.append(emptyState('Выберите шаг', 'Нажмите на строку трассы, чтобы изучить проверку.', 'terminal'));
      return;
    }
    const index = steps.indexOf(step);
    const originalStep = state.trace?.steps?.find((item) => item.id === step.id) || step;
    setText('inspector-index', `${String(index + 1).padStart(2, '0')} / ${String(steps.length).padStart(2, '0')}`);
    const heading = node('div', 'detail-title-row');
    heading.append(node('h3', 'mono', step.tool), node('span', `badge badge-${step.status === 'passed' ? 'passed' : step.status === 'failed' ? 'failed' : 'neutral'}`, step.status === 'passed' ? 'PASSED' : step.status === 'failed' ? 'FAILED' : 'PENDING'));
    container.append(heading, node('p', 'detail-description', step.description || 'Описание не указано в трассе.'));
    if (step.url || originalStep.url) {
      const url = node('div', 'detail-section');
      const label = node('div', 'detail-label', 'ЦЕЛЕВОЙ URL');
      url.append(label, node('div', 'detail-code', step.url || originalStep.url));
      container.append(url);
    }
    const props = node('div', 'detail-properties');
    props.append(property('STEP ID', step.id, true), property('ТОКЕНЫ', format(step.tokens), true));
    const required = state.policy?.approval_required_tools?.includes(step.tool);
    props.append(property('ПОДТВЕРЖДЕНИЕ', required ? 'Обязательно' : 'Не требуется'));
    props.append(property('APPROVAL ID', originalStep.approval_id || 'Не указан', true));
    container.append(props);
    const findings = node('div', 'detail-section');
    findings.append(node('div', 'detail-label', 'РЕЗУЛЬТАТ ПРОВЕРКИ'));
    const findingList = node('div', 'detail-findings');
    if (step.violations?.length) {
      step.violations.forEach((violation) => {
        const finding = node('div', 'finding');
        const body = node('div');
        body.append(node('div', 'finding-code mono', violation.code), node('p', '', violation.message));
        finding.append(icon('alert'), body);
        findingList.append(finding);
      });
    } else {
      const finding = node('div', `finding${step.status === 'passed' ? ' success' : ''}`);
      const body = node('div');
      body.append(node('div', 'finding-code', step.status === 'passed' ? 'Нарушений на этом шаге нет' : 'Ожидает проверки'), node('p', '', step.status === 'passed' ? 'Действие соответствует заданным ограничениям. Общие лимиты трассы показаны в контрольных проверках.' : 'Запустите проверку, чтобы получить результат для этого шага.'));
      finding.append(icon(step.status === 'passed' ? 'check' : 'clock'), body);
      findingList.append(finding);
    }
    findings.append(findingList);
    container.append(findings, node('p', 'inspector-note', 'Содержимое лога отображается как текст. URL не открываются, инструменты не исполняются.'));
  }

  function renderChecks() {
    const grid = $('checks-grid');
    grid.replaceChildren();
    if (!state.result) {
      grid.append(node('div', 'checks-placeholder muted', 'Результаты появятся после проверки трассы.'));
      return;
    }
    state.result.checks.forEach((check) => {
      const card = node('article', 'check-card');
      const top = node('div', 'check-card-top');
      const code = String(check.code || '').toLowerCase();
      const glyph = /domain|url/.test(code) ? 'globe' : /approval/.test(code) ? 'shield' : /token/.test(code) ? 'code' : /call/.test(code) ? 'activity' : 'terminal';
      const status = node('span', `check-status${check.passed ? '' : ' failed'}`);
      status.append(icon(check.passed ? 'check' : 'alert'), document.createTextNode(check.passed ? 'PASS' : 'FAIL'));
      top.append(icon(glyph), status);
      card.append(top, node('h3', '', check.label || check.code), node('p', '', safeDetail(check.details)));
      grid.append(card);
    });
  }

  async function evaluate() {
    if (!state.trace || !state.policy) return;
    state.controller?.abort();
    const requestId = ++state.requestId;
    state.controller = new AbortController();
    hideError();
    state.result = null;
    setBusy(true);
    renderBanner('loading');
    renderMetrics();
    renderSteps();
    renderDetail();
    renderChecks();
    const trace = clone(state.trace);
    const policy = clone(state.policy);
    try {
      const result = await request('/api/evaluate', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: evaluationBody(trace, policy), signal: state.controller.signal,
      });
      if (requestId !== state.requestId) return;
      if (!result.summary || !Array.isArray(result.steps) || !Array.isArray(result.checks) || !Array.isArray(result.violations) || !['passed', 'failed'].includes(result.status)) {
        throw new Error('Ответ сервиса не соответствует формату отчёта AgentGate.');
      }
      state.result = result;
      const selected = result.steps.find((step) => step.id === state.selectedId);
      if (!selected) state.selectedId = result.steps[0]?.id || null;
      renderMetrics();
      renderSteps();
      renderDetail();
      renderChecks();
      renderBanner(result.status);
      setText('result-time', `ПРОВЕРЕНО В ${new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`);
      // Keep the supplied-approval limitation visible even if the server adds a disclaimer.
      if (result.disclaimer) setText('disclaimer', `${result.disclaimer} Модели и инструменты не запускаются.`);
    } catch (error) {
      if (error.name === 'AbortError' || requestId !== state.requestId) return;
      showError(error, evaluate);
      renderBanner('error', error.message);
    } finally {
      if (requestId === state.requestId) setBusy(false);
    }
  }

  function selectExample(id) {
    const example = state.examples.find((item) => item.id === id);
    if (!example) return;
    state.trace = clone(example.trace);
    state.imported = false;
    state.rawTrace = null;
    state.selectedId = state.trace.steps?.[0]?.id || null;
    state.filter = 'all';
    updateFilterButtons();
    const importedOption = $('example-select').querySelector('option[data-imported]');
    importedOption?.remove();
    renderSource();
    evaluate();
  }

  function updateFilterButtons() {
    ['all', 'issues'].forEach((filter) => {
      const button = $(`filter-${filter}`);
      button.classList.toggle('selected', state.filter === filter);
      button.setAttribute('aria-pressed', String(state.filter === filter));
    });
  }

  function fillPolicy(policy) {
    setText('policy-error', '');
    $('policy-error').hidden = true;
    $('allowed-tools').value = policy.allowed_tools.join('\n');
    $('allowed-domains').value = policy.allowed_domains.join('\n');
    $('approval-tools').value = policy.approval_required_tools.join('\n');
    $('max-tokens').value = policy.max_tokens;
    $('max-calls').value = policy.max_tool_calls;
  }

  function openDialog(id) {
    if (id === 'policy-dialog') {
      if (!state.policy) { toast('Дождитесь загрузки политики.'); return; }
      fillPolicy(state.policy);
    }
    if (id === 'import-dialog') {
      $('import-error').hidden = true;
      $('sample-json').disabled = !state.trace;
    }
    $(id).showModal();
    document.body.classList.add('modal-open');
  }

  function closeDialog(id) { $(id).close(); }

  function listValue(id) {
    return [...new Set($(id).value.split(/[,\n]/).map((value) => value.trim()).filter(Boolean))];
  }

  function validateTrace(trace) {
    if (!trace || typeof trace !== 'object' || Array.isArray(trace)) throw new Error('Трасса должна быть JSON-объектом.');
    if (!Array.isArray(trace.steps)) throw new Error('В трассе нужен массив steps.');
    if (trace.steps.length > MAX_STEPS) throw new Error(`Допускается не более ${MAX_STEPS} шагов в одной трассе.`);
    if (!trace.steps.length) throw new Error('Добавьте хотя бы один шаг в массив steps.');
    if (trace.approvals !== undefined && !Array.isArray(trace.approvals)) throw new Error('Поле approvals должно быть массивом. Если подтверждений нет, укажите [] или пропустите это поле.');
    return trace;
  }

  async function readFile(file) {
    if (!file) return;
    $('import-error').hidden = true;
    if (file.size > MAX_BYTES) {
      setText('import-error', 'Файл слишком большой. Максимальный размер — 512 КиБ.');
      $('import-error').hidden = false;
      return;
    }
    try {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer());
      $('trace-json').value = text;
      toast(`Файл ${file.name} загружен в форму.`);
    } catch {
      setText('import-error', 'Не удалось прочитать файл. Используйте JSON в корректной кодировке UTF-8.');
      $('import-error').hidden = false;
    }
  }

  function evaluationBody(trace, policy, rawTrace = state.rawTrace) {
    // Keep imported bytes intact so the server can reject duplicate JSON keys.
    return `{"trace":${rawTrace || JSON.stringify(trace)},"policy":${JSON.stringify(policy)}}`;
  }

  async function exportReport(formatName) {
    if (!state.result || state.busy) return;
    const trace = clone(state.trace);
    const policy = clone(state.policy);
    const rawTrace = state.rawTrace;
    const button = $(`export-${formatName}`);
    button.disabled = true;
    button.setAttribute('aria-busy', 'true');
    try {
      const blob = await request(`/api/export?format=${formatName}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: evaluationBody(trace, policy, rawTrace),
      }, true);
      const url = URL.createObjectURL(blob);
      const anchor = node('a');
      const safeId = String(trace.id || 'trace').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 70) || 'trace';
      anchor.href = url;
      anchor.download = `agentgate-${safeId}.${formatName === 'junit' ? 'xml' : 'json'}`;
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
      toast(`${formatName === 'junit' ? 'JUnit XML' : 'JSON'}-отчёт подготовлен к скачиванию.`);
    } catch (error) {
      showError(error, () => exportReport(formatName));
    } finally {
      button.disabled = state.busy || !state.result;
      button.removeAttribute('aria-busy');
    }
  }

  function setTheme(theme) {
    document.documentElement.dataset.theme = theme;
    const label = theme === 'dark' ? 'Включить светлую тему' : 'Включить тёмную тему';
    $('theme-toggle').setAttribute('aria-label', label);
    $('theme-toggle').setAttribute('title', label);
    $('theme-toggle').replaceChildren(icon(theme === 'dark' ? 'sun' : 'moon'));
    try { localStorage.setItem('agentgate-theme', theme); } catch { /* Theme still works without storage. */ }
  }

  function bindEvents() {
    document.querySelectorAll('[data-open]').forEach((button) => {
      button.addEventListener('click', () => openDialog(button.dataset.open));
    });
    document.querySelectorAll('[data-close]').forEach((button) => {
      button.addEventListener('click', () => closeDialog(button.dataset.close));
    });
    document.querySelectorAll('dialog').forEach((dialog) => {
      dialog.addEventListener('close', () => {
        document.body.classList.remove('modal-open');
        if (dialog.id === 'import-dialog') state.importController?.abort();
      });
      dialog.addEventListener('click', (event) => {
        if (event.target !== dialog) return;
        const box = dialog.getBoundingClientRect();
        if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) dialog.close();
      });
    });
    $('run-button').addEventListener('click', evaluate);
    $('example-select').addEventListener('change', (event) => selectExample(event.target.value));
    $('retry-button').addEventListener('click', () => state.retry?.());
    $('theme-toggle').addEventListener('click', () => setTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'));
    ['all', 'issues'].forEach((filter) => {
      $(`filter-${filter}`).addEventListener('click', () => {
        state.filter = filter;
        updateFilterButtons();
        renderSteps();
      });
    });
    $('reset-policy').addEventListener('click', () => { if (state.defaultPolicy) fillPolicy(state.defaultPolicy); });
    $('policy-form').addEventListener('submit', (event) => {
      event.preventDefault();
      try {
        const tokens = $('max-tokens').value.trim();
        const calls = $('max-calls').value.trim();
        const maxTokens = Number(tokens);
        const maxCalls = Number(calls);
        if (!tokens || !calls || !Number.isSafeInteger(maxTokens) || !Number.isSafeInteger(maxCalls) || maxTokens < 0 || maxCalls < 0) {
          throw new Error('Укажите целые неотрицательные лимиты токенов и вызовов.');
        }
        if (maxTokens > 1000000 || maxCalls > 100) throw new Error('Максимум: 1 000 000 токенов и 100 вызовов.');
        const policy = {
          allowed_tools: listValue('allowed-tools'), allowed_domains: listValue('allowed-domains'),
          approval_required_tools: listValue('approval-tools'), max_tokens: maxTokens, max_tool_calls: maxCalls,
        };
        if (policy.allowed_domains.some((domain) => /[\s/:@?#*]/.test(domain))) throw new Error('Укажите точные домены без протокола, пути, порта и символа *.');
        state.policy = policy;
        closeDialog('policy-dialog');
        updatePolicyPreview();
        evaluate();
      } catch (error) {
        setText('policy-error', error.message);
        $('policy-error').hidden = false;
      }
    });
    $('trace-file').addEventListener('change', (event) => readFile(event.target.files[0]));
    $('upload-zone').addEventListener('dragover', (event) => { event.preventDefault(); $('upload-zone').classList.add('dragging'); });
    $('upload-zone').addEventListener('dragleave', () => $('upload-zone').classList.remove('dragging'));
    $('upload-zone').addEventListener('drop', (event) => {
      event.preventDefault();
      $('upload-zone').classList.remove('dragging');
      if (event.dataTransfer.files.length > 1) {
        setText('import-error', 'Загрузите один JSON-файл за раз.');
        $('import-error').hidden = false;
        return;
      }
      readFile(event.dataTransfer.files[0]);
    });
    $('sample-json').addEventListener('click', () => { if (state.trace) $('trace-json').value = JSON.stringify(state.trace, null, 2); });
    $('import-form').addEventListener('submit', async (event) => {
      event.preventDefault();
      const submit = $('import-form').querySelector('button[type=submit]');
      if (submit.disabled) return;
      submit.disabled = true;
      submit.setAttribute('aria-busy', 'true');
      $('import-error').hidden = true;
      try {
        const source = $('trace-json').value.trim();
        if (!source) throw new Error('Выберите JSON-файл или вставьте содержимое трассы.');
        if (new Blob([source]).size > MAX_BYTES) throw new Error('Размер JSON превышает 512 КиБ.');
        let parsed;
        try { parsed = JSON.parse(source); } catch { throw new Error('Не удалось прочитать JSON. Проверьте кавычки, запятые и скобки.'); }
        if (parsed?.trace && !parsed.steps) throw new Error('Импортируйте сам объект трассы (id, name, steps, approvals), а не отчёт или обёртку trace.');
        const trace = validateTrace(parsed);
        if (!state.policy) throw new Error('Сначала загрузите политику: закройте окно и нажмите «Повторить».');
        state.importController?.abort();
        state.importController = new AbortController();
        // Validate before rendering so malformed steps never enter UI state.
        const result = await request('/api/evaluate', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: evaluationBody(trace, state.policy, source), signal: state.importController.signal,
        });
        if (!$('import-dialog').open) return;
        state.controller?.abort();
        ++state.requestId;
        state.rawTrace = source;
        state.trace = clone(trace);
        state.result = null;
        state.imported = true;
        state.selectedId = trace.steps[0]?.id || null;
        state.filter = 'all';
        updateFilterButtons();
        $('example-select').querySelector('option[data-imported]')?.remove();
        const option = node('option', '', trace.name || trace.id || 'Импортированная трасса');
        option.value = '__imported_trace__';
        option.dataset.imported = 'true';
        $('example-select').append(option);
        $('example-select').value = option.value;
        state.result = result;
        closeDialog('import-dialog');
        hideError();
        renderSource();
        renderMetrics();
        renderSteps();
        renderDetail();
        renderChecks();
        renderBanner(result.status);
        setText('result-time', `ПРОВЕРЕНО В ${new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`);
        setBusy(false);
        toast('Трасса импортирована и проверена.');
      } catch (error) {
        if (error.name !== 'AbortError') {
          setText('import-error', [error.message, error.details].filter(Boolean).join('\n'));
          $('import-error').hidden = false;
        }
      } finally {
        submit.disabled = false;
        submit.removeAttribute('aria-busy');
      }
    });
    $('export-json').addEventListener('click', () => exportReport('json'));
    $('export-junit').addEventListener('click', () => exportReport('junit'));
    document.addEventListener('keydown', (event) => {
      if ((event.metaKey || event.ctrlKey) && event.key === 'Enter' && !document.querySelector('dialog[open]') && !state.busy) {
        event.preventDefault();
        evaluate();
      }
    });
  }

  async function initialize() {
    hideError();
    setBusy(true);
    try {
      const [examplesData, policyData] = await Promise.all([request('/api/examples'), request('/api/policy')]);
      if (!Array.isArray(examplesData.examples) || !policyData.policy) throw new Error('Не удалось загрузить сценарии или политику проверки.');
      const policy = policyData.policy;
      if (!Array.isArray(policy.allowed_tools) || !Array.isArray(policy.allowed_domains) || !Array.isArray(policy.approval_required_tools)) throw new Error('Сервис вернул некорректную политику.');
      state.examples = examplesData.examples;
      state.defaultPolicy = clone(policy);
      state.policy = clone(policy);
      $('example-select').replaceChildren();
      state.examples.forEach((example) => {
        const option = node('option', '', example.name || example.id);
        option.value = example.id;
        $('example-select').append(option);
      });
      updatePolicyPreview();
      if (state.examples.length) {
        selectExample(state.examples[0].id);
      } else {
        $('example-select').append(node('option', '', 'Учебных сценариев пока нет'));
        setText('scenario-description', 'Импортируйте свою трассу в формате JSON.');
        renderBanner('pending');
        renderSteps();
        setBusy(false);
      }
    } catch (error) {
      showError(error, initialize);
      renderBanner('error', error.message);
      $('trace-list').replaceChildren(emptyState('Сервис пока недоступен', 'Нажмите «Повторить», когда локальный сервер будет готов.', 'alert'));
      setText('scenario-description', 'Не удалось загрузить учебные сценарии.');
      $('example-select').replaceChildren(node('option', '', 'Ошибка загрузки'));
      setBusy(false);
    }
  }

  let initialTheme = 'dark';
  try { if (localStorage.getItem('agentgate-theme') === 'light') initialTheme = 'light'; } catch { /* Storage is optional. */ }
  setTheme(initialTheme);
  bindEvents();
  initialize();
})();
