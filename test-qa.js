const { _electron: electron } = require('playwright');
const path = require('path');
const fs = require('fs');

const RESULTS_DIR = path.join(__dirname, 'qa-results');
const QA_USER = 'qa_test';
const QA_PASS = 'qa1234';
const TIMEOUT = 10000;

const results = [];

function log(msg) { console.log(`[QA] ${msg}`); }

function record(group, name, status, detail = '') {
  const entry = { group, name, status, detail, time: new Date().toISOString() };
  results.push(entry);
  const icon = status === 'PASS' ? '\u2705' : status === 'FAIL' ? '\u274C' : '\u26A0\uFE0F';
  log(`${icon} [${group}] ${name}: ${status}${detail ? ' - ' + detail : ''}`);
}

async function screenshot(page, name) {
  try {
    const file = path.join(RESULTS_DIR, `${name}.png`);
    await page.screenshot({ path: file });
    return file;
  } catch { return null; }
}

async function closeAllModals(window) {
  await window.evaluate(() => {
    document.querySelectorAll('.modal:not(.hidden)').forEach(m => m.classList.add('hidden'));
    const overlay = document.querySelector('.modal-overlay');
    if (overlay) overlay.classList.add('hidden');
  });
  await window.waitForTimeout(300);
}

async function safeAction(group, name, fn) {
  try {
    await fn();
    record(group, name, 'PASS');
    return true;
  } catch (err) {
    record(group, name, 'FAIL', err.message.substring(0, 150));
    return false;
  }
}

