const { _electron: electron } = require('playwright');
const path = require('path');
const fs = require('fs');

const RESULTS_DIR = path.join(__dirname, 'qa-results');
const TIMEOUT = 10000;
const results = [];

function log(msg) { console.log(`[QA] ${msg}`); }

function record(group, name, status, detail = '') {
  results.push({ group, name, status, detail, time: new Date().toISOString() });
  const icon = status === 'PASS' ? '\u2705' : status === 'FAIL' ? '\u274C' : '\u26A0\uFE0F';
  log(`${icon} [${group}] ${name}: ${status}${detail ? ' - ' + detail : ''}`);
}

async function ss(page, name) {
  try { await page.screenshot({ path: path.join(RESULTS_DIR, `v2-${name}.png`) }); } catch {}
}

async function closeModals(w) {
  await w.evaluate(() => {
    document.querySelectorAll('.modal:not(.hidden)').forEach(m => m.classList.add('hidden'));
    const o = document.querySelector('.modal-overlay'); if (o) o.classList.add('hidden');
    const s = document.getElementById('settings-panel'); if (s) s.classList.add('hidden');
    const po = document.getElementById('panel-overlay'); if (po) po.classList.add('hidden');
  });
  await w.waitForTimeout(300);
}

async function cleanTabs(w) {
  const tabs = await w.$$('.dyn-tab');
  for (let i = 0; i < tabs.length; i++) {
    await w.evaluate(() => window.__closeActiveTab && window.__closeActiveTab());
    await w.waitForTimeout(400);
  }
}

async function T(group, name, fn) {
  try { await fn(); record(group, name, 'PASS'); return true; }
  catch (e) { record(group, name, 'FAIL', e.message.substring(0, 150)); return false; }
}

async function cleanupTestData(w) {
  log('이전 QA 잔여 데이터 정리 중...');

  await w.click('[data-tab="bookmarks"]');
  await w.waitForTimeout(1000);
  let cleaned = 0;
  for (let i = 0; i < 10; i++) {
    const found = await w.evaluate(() => {
      const cards = document.querySelectorAll('.bookmark-card');
      for (const c of cards) {
        const title = c.querySelector('.bookmark-title')?.textContent || '';
        if (title.includes('QA Electron') || title.includes('QA-V2')) {
          const btn = c.querySelector('[title="삭제"]');
          if (btn) { btn.click(); return true; }
        }
      }
      return false;
    });
    if (!found) break;
    await w.waitForTimeout(500);
    const ok = await w.$('#confirm-ok');
    if (ok) await ok.click();
    await w.waitForTimeout(1500);
    cleaned++;
  }
  if (cleaned > 0) log(`  북마크 ${cleaned}개 삭제`);

  await closeModals(w);
  await w.click('[data-tab="calendar"]');
  await w.waitForTimeout(2000);
  let evtCleaned = 0;
  for (let i = 0; i < 10; i++) {
    const found = await w.evaluate(() => {
      const bars = document.querySelectorAll('.cal-event-bar');
      for (const b of bars) {
        if (b.textContent.includes('QA Electron') || b.textContent.includes('QA-V2')) {
          b.click(); return true;
        }
      }
      return false;
    });
    if (!found) break;
    await w.waitForTimeout(1000);
    const hasModal = await w.evaluate(() => {
      const btn = document.getElementById('evt-delete-btn');
      if (!btn) return false;
      btn.classList.remove('hidden');
      return true;
    });
    if (!hasModal) { await closeModals(w); break; }
    await w.click('#evt-delete-btn');
    await w.waitForTimeout(500);
    const ok = await w.$('#confirm-ok');
    if (ok) await ok.click();
    await w.waitForTimeout(1500);
    evtCleaned++;
  }
  if (evtCleaned > 0) log(`  일정 ${evtCleaned}개 삭제`);

  await closeModals(w);
  log('정리 완료.\n');
}