(async () => {
  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  log('LinkFlow Electron QA 시작...');

  const electronPath = require('electron');
  const app = await electron.launch({
    args: ['.'],
    executablePath: electronPath,
    cwd: __dirname,
  });

  log('Electron 앱 실행됨, 첫 번째 윈도우 대기...');
  const window = await app.firstWindow();
  await window.waitForLoadState('domcontentloaded');
  await window.waitForTimeout(4000);

  // ═══════ QA-1: 앱 기본 상태 ═══════
  log('\n── QA-1: 앱 기본 상태 ──');

  await safeAction('QA-1', '윈도우 열림', async () => {
    const title = await window.title();
    if (!title) throw new Error('윈도우 타이틀 없음');
  });

  await screenshot(window, '01-initial-state');

  await safeAction('QA-1', '앱 타이틀 LinkFlow', async () => {
    const title = await window.title();
    if (!title.includes('LinkFlow')) throw new Error(`타이틀: "${title}"`);
  });

  await safeAction('QA-1', '페이지 로드 완료', async () => {
    await window.waitForSelector('body', { timeout: TIMEOUT });
  });

  const hasLoginScreen = await window.evaluate(() => {
    const el = document.getElementById('login-screen');
    return el && !el.classList.contains('hidden');
  });

  log(`로그인 화면 표시: ${hasLoginScreen}`);
  await screenshot(window, '01-after-load');

  // ═══════ QA-2: 로그인 ═══════
  log('\n── QA-2: 로그인 ──');

  if (hasLoginScreen) {
    await safeAction('QA-2', '로그인 폼 존재', async () => {
      await window.waitForSelector('#login-id', { timeout: TIMEOUT });
      await window.waitForSelector('#login-pw', { timeout: TIMEOUT });
    });

    await safeAction('QA-2', '로그인 실행', async () => {
      await window.fill('#login-id', QA_USER);
      await window.fill('#login-pw', QA_PASS);
      await window.click('#login-btn');
      await window.waitForTimeout(3000);
    });

    await screenshot(window, '02-after-login');

    await safeAction('QA-2', '로그인 성공', async () => {
      const loggedIn = await window.evaluate(() => {
        const el = document.getElementById('login-screen');
        return !el || el.classList.contains('hidden');
      });
      if (!loggedIn) throw new Error('로그인 화면 여전히 표시됨');
    });
  } else {
    const userName = await window.evaluate(() => {
      const badge = document.getElementById('user-badge');
      return badge ? badge.textContent.trim() : '';
    });
    record('QA-2', '자동 로그인', userName ? 'PASS' : 'WARN',
      userName ? `사용자: ${userName}` : '로그인 상태 불확실');
  }

  await screenshot(window, '02-logged-in');

  // ═══════ QA-3: 북마크/캘린더/메모 CRUD ═══════
  log('\n── QA-3: 북마크 CRUD ──');

  await safeAction('QA-3', '북마크 탭', async () => {
    await window.click('[data-tab="bookmarks"]');
    await window.waitForTimeout(1000);
  });

  await screenshot(window, '03-bookmarks');

  await safeAction('QA-3', '북마크 추가 모달 열기', async () => {
    await window.click('#btn-add-bookmark');
    await window.waitForSelector('#bm-title', { timeout: TIMEOUT });
  });

  await safeAction('QA-3', '북마크 생성', async () => {
    await window.fill('#bm-title', 'QA Electron 테스트');
    await window.fill('#bm-url', 'https://example.com');
    await window.click('#bm-submit-btn');
    await window.waitForTimeout(2000);
  });

  await screenshot(window, '03-bookmark-added');

  await safeAction('QA-3', '북마크 표시 확인', async () => {
    const hasQA = await window.evaluate(() => {
      return Array.from(document.querySelectorAll('.bookmark-title'))
        .some(el => el.textContent.includes('QA Electron'));
    });
    if (!hasQA) throw new Error('추가된 북마크가 표시되지 않음');
  });

  await safeAction('QA-3', '북마크 삭제', async () => {
    const delBtn = await window.$('.bookmark-card [title="삭제"]');
    if (!delBtn) throw new Error('삭제 버튼 없음');
    await delBtn.click();
    await window.waitForTimeout(500);
    await window.click('#confirm-ok');
    await window.waitForTimeout(2000);
  });

  await screenshot(window, '03-bookmark-deleted');

  // 캘린더
  log('\n── QA-3: 캘린더 ──');
  await closeAllModals(window);

  await safeAction('QA-3', '캘린더 탭', async () => {
    await window.click('[data-tab="calendar"]');
    await window.waitForTimeout(2000);
  });

  await screenshot(window, '03-calendar');

  await safeAction('QA-3', '캘린더 렌더링', async () => {
    const grid = await window.$('.calendar-grid');
    if (!grid) throw new Error('캘린더 그리드 없음');
  });

  await safeAction('QA-3', '공휴일 표시', async () => {
    const names = await window.evaluate(() => {
      return Array.from(document.querySelectorAll('.cal-holiday-name')).map(e => e.textContent);
    });
    if (names.length === 0) throw new Error('공휴일 없음');
    record('QA-3', '공휴일 목록', 'PASS', names.join(', '));
  });

  await safeAction('QA-3', '일정 추가', async () => {
    const cell = await window.$('.cal-cell:not(.empty):nth-child(15)');
    if (!cell) throw new Error('날짜 셀 없음');
    await cell.click();
    await window.waitForTimeout(1000);
    await window.fill('#evt-title', 'QA Electron 일정');
    await window.click('#evt-submit-btn');
    await window.waitForTimeout(2000);
  });

  await screenshot(window, '03-event-added');

  await safeAction('QA-3', '일정 삭제', async () => {
    const evt = await window.$('.cal-event');
    if (evt) {
      await evt.click();
      await window.waitForTimeout(1000);
      const delBtn = await window.$('#evt-delete-btn');
      if (delBtn) {
        await window.evaluate(() => document.getElementById('evt-delete-btn').classList.remove('hidden'));
        await window.click('#evt-delete-btn');
        await window.waitForTimeout(500);
        await window.click('#confirm-ok');
        await window.waitForTimeout(1500);
      }
    }
  });

  await closeAllModals(window);

  // 메모
  log('\n── QA-3: 메모 ──');

  await safeAction('QA-3', '메모 탭', async () => {
    await window.click('[data-tab="memos"]');
    await window.waitForTimeout(1000);
  });

  await screenshot(window, '03-memos');

  await safeAction('QA-3', '메모 생성', async () => {
    await window.click('#btn-add-memo');
    await window.waitForTimeout(500);
    await window.fill('#memo-title', 'QA Electron 메모');
    await window.fill('#memo-content', 'Electron QA 테스트 내용');
    await window.click('#memo-form button[type="submit"]');
    await window.waitForTimeout(2000);
  });

  await screenshot(window, '03-memo-created');

  await safeAction('QA-3', '메모 삭제', async () => {
    const card = await window.$('.memo-card');
    if (!card) throw new Error('메모 카드 없음');
    await card.click();
    await window.waitForTimeout(500);
    await window.evaluate(() => {
      const btn = document.getElementById('memo-delete-btn');
      if (btn) btn.classList.remove('hidden');
    });
    await window.click('#memo-delete-btn');
    await window.waitForTimeout(500);
    await window.click('#confirm-ok');
    await window.waitForTimeout(1500);
  });

  await screenshot(window, '03-memo-deleted');
  await closeAllModals(window);

  // ═══════ QA-4: 키보드 단축키 ═══════
  log('\n── QA-4: 키보드 단축키 ──');

  await window.click('[data-tab="bookmarks"]');
  await window.waitForTimeout(1000);

  // Playwright keyboard.press doesn't trigger Electron's before-input-event
  // Use executeJavaScript to call the functions directly

  await safeAction('QA-4', 'Ctrl+T 새 탭 (JS)', async () => {
    const before = await window.$$('.dyn-tab');
    await window.evaluate(() => window.__newTab && window.__newTab());
    await window.waitForTimeout(2000);
    const after = await window.$$('.dyn-tab');
    if (after.length <= before.length) throw new Error(`탭 수: ${before.length} -> ${after.length}`);
  });

  await screenshot(window, '04-ctrl-t');

  await safeAction('QA-4', 'Ctrl+W 탭 닫기 (JS)', async () => {
    const before = await window.$$('.dyn-tab');
    if (before.length === 0) throw new Error('닫을 탭 없음');
    await window.evaluate(() => window.__closeActiveTab && window.__closeActiveTab());
    await window.waitForTimeout(1500);
    const after = await window.$$('.dyn-tab');
    if (after.length >= before.length) throw new Error(`탭: ${before.length} -> ${after.length}`);
  });

  await screenshot(window, '04-ctrl-w');

  await safeAction('QA-4', 'Ctrl+Shift+T 탭 복원 (JS)', async () => {
    const before = await window.$$('.dyn-tab');
    await window.evaluate(() => window.__reopenClosedTab && window.__reopenClosedTab());
    await window.waitForTimeout(2000);
    const after = await window.$$('.dyn-tab');
    if (after.length <= before.length) throw new Error(`복원 실패: ${before.length} -> ${after.length}`);
  });

  await screenshot(window, '04-ctrl-shift-t');

  await safeAction('QA-4', 'F11 전체화면', async () => {
    const bw = await app.browserWindow(window);
    const before = await bw.evaluate(w => w.isFullScreen());
    await bw.evaluate(w => w.setFullScreen(!w.isFullScreen()));
    await window.waitForTimeout(1000);
    const after = await bw.evaluate(w => w.isFullScreen());
    if (before === after) throw new Error('전체화면 토글 안됨');
    await bw.evaluate(w => w.setFullScreen(false));
    await window.waitForTimeout(500);
  });

  await safeAction('QA-4', 'Alt+L 잠금 (JS)', async () => {
    const hasPIN = await window.evaluate(() => {
      const user = JSON.parse(sessionStorage.getItem('user') || '{}');
      return !!user.pin_code;
    });
    await window.evaluate(() => Auth.showLockScreen());
    await window.waitForTimeout(1000);
    const lockVisible = await window.evaluate(() => {
      const el = document.getElementById('lock-screen');
      return el && !el.classList.contains('hidden');
    });
    if (hasPIN && !lockVisible) throw new Error('PIN 설정인데 잠금 안됨');
    if (!hasPIN && !lockVisible) record('QA-4', 'PIN 미설정 -> 잠기지 않음', 'PASS', '정상');
    if (lockVisible) {
      await window.evaluate(() => {
        document.getElementById('lock-screen').classList.add('hidden');
      });
      await window.waitForTimeout(300);
    }
  });

  await screenshot(window, '04-shortcuts');

  // 열린 탭 정리
  let tabs = await window.$$('.dyn-tab');
  for (let i = 0; i < tabs.length; i++) {
    await window.keyboard.press('Control+w');
    await window.waitForTimeout(300);
  }

  // ═══════ QA-5: 탭 관리 ═══════
  log('\n── QA-5: 탭 관리 ──');

  await safeAction('QA-5', '새 탭 버튼', async () => {
    await window.click('#btn-add-tab');
    await window.waitForTimeout(2000);
    const t = await window.$$('.dyn-tab');
    if (t.length === 0) throw new Error('탭 생성 안됨');
  });

  await screenshot(window, '05-new-tab');

  await safeAction('QA-5', 'URL 바 존재', async () => {
    const bar = await window.$('.dtf-url-bar');
    if (!bar) throw new Error('URL 바 없음');
  });

  await safeAction('QA-5', 'URL 바 입력+이동', async () => {
    await window.click('.dtf-url-bar');
    await window.fill('.dtf-url-bar', 'https://example.com');
    await window.keyboard.press('Enter');
    await window.waitForTimeout(3000);
  });

  await screenshot(window, '05-url-nav');

  await safeAction('QA-5', '줌 컨트롤', async () => {
    const ctrl = await window.$('.dtf-zoom-ctrl');
    if (!ctrl) throw new Error('줌 컨트롤 없음');
    const label = await window.$('.dtf-zoom-label');
    if (label) {
      const t = await label.textContent();
      record('QA-5', '줌 레벨', 'PASS', t);
    }
  });

  await safeAction('QA-5', '탭 닫기 버튼', async () => {
    const close = await window.$('.dyn-tab .tab-close');
    if (!close) throw new Error('닫기 버튼 없음');
    await close.click();
    await window.waitForTimeout(1000);
  });

  await screenshot(window, '05-tab-closed');

  // ═══════ QA-6: 새 창 분리 ═══════
  log('\n── QA-6: 새 창 분리 ──');

  await safeAction('QA-6', '새 창 분리', async () => {
    await window.click('#btn-add-tab');
    await window.waitForTimeout(2000);

    const detach = await window.$('.dyn-tab .tab-detach');
    if (!detach) {
      record('QA-6', '분리 버튼 없음', 'WARN', '탭에 분리 버튼 미발견');
      return;
    }

    let newWin = null;
    const handler = (page) => { newWin = page; };
    app.on('window', handler);

    await detach.click();
    await window.waitForTimeout(5000);

    app.off('window', handler);

    if (newWin) {
      record('QA-6', '새 창 생성됨', 'PASS');
      await screenshot(newWin, '06-detached');
      try {
        const bw = await app.browserWindow(newWin);
        await bw.evaluate(w => w.close());
      } catch {}
    } else {
      record('QA-6', '새 창 미감지', 'WARN', '5초 타임아웃');
    }
  });

  await screenshot(window, '06-after-detach');

  tabs = await window.$$('.dyn-tab');
  for (let i = 0; i < tabs.length; i++) {
    await window.keyboard.press('Control+w');
    await window.waitForTimeout(300);
  }

  // ═══════ QA-7: 설정/업데이트 ═══════
  log('\n── QA-7: 설정/업데이트 ──');

  await safeAction('QA-7', '설정 열기', async () => {
    await window.click('#btn-settings');
    await window.waitForTimeout(1000);
  });

  await screenshot(window, '07-settings');

  await safeAction('QA-7', '프로필', async () => {
    const input = await window.$('#setting-display-name');
    if (!input) throw new Error('표시 이름 입력 없음');
    const v = await input.inputValue();
    record('QA-7', '표시 이름', 'PASS', `"${v}"`);
  });

  await safeAction('QA-7', '잠금 설정', async () => {
    const section = await window.$('#lock-form');
    if (!section) throw new Error('잠금 설정 없음');
  });

  await safeAction('QA-7', '업데이트 이력', async () => {
    await window.click('#btn-update-history');
    await window.waitForTimeout(1500);
  });

  await screenshot(window, '07-update-history');

  await safeAction('QA-7', '버전 목록', async () => {
    const versions = await window.evaluate(() => {
      return Array.from(document.querySelectorAll('.update-release-version')).map(e => e.textContent.trim());
    });
    if (versions.length === 0) throw new Error('버전 없음');
    record('QA-7', '버전 수', 'PASS', `${versions.length}개, 최신: ${versions[0]}`);
  });

  await closeAllModals(window);

  await safeAction('QA-7', '앱 버전', async () => {
    const v = await app.evaluate(({ app }) => app.getVersion());
    record('QA-7', '버전값', 'PASS', `v${v}`);
  });

  await safeAction('QA-7', 'userData 경로', async () => {
    const p = await app.evaluate(({ app }) => app.getPath('userData'));
    record('QA-7', '경로값', 'PASS', p);
  });

  await screenshot(window, '99-final');

  // ═══════ 결과 ═══════
  log('\n══════════════════════════════════════');
  log('           QA 결과 요약');
  log('══════════════════════════════════════');

  const pass = results.filter(r => r.status === 'PASS').length;
  const fail = results.filter(r => r.status === 'FAIL').length;
  const warn = results.filter(r => r.status === 'WARN').length;

  log(`PASS: ${pass} | FAIL: ${fail} | WARN: ${warn} | 총: ${results.length}`);

  if (fail > 0) {
    log('\n실패:');
    results.filter(r => r.status === 'FAIL').forEach(r => {
      log(`  \u274C [${r.group}] ${r.name}: ${r.detail}`);
    });
  }
  if (warn > 0) {
    log('\n경고:');
    results.filter(r => r.status === 'WARN').forEach(r => {
      log(`  \u26A0\uFE0F [${r.group}] ${r.name}: ${r.detail}`);
    });
  }

  const report = {
    timestamp: new Date().toISOString(),
    summary: { total: results.length, pass, fail, warn },
    results,
  };

  fs.writeFileSync(path.join(RESULTS_DIR, 'qa-report.json'), JSON.stringify(report, null, 2), 'utf-8');
  log(`\n결과: ${path.join(RESULTS_DIR, 'qa-report.json')}`);

  await app.close();
  log('QA 완료.');
  process.exit(fail > 0 ? 1 : 0);
})();