(async () => {
  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  log('LinkFlow Electron 상세 QA v2 시작...\n');

  const app = await electron.launch({
    args: ['.'], executablePath: require('electron'), cwd: __dirname,
  });

  const w = await app.firstWindow();
  await w.waitForLoadState('domcontentloaded');
  await w.waitForTimeout(4000);

  await cleanupTestData(w);

  // ═══════════════════════════════════════════════════════
  // QA-1: 앱 기본 상태
  // ═══════════════════════════════════════════════════════
  log('── QA-1: 앱 기본 상태 ──');

  await T('QA-1', '윈도우 열림', async () => {
    if (!(await w.title())) throw new Error('타이틀 없음');
  });
  await T('QA-1', '타이틀 LinkFlow', async () => {
    if (!(await w.title()).includes('LinkFlow')) throw new Error(await w.title());
  });
  await T('QA-1', 'body 로드', async () => {
    await w.waitForSelector('body', { timeout: TIMEOUT });
  });
  await T('QA-1', '#toast-container 존재', async () => {
    const el = await w.$('#toast-container');
    if (!el) throw new Error('없음');
  });
  await ss(w, '01-init');

  // ═══════════════════════════════════════════════════════
  // QA-2: 로그인/인증
  // ═══════════════════════════════════════════════════════
  log('\n── QA-2: 로그인/인증 ──');

  const hasLogin = await w.evaluate(() => {
    const el = document.getElementById('login-screen');
    return el && !el.classList.contains('hidden');
  });

  if (hasLogin) {
    await T('QA-2', '로그인 폼', async () => {
      await w.waitForSelector('#login-username', { timeout: TIMEOUT });
    });
    await T('QA-2', '로그인 실행', async () => {
      await w.fill('#login-username', 'qa_test');
      await w.fill('#login-password', 'qa1234');
      await w.click('#login-btn');
      await w.waitForTimeout(3000);
    });
    await T('QA-2', '로그인 성공', async () => {
      const ok = await w.evaluate(() => {
        const el = document.getElementById('login-screen');
        return !el || el.classList.contains('hidden');
      });
      if (!ok) throw new Error('로그인 화면 여전히 표시');
    });
  } else {
    const name = await w.evaluate(() => document.getElementById('user-badge')?.textContent?.trim() || '');
    record('QA-2', '자동 로그인', name ? 'PASS' : 'WARN', name ? `사용자: ${name}` : '불확실');
  }

  await T('QA-2', '사용자 배지', async () => {
    const el = await w.$('#user-badge');
    if (!el) throw new Error('#user-badge 없음');
    const txt = await el.textContent();
    if (!txt.trim()) throw new Error('배지 텍스트 없음');
  });

  await ss(w, '02-loggedin');

  // ═══════════════════════════════════════════════════════
  // QA-3: 북마크 전체
  // ═══════════════════════════════════════════════════════
  log('\n── QA-3: 북마크 전체 ──');

  await w.click('[data-tab="bookmarks"]');
  await w.waitForTimeout(1000);

  await T('QA-3', '북마크 탭 활성', async () => {
    const active = await w.evaluate(() => document.querySelector('[data-tab="bookmarks"]').classList.contains('active'));
    if (!active) throw new Error('비활성');
  });

  await T('QA-3', '검색 입력 존재', async () => {
    const el = await w.$('#search-input');
    if (!el) throw new Error('#search-input 없음');
  });

  await T('QA-3', '카테고리 탭 존재', async () => {
    const tabs = await w.$$('.cat-tab');
    if (tabs.length === 0) throw new Error('카테고리 탭 없음');
    record('QA-3', '카테고리 탭 수', 'PASS', `${tabs.length}개`);
  });

  // 북마크 생성
  await T('QA-3', '추가 모달 열기', async () => {
    await w.click('#btn-add-bookmark');
    await w.waitForSelector('#bm-title', { timeout: TIMEOUT });
  });

  await T('QA-3', '모달 필드 확인', async () => {
    for (const sel of ['#bm-title', '#bm-url', '#bm-desc', '#bm-category', '#bm-type', '#bm-open-mode']) {
      const el = await w.$(sel);
      if (!el) throw new Error(`${sel} 없음`);
    }
  });

  await T('QA-3', '#bm-type 옵션', async () => {
    const opts = await w.evaluate(() =>
      Array.from(document.querySelectorAll('#bm-type option')).map(o => o.value)
    );
    if (opts.length < 3) throw new Error(`옵션 ${opts.length}개`);
    record('QA-3', 'bm-type 옵션 목록', 'PASS', opts.join(','));
  });

  await T('QA-3', '#bm-open-mode 옵션', async () => {
    const opts = await w.evaluate(() =>
      Array.from(document.querySelectorAll('#bm-open-mode option')).map(o => o.value)
    );
    if (!opts.includes('auto') && !opts.includes('internal')) throw new Error(opts.join(','));
  });

  await T('QA-3', '북마크 생성', async () => {
    await w.fill('#bm-title', 'QA-V2 테스트 북마크');
    await w.fill('#bm-url', 'https://qa-v2-test.example.com');
    await w.fill('#bm-desc', 'V2 QA 자동 생성');
    await w.click('#bm-submit-btn');
    await w.waitForTimeout(3000);
    await w.click('[data-tab="bookmarks"]');
    await w.waitForTimeout(2000);
  });

  await ss(w, '03-bm-created');

  await T('QA-3', '북마크 DOM 확인', async () => {
    const found = await w.evaluate(() =>
      Array.from(document.querySelectorAll('.bookmark-title')).some(e => e.textContent.includes('QA-V2'))
    );
    if (!found) throw new Error('DOM에 표시 안됨');
  });

  // 북마크 검색
  await T('QA-3', '북마크 검색', async () => {
    await w.fill('#search-input', 'QA-V2');
    await w.waitForTimeout(500);
    const visible = await w.evaluate(() =>
      Array.from(document.querySelectorAll('.bookmark-card')).filter(c => c.style.display !== 'none').length
    );
    if (visible === 0) throw new Error('검색 결과 없음');
    await w.fill('#search-input', '');
    await w.waitForTimeout(300);
  });

  // 북마크 고정
  await T('QA-3', '북마크 고정(Pin)', async () => {
    const pinBtn = await w.evaluate(() => {
      const cards = document.querySelectorAll('.bookmark-card');
      for (const c of cards) {
        if (c.querySelector('.bookmark-title')?.textContent?.includes('QA-V2')) {
          const btn = c.querySelector('.btn-pin-bm');
          if (btn) { btn.click(); return true; }
        }
      }
      return false;
    });
    if (!pinBtn) throw new Error('QA-V2 카드의 .btn-pin-bm 없음');
    await w.waitForTimeout(1000);
  });

  // 북마크 수정
  await T('QA-3', '북마크 수정 모달', async () => {
    const clicked = await w.evaluate(() => {
      const cards = document.querySelectorAll('.bookmark-card');
      for (const c of cards) {
        if (c.querySelector('.bookmark-title')?.textContent?.includes('QA-V2')) {
          const btn = c.querySelector('.btn-edit-bm');
          if (btn) { btn.click(); return true; }
        }
      }
      return false;
    });
    if (!clicked) throw new Error('QA-V2 카드의 .btn-edit-bm 없음');
    await w.waitForTimeout(500);
    await w.waitForSelector('#bm-title', { timeout: TIMEOUT });
    const val = await w.evaluate(() => document.getElementById('bm-title').value);
    if (!val.includes('QA-V2')) throw new Error(`수정 모달 제목: ${val}`);
  });

  await T('QA-3', '북마크 수정 저장', async () => {
    await w.fill('#bm-title', 'QA-V2 수정됨');
    await w.click('#bm-submit-btn');
    await w.waitForTimeout(3000);
    await w.click('[data-tab="bookmarks"]');
    await w.waitForTimeout(2000);
    const found = await w.evaluate(() =>
      Array.from(document.querySelectorAll('.bookmark-title')).some(e => e.textContent.includes('수정됨'))
    );
    if (!found) throw new Error('수정 반영 안됨');
  });

  await ss(w, '03-bm-edited');

  // 카테고리 필터
  await T('QA-3', '카테고리 탭 클릭', async () => {
    const allTab = await w.$('.cat-tab[data-cat="all"]');
    if (!allTab) throw new Error('전체 탭 없음');
    await allTab.click();
    await w.waitForTimeout(500);
  });

  // 북마크 삭제
  await T('QA-3', '북마크 삭제', async () => {
    const delBtn = await w.evaluate(() => {
      const cards = document.querySelectorAll('.bookmark-card');
      for (const c of cards) {
        if (c.querySelector('.bookmark-title')?.textContent?.includes('QA-V2')) {
          const btn = c.querySelector('[title="삭제"]');
          if (btn) { btn.click(); return true; }
        }
      }
      return false;
    });
    if (!delBtn) throw new Error('삭제 버튼 없음');
    await w.waitForTimeout(500);
    await w.click('#confirm-ok');
    await w.waitForTimeout(2000);
  });

  await ss(w, '03-bm-deleted');
  await closeModals(w);

  // ═══════════════════════════════════════════════════════
  // QA-4: 캘린더 전체
  // ═══════════════════════════════════════════════════════
  log('\n── QA-4: 캘린더 전체 ──');

  await w.click('[data-tab="calendar"]');
  await w.waitForTimeout(2000);

  await T('QA-4', '캘린더 그리드', async () => {
    const g = await w.$('.calendar-grid');
    if (!g) throw new Error('그리드 없음');
  });

  await T('QA-4', '월 제목 표시', async () => {
    const title = await w.evaluate(() => document.getElementById('cal-month-title')?.textContent || '');
    if (!title) throw new Error('월 제목 없음');
    record('QA-4', '현재 월', 'PASS', title);
  });

  await T('QA-4', '이전 달 이동', async () => {
    const before = await w.evaluate(() => document.getElementById('cal-month-title')?.textContent || '');
    await w.click('#cal-prev');
    await w.waitForTimeout(1500);
    const after = await w.evaluate(() => document.getElementById('cal-month-title')?.textContent || '');
    if (before === after) throw new Error('월 변경 안됨');
    record('QA-4', '이전 달', 'PASS', `${before} -> ${after}`);
  });

  await T('QA-4', '다음 달 이동', async () => {
    await w.click('#cal-next');
    await w.waitForTimeout(1500);
  });

  await T('QA-4', '오늘 버튼', async () => {
    await w.click('#cal-today');
    await w.waitForTimeout(1500);
    const hasToday = await w.evaluate(() => !!document.querySelector('.cal-cell.today'));
    if (!hasToday) throw new Error('.today 셀 없음');
  });

  await T('QA-4', '공휴일 표시', async () => {
    const names = await w.evaluate(() =>
      Array.from(document.querySelectorAll('.cal-holiday-name')).map(e => e.textContent)
    );
    if (names.length === 0) throw new Error('공휴일 없음');
    record('QA-4', '공휴일', 'PASS', names.join(', '));
  });

  await T('QA-4', '이번 주 업무 사이드바', async () => {
    const sidebar = await w.$('#task-sidebar');
    if (!sidebar) throw new Error('#task-sidebar 없음');
    const items = await w.$$('.task-item');
    record('QA-4', '업무 항목', 'PASS', `${items.length}개`);
  });

  await ss(w, '04-cal-overview');

  // 일정 추가
  await T('QA-4', '일정 추가 (날짜 클릭)', async () => {
    const cell = await w.$('.cal-cell.today');
    if (!cell) throw new Error('오늘 셀 없음');
    await cell.click();
    await w.waitForTimeout(1000);
    await w.waitForSelector('#evt-title', { timeout: TIMEOUT });
  });

  await T('QA-4', '일정 모달 필드', async () => {
    for (const sel of ['#evt-title', '#evt-date', '#evt-time', '#evt-recurrence', '#evt-desc', '#evt-color-picker']) {
      if (!(await w.$(sel))) throw new Error(`${sel} 없음`);
    }
  });

  await T('QA-4', '색상 선택', async () => {
    const dots = await w.$$('#evt-color-picker .color-dot');
    if (dots.length < 2) throw new Error('색상 점 부족');
    await dots[1].click();
    await w.waitForTimeout(200);
    const color = await w.evaluate(() => document.getElementById('evt-color')?.value);
    record('QA-4', '선택된 색상', 'PASS', color);
  });

  await T('QA-4', '일정 생성', async () => {
    await w.fill('#evt-title', 'QA-V2 캘린더 일정');
    await w.click('#evt-submit-btn');
    await w.waitForTimeout(2000);
  });

  await ss(w, '04-cal-event-added');

  // 반복 일정
  await T('QA-4', '반복 일정 모달', async () => {
    const cell = await w.$('.cal-cell.today');
    if (cell) await cell.click();
    await w.waitForTimeout(1000);
    await w.waitForSelector('#evt-recurrence', { timeout: TIMEOUT });
  });

  await T('QA-4', '반복 유형 monthly', async () => {
    await w.selectOption('#evt-recurrence', 'monthly');
    await w.waitForTimeout(500);
    const dayWrap = await w.$('#evt-recurrence-day-wrap');
    const visible = dayWrap ? await dayWrap.evaluate(el => el.style.display !== 'none') : false;
    record('QA-4', '반복일 입력 표시', visible ? 'PASS' : 'WARN', visible ? '표시됨' : '숨겨짐');
  });

  await T('QA-4', '주말 건너뛰기 체크박스', async () => {
    const el = await w.$('#evt-skip-weekend');
    if (!el) throw new Error('#evt-skip-weekend 없음');
    const wrap = await w.$('#evt-skip-weekend-wrap');
    if (wrap) {
      const vis = await wrap.evaluate(el => el.style.display !== 'none');
      record('QA-4', '건너뛰기 표시', vis ? 'PASS' : 'WARN', vis ? '보임' : '숨김');
    }
  });

  await closeModals(w);

  // 일정 수정
  await T('QA-4', '일정 수정', async () => {
    const evtBar = await w.evaluate(() => {
      const bars = document.querySelectorAll('.cal-event-bar');
      for (const b of bars) {
        if (b.textContent.includes('QA-V2')) { b.click(); return true; }
      }
      return false;
    });
    if (!evtBar) { record('QA-4', '일정 수정', 'WARN', 'QA-V2 일정 바 미발견'); return; }
    await w.waitForTimeout(1000);
    const title = await w.evaluate(() => document.getElementById('evt-title')?.value || '');
    if (!title.includes('QA-V2')) throw new Error(`모달 제목: ${title}`);
    await w.fill('#evt-title', 'QA-V2 수정 일정');
    await w.click('#evt-submit-btn');
    await w.waitForTimeout(2000);
  });

  // 일정 삭제
  await T('QA-4', '일정 삭제', async () => {
    const clicked = await w.evaluate(() => {
      const bars = document.querySelectorAll('.cal-event-bar');
      for (const b of bars) {
        if (b.textContent.includes('QA-V2')) { b.click(); return true; }
      }
      return false;
    });
    if (!clicked) return;
    await w.waitForTimeout(1000);
    await w.evaluate(() => document.getElementById('evt-delete-btn')?.classList.remove('hidden'));
    await w.click('#evt-delete-btn');
    await w.waitForTimeout(500);
    await w.click('#confirm-ok');
    await w.waitForTimeout(1500);
  });

  await closeModals(w);
  await ss(w, '04-cal-done');

  // ═══════════════════════════════════════════════════════
  // QA-5: 메모 전체
  // ═══════════════════════════════════════════════════════
  log('\n── QA-5: 메모 전체 ──');

  await w.click('[data-tab="memos"]');
  await w.waitForTimeout(1000);

  await T('QA-5', '메모 탭 활성', async () => {
    const active = await w.evaluate(() => document.querySelector('[data-tab="memos"]').classList.contains('active'));
    if (!active) throw new Error('비활성');
  });

  // 메모 생성
  await T('QA-5', '메모 추가 모달', async () => {
    await w.click('#btn-add-memo');
    await w.waitForTimeout(500);
    await w.waitForSelector('#memo-title', { timeout: TIMEOUT });
  });

  await T('QA-5', '메모 모달 필드', async () => {
    for (const sel of ['#memo-title', '#memo-content', '#memo-color-picker']) {
      if (!(await w.$(sel))) throw new Error(`${sel} 없음`);
    }
  });

  await T('QA-5', '메모 색상 선택', async () => {
    const dots = await w.$$('#memo-color-picker .color-dot');
    if (dots.length < 2) throw new Error('색상 점 부족');
    await dots[1].click();
    await w.waitForTimeout(200);
    const color = await w.evaluate(() => document.getElementById('memo-color')?.value);
    record('QA-5', '메모 색상', 'PASS', color);
  });

  await T('QA-5', '메모 생성', async () => {
    await w.fill('#memo-title', 'QA-V2 메모');
    await w.fill('#memo-content', 'V2 자동화 QA 테스트 내용입니다.');
    await w.click('#memo-form button[type="submit"]');
    await w.waitForTimeout(2000);
  });

  await ss(w, '05-memo-created');

  await T('QA-5', '메모 카드 존재', async () => {
    const cards = await w.$$('.memo-card');
    if (cards.length === 0) throw new Error('메모 카드 없음');
    record('QA-5', '메모 수', 'PASS', `${cards.length}개`);
  });

  // 메모 수정
  await T('QA-5', '메모 수정 모달', async () => {
    const clicked = await w.evaluate(() => {
      const cards = document.querySelectorAll('.memo-card');
      for (const c of cards) {
        if (c.querySelector('.memo-card-title')?.textContent?.includes('QA-V2')) {
          c.click(); return true;
        }
      }
      return false;
    });
    if (!clicked) throw new Error('QA-V2 메모 카드 없음');
    await w.waitForTimeout(500);
    await w.waitForSelector('#memo-title', { timeout: TIMEOUT });
    const val = await w.evaluate(() => document.getElementById('memo-title')?.value || '');
    if (!val.includes('QA-V2')) throw new Error(`모달 제목: ${val}`);
  });

  await T('QA-5', '메모 수정 저장', async () => {
    await w.fill('#memo-title', 'QA-V2 메모 수정됨');
    await w.click('#memo-form button[type="submit"]');
    await w.waitForTimeout(2000);
    const found = await w.evaluate(() =>
      Array.from(document.querySelectorAll('.memo-card-title')).some(e => e.textContent.includes('수정됨'))
    );
    if (!found) throw new Error('수정 반영 안됨');
  });

  // 메모 삭제
  await T('QA-5', '메모 삭제', async () => {
    const clicked = await w.evaluate(() => {
      const cards = document.querySelectorAll('.memo-card');
      for (const c of cards) {
        if (c.querySelector('.memo-card-title')?.textContent?.includes('QA-V2')) {
          c.click(); return true;
        }
      }
      return false;
    });
    if (!clicked) throw new Error('카드 없음');
    await w.waitForTimeout(500);
    await w.evaluate(() => document.getElementById('memo-delete-btn')?.classList.remove('hidden'));
    await w.click('#memo-delete-btn');
    await w.waitForTimeout(500);
    await w.click('#confirm-ok');
    await w.waitForTimeout(1500);
  });

  await closeModals(w);
  await ss(w, '05-memo-done');

  // ═══════════════════════════════════════════════════════
  // QA-6: 탭 & 단축키
  // ═══════════════════════════════════════════════════════
  log('\n── QA-6: 탭 & 단축키 ──');

  await w.click('[data-tab="bookmarks"]');
  await w.waitForTimeout(500);

  await T('QA-6', '새 탭 (JS)', async () => {
    const before = (await w.$$('.dyn-tab')).length;
    await w.evaluate(() => window.__newTab && window.__newTab());
    await w.waitForTimeout(2000);
    const after = (await w.$$('.dyn-tab')).length;
    if (after <= before) throw new Error(`${before} -> ${after}`);
  });

  await ss(w, '06-newtab');

  await T('QA-6', '탭 닫기 (JS)', async () => {
    const before = (await w.$$('.dyn-tab')).length;
    if (before === 0) throw new Error('탭 없음');
    await w.evaluate(() => window.__closeActiveTab && window.__closeActiveTab());
    await w.waitForTimeout(1000);
    const after = (await w.$$('.dyn-tab')).length;
    if (after >= before) throw new Error(`${before} -> ${after}`);
  });

  await T('QA-6', '탭 복원 (JS)', async () => {
    const before = (await w.$$('.dyn-tab')).length;
    await w.evaluate(() => window.__reopenClosedTab && window.__reopenClosedTab());
    await w.waitForTimeout(2000);
    const after = (await w.$$('.dyn-tab')).length;
    if (after <= before) throw new Error(`${before} -> ${after}`);
  });

  // 탭 2개 생성 -> 전환
  await T('QA-6', '탭 전환 (__nextTab)', async () => {
    await w.evaluate(() => window.__newTab && window.__newTab());
    await w.waitForTimeout(2000);
    const before = await w.evaluate(() => document.querySelector('.dyn-tab.active')?.dataset?.dynId || '');
    await w.evaluate(() => window.__nextTab && window.__nextTab());
    await w.waitForTimeout(500);
    const after = await w.evaluate(() => document.querySelector('.dyn-tab.active')?.dataset?.dynId || '');
    if (before === after && (await w.$$('.dyn-tab')).length > 1) throw new Error('탭 전환 안됨');
  });

  await T('QA-6', 'F11 전체화면', async () => {
    const bw = await app.browserWindow(w);
    const b = await bw.evaluate(w => w.isFullScreen());
    await bw.evaluate(w => w.setFullScreen(!w.isFullScreen()));
    await w.waitForTimeout(1000);
    const a = await bw.evaluate(w => w.isFullScreen());
    if (b === a) throw new Error('토글 안됨');
    await bw.evaluate(w => w.setFullScreen(false));
    await w.waitForTimeout(500);
  });

  await cleanTabs(w);

  // ═══════════════════════════════════════════════════════
  // QA-7: 탭 고급 기능
  // ═══════════════════════════════════════════════════════
  log('\n── QA-7: 탭 고급 기능 ──');

  await T('QA-7', '새 탭 버튼 (#btn-add-tab)', async () => {
    await w.click('#btn-add-tab');
    await w.waitForTimeout(2000);
    if ((await w.$$('.dyn-tab')).length === 0) throw new Error('탭 없음');
  });

  await T('QA-7', '탭 draggable 속성', async () => {
    const drag = await w.evaluate(() => {
      const tab = document.querySelector('.dyn-tab');
      return tab?.getAttribute('draggable');
    });
    record('QA-7', 'draggable', drag === 'true' ? 'PASS' : 'WARN', `draggable="${drag}"`);
  });

  await T('QA-7', '툴바 뒤로 버튼', async () => {
    if (!(await w.$('#dtf-back'))) throw new Error('#dtf-back 없음');
  });

  await T('QA-7', '툴바 앞으로 버튼', async () => {
    if (!(await w.$('#dtf-forward'))) throw new Error('#dtf-forward 없음');
  });

  await T('QA-7', '새로고침 버튼', async () => {
    if (!(await w.$('#dtf-refresh'))) throw new Error('#dtf-refresh 없음');
  });

  await T('QA-7', '외부 열기 버튼', async () => {
    if (!(await w.$('#dtf-external'))) throw new Error('#dtf-external 없음');
  });

  await T('QA-7', 'URL 바 존재', async () => {
    const bar = await w.$('#dtf-url-input') || await w.$('.dtf-url-bar');
    if (!bar) throw new Error('URL 바 없음');
  });

  await T('QA-7', 'URL 바 네비게이션', async () => {
    const bar = await w.$('#dtf-url-input') || await w.$('.dtf-url-bar');
    if (!bar) throw new Error('URL 바 없음');
    await bar.click();
    await bar.fill('https://example.com');
    await w.keyboard.press('Enter');
    await w.waitForTimeout(3000);
  });

  await ss(w, '07-url-nav');

  await T('QA-7', '줌 인 버튼', async () => {
    const btn = await w.$('#dtf-zoom-in');
    if (!btn) throw new Error('#dtf-zoom-in 없음');
    await btn.click();
    await w.waitForTimeout(300);
    const label = await w.evaluate(() => document.querySelector('#dtf-zoom-label')?.textContent || '');
    record('QA-7', '줌 인 후', 'PASS', label);
  });

  await T('QA-7', '줌 아웃 버튼', async () => {
    const btn = await w.$('#dtf-zoom-out');
    if (!btn) throw new Error('#dtf-zoom-out 없음');
    await btn.click();
    await w.waitForTimeout(300);
  });

  await T('QA-7', '줌 리셋 버튼', async () => {
    const btn = await w.$('#dtf-zoom-reset');
    if (!btn) throw new Error('#dtf-zoom-reset 없음');
    await btn.click();
    await w.waitForTimeout(300);
    const label = await w.evaluate(() => document.querySelector('#dtf-zoom-label')?.textContent || '');
    if (!label.includes('100')) throw new Error(`리셋 후 줌: ${label}`);
  });

  await T('QA-7', '분할 보기 버튼', async () => {
    const btn = await w.$('#dtf-split-btn');
    if (!btn) throw new Error('#dtf-split-btn 없음');
  });

  await T('QA-7', 'URL 메모 버튼', async () => {
    const btn = await w.$('#dtf-note-btn');
    if (!btn) throw new Error('#dtf-note-btn 없음');
  });

  await T('QA-7', '탭 닫기 버튼 (.dyn-tab-close)', async () => {
    const btn = await w.$('.dyn-tab-close');
    if (!btn) throw new Error('.dyn-tab-close 없음');
    await btn.click();
    await w.waitForTimeout(1000);
  });

  await ss(w, '07-tab-closed');
  await cleanTabs(w);

  // ═══════════════════════════════════════════════════════
  // QA-8: 검색 & 명령 팔레트
  // ═══════════════════════════════════════════════════════
  log('\n── QA-8: 검색 & 명령 팔레트 ──');

  await T('QA-8', '명령 팔레트 열기', async () => {
    await w.evaluate(() => window.__commandPalette && window.__commandPalette());
    await w.waitForTimeout(500);
    const visible = await w.evaluate(() => {
      const el = document.getElementById('cmd-palette');
      return el && !el.classList.contains('hidden') && el.style.display !== 'none';
    });
    if (!visible) throw new Error('팔레트 안 열림');
  });

  await ss(w, '08-cmd-palette');

  await T('QA-8', '명령 팔레트 입력', async () => {
    const input = await w.$('#cmd-input');
    if (!input) throw new Error('#cmd-input 없음');
    await input.fill('북마크');
    await w.waitForTimeout(500);
    const items = await w.$$('.cmd-result-item');
    record('QA-8', '검색 결과', 'PASS', `${items.length}개`);
  });

  await T('QA-8', '명령 팔레트 닫기', async () => {
    await w.evaluate(() => window.__closeCommandPalette && window.__closeCommandPalette());
    await w.waitForTimeout(300);
  });

  // 새 탭 열어서 Find in page
  await w.evaluate(() => window.__newTab && window.__newTab());
  await w.waitForTimeout(2000);

  await T('QA-8', '페이지 내 검색 열기', async () => {
    await w.evaluate(() => window.__findInPage && window.__findInPage());
    await w.waitForTimeout(500);
    const bar = await w.$('#find-bar');
    if (!bar) throw new Error('#find-bar 없음');
    const visible = await bar.evaluate(el => !el.classList.contains('hidden') && el.style.display !== 'none');
    if (!visible) throw new Error('검색 바 안 보임');
  });

  await ss(w, '08-find-bar');

  await T('QA-8', '검색 바 필드', async () => {
    for (const sel of ['#find-bar-input', '#find-bar-prev', '#find-bar-next', '#find-bar-close']) {
      if (!(await w.$(sel))) throw new Error(`${sel} 없음`);
    }
  });

  await T('QA-8', '검색 바 닫기', async () => {
    await w.evaluate(() => window.__closeFindBar && window.__closeFindBar());
    await w.waitForTimeout(300);
  });

  await cleanTabs(w);

  // ═══════════════════════════════════════════════════════
  // QA-9: 잠금/인증 심화
  // ═══════════════════════════════════════════════════════
  log('\n── QA-9: 잠금/인증 심화 ──');

  await T('QA-9', '사용자 드롭다운 열기', async () => {
    await w.click('#user-badge');
    await w.waitForTimeout(500);
    const dd = await w.$('#user-dropdown');
    if (!dd) throw new Error('#user-dropdown 없음');
    const visible = await dd.evaluate(el => !el.classList.contains('hidden'));
    if (!visible) throw new Error('드롭다운 숨겨짐');
  });

  await ss(w, '09-user-dropdown');

  await T('QA-9', '로그아웃 버튼', async () => {
    const btn = await w.$('#btn-logout');
    if (!btn) throw new Error('#btn-logout 없음');
  });

  await T('QA-9', '비밀번호 변경 버튼', async () => {
    const btn = await w.$('#btn-change-pw');
    if (!btn) throw new Error('#btn-change-pw 없음');
  });

  await T('QA-9', '비밀번호 변경 모달', async () => {
    await w.click('#btn-change-pw');
    await w.waitForTimeout(500);
    const modal = await w.$('#pw-modal');
    if (!modal) throw new Error('#pw-modal 없음');
    const visible = await modal.evaluate(el => !el.classList.contains('hidden'));
    if (!visible) throw new Error('모달 숨겨짐');
    for (const sel of ['#pw-current', '#pw-new', '#pw-confirm']) {
      if (!(await w.$(sel))) throw new Error(`${sel} 없음`);
    }
  });

  await closeModals(w);

  // 잠금 화면
  await T('QA-9', '잠금 화면 활성화', async () => {
    const hasPIN = await w.evaluate(() => {
      const u = JSON.parse(sessionStorage.getItem('user') || '{}');
      return !!u.pin_code;
    });
    await w.evaluate(() => Auth.showLockScreen());
    await w.waitForTimeout(500);
    const visible = await w.evaluate(() => {
      const el = document.getElementById('lock-screen');
      return el && !el.classList.contains('hidden');
    });
    if (hasPIN) {
      if (!visible) throw new Error('PIN 설정인데 잠금 안됨');
      record('QA-9', 'PIN 잠금', 'PASS', 'PIN 있음, 잠금 화면 표시');
    } else {
      record('QA-9', 'PIN 미설정', visible ? 'WARN' : 'PASS',
        visible ? 'PIN 없는데 잠김' : 'PIN 없음 -> 잠기지 않음');
    }
  });

  await T('QA-9', '잠금 화면 UI', async () => {
    const visible = await w.evaluate(() => {
      const el = document.getElementById('lock-screen');
      return el && !el.classList.contains('hidden');
    });
    if (visible) {
      const input = await w.$('#lock-pin-input');
      if (!input) throw new Error('#lock-pin-input 없음');
      await w.evaluate(() => document.getElementById('lock-screen').classList.add('hidden'));
      await w.waitForTimeout(300);
    } else {
      record('QA-9', '잠금 화면', 'PASS', '잠금 미활성 (PIN 없음)');
    }
  });

  await ss(w, '09-lock');

  // ═══════════════════════════════════════════════════════
  // QA-10: 설정 심화
  // ═══════════════════════════════════════════════════════
  log('\n── QA-10: 설정 심화 ──');

  await T('QA-10', '설정 열기', async () => {
    await w.click('#btn-settings');
    await w.waitForTimeout(1000);
  });

  await ss(w, '10-settings');

  await T('QA-10', '프로필 이름', async () => {
    const input = await w.$('#setting-display-name');
    if (!input) throw new Error('없음');
    const v = await input.inputValue();
    record('QA-10', '표시 이름', 'PASS', `"${v}"`);
  });

  await T('QA-10', '자동 잠금 토글', async () => {
    const el = await w.$('#setting-lock-enabled');
    if (!el) throw new Error('#setting-lock-enabled 없음');
  });

  await T('QA-10', '잠금 시간 설정', async () => {
    const el = await w.$('#setting-lock-timeout');
    if (!el) throw new Error('#setting-lock-timeout 없음');
    const v = await el.inputValue();
    record('QA-10', '잠금 시간', 'PASS', `${v}분`);
  });

  await T('QA-10', 'PIN 입력 필드', async () => {
    const el = await w.$('#setting-pin');
    if (!el) throw new Error('#setting-pin 없음');
  });

  await T('QA-10', '카테고리 관리 목록', async () => {
    const list = await w.$('#category-list');
    if (!list) throw new Error('#category-list 없음');
    const items = await w.$$('.category-manage-item');
    record('QA-10', '카테고리 수', 'PASS', `${items.length}개`);
  });

  await T('QA-10', '카테고리 추가 버튼', async () => {
    const btn = await w.$('#btn-add-category');
    if (!btn) throw new Error('#btn-add-category 없음');
  });

  await T('QA-10', '앱 버전 표시', async () => {
    const el = await w.$('#app-version-display');
    if (!el) throw new Error('#app-version-display 없음');
    const txt = await el.textContent();
    record('QA-10', '버전 텍스트', 'PASS', txt.trim());
  });

  await T('QA-10', '업데이트 이력 버튼', async () => {
    await w.click('#btn-update-history');
    await w.waitForTimeout(1500);
    const versions = await w.evaluate(() =>
      Array.from(document.querySelectorAll('.update-release-version')).map(e => e.textContent.trim())
    );
    record('QA-10', '버전 수', versions.length > 0 ? 'PASS' : 'FAIL', `${versions.length}개`);
  });

  await ss(w, '10-update-history');
  await closeModals(w);

  await T('QA-10', '설정 닫기', async () => {
    await w.evaluate(() => {
      const panel = document.getElementById('settings-panel');
      if (panel) panel.classList.add('hidden');
      const overlay = document.getElementById('panel-overlay');
      if (overlay) overlay.classList.add('hidden');
    });
    await w.waitForTimeout(500);
  });

  // 메인 프로세스 정보
  await T('QA-10', '앱 버전 (메인)', async () => {
    const v = await app.evaluate(({ app }) => app.getVersion());
    record('QA-10', '버전', 'PASS', `v${v}`);
  });

  await T('QA-10', 'userData 경로', async () => {
    const p = await app.evaluate(({ app }) => app.getPath('userData'));
    record('QA-10', '경로', 'PASS', p);
  });

  // ═══════════════════════════════════════════════════════
  // QA-11: UI 구조 확인
  // ═══════════════════════════════════════════════════════
  log('\n── QA-11: UI 구조 ──');

  await T('QA-11', '#confirm-dialog 구조', async () => {
    for (const sel of ['#confirm-dialog', '#confirm-title', '#confirm-message', '#confirm-cancel', '#confirm-ok']) {
      if (!(await w.$(sel))) throw new Error(`${sel} 없음`);
    }
  });

  await T('QA-11', '#download-bar (동적)', async () => {
    const exists = await w.$('#download-bar');
    if (!exists) record('QA-11', 'download-bar', 'PASS', '동적 생성 요소 - 다운로드 시 생성됨');
  });

  await T('QA-11', '메인 탭 바', async () => {
    for (const sel of ['[data-tab="bookmarks"]', '[data-tab="calendar"]', '[data-tab="memos"]', '#btn-add-tab']) {
      if (!(await w.$(sel))) throw new Error(`${sel} 없음`);
    }
  });

  await T('QA-11', '설정/사용자 버튼', async () => {
    if (!(await w.$('#btn-settings'))) throw new Error('#btn-settings 없음');
    if (!(await w.$('#user-badge'))) throw new Error('#user-badge 없음');
  });

  await ss(w, '11-final');

  // ═══════════════════════════════════════════════════════
  // 결과 집계
  // ═══════════════════════════════════════════════════════
  log('\n' + '═'.repeat(50));
  log('     LinkFlow Electron 상세 QA v2 결과');
  log('═'.repeat(50));

  const pass = results.filter(r => r.status === 'PASS').length;
  const fail = results.filter(r => r.status === 'FAIL').length;
  const warn = results.filter(r => r.status === 'WARN').length;
  const total = results.length;

  log(`PASS: ${pass} | FAIL: ${fail} | WARN: ${warn} | 총: ${total}`);
  log(`통과율: ${(pass / total * 100).toFixed(1)}%`);

  const groups = {};
  results.forEach(r => {
    if (!groups[r.group]) groups[r.group] = { pass: 0, fail: 0, warn: 0 };
    groups[r.group][r.status.toLowerCase()]++;
  });

  log('\n그룹별:');
  Object.entries(groups).forEach(([g, c]) => {
    log(`  ${g}: ${c.pass} PASS / ${c.fail} FAIL / ${c.warn} WARN`);
  });

  if (fail > 0) {
    log('\n실패 항목:');
    results.filter(r => r.status === 'FAIL').forEach(r => {
      log(`  \u274C [${r.group}] ${r.name}: ${r.detail}`);
    });
  }
  if (warn > 0) {
    log('\n경고 항목:');
    results.filter(r => r.status === 'WARN').forEach(r => {
      log(`  \u26A0\uFE0F [${r.group}] ${r.name}: ${r.detail}`);
    });
  }

  const report = {
    timestamp: new Date().toISOString(),
    version: 'v2',
    summary: { total, pass, fail, warn, passRate: `${(pass / total * 100).toFixed(1)}%` },
    groups,
    results,
  };

  fs.writeFileSync(path.join(RESULTS_DIR, 'qa-report-v2.json'), JSON.stringify(report, null, 2), 'utf-8');
  log(`\n결과: ${path.join(RESULTS_DIR, 'qa-report-v2.json')}`);

  log('\n종료 전 테스트 데이터 정리...');
  await cleanupTestData(w);

  await app.close();
  log('QA v2 완료.');
  process.exit(fail > 0 ? 1 : 0);
})();
