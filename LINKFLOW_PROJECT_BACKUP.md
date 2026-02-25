# LinkFlow 프로젝트 백업 가이드

> 생성일: 2026-02-25
> 목적: Windows → MacBook 개발 환경 이전

---

## 1. 프로젝트 구조 개요

### 프로젝트 A: 웹앱 (Vercel 배포)
- **위치**: `통합접속/` 폴더
- **GitHub**: https://github.com/handminjun504/bookmark.git (branch: master)
- **배포 URL**: https://bookmark-one-lemon.vercel.app
- **기술스택**: Python FastAPI (백엔드) + Vanilla JS (프론트엔드)

### 프로젝트 B: Electron 데스크톱 앱
- **위치**: `unified-access-app/` 폴더
- **GitHub**: https://github.com/handminjun504/linkflow.git (branch: master)
- **기술스택**: Electron 33 + electron-updater + electron-builder
- **현재 버전**: v1.2.0

---

## 2. 핵심 서비스/계정 정보

| 서비스 | URL/정보 |
|--------|----------|
| Supabase | https://ibriytshrletodxqsbgx.supabase.co |
| Supabase Key | `sb_publishable_KTmrtAyixh166NfwwjqXNA_SjH3QB1N` |
| Vercel | bookmark-one-lemon.vercel.app |
| GitHub (웹앱) | handminjun504/bookmark |
| GitHub (Electron) | handminjun504/linkflow |

### 환경변수 (.env)
```
SUPABASE_URL=https://ibriytshrletodxqsbgx.supabase.co
SUPABASE_KEY=sb_publishable_KTmrtAyixh166NfwwjqXNA_SjH3QB1N
JWT_SECRET=(Vercel에 설정된 값 확인 필요)
```

---

## 3. MacBook에서 세팅 방법

### 3-1. 웹앱 (통합접속)
```bash
git clone https://github.com/handminjun504/bookmark.git linkflow-web
cd linkflow-web
pip install -r requirements.txt

# .env 파일 생성 (위 환경변수 참조)
# Vercel CLI로 배포: vercel --prod
```

### 3-2. Electron 앱
```bash
git clone https://github.com/handminjun504/linkflow.git linkflow-electron
cd linkflow-electron
npm install

# 개발 실행
npm start

# macOS 빌드 (package.json의 build 섹션에 mac 타겟 추가 필요)
# npm run build-installer
```

### 3-3. Mac 빌드를 위한 package.json 수정
`build` 섹션에 추가:
```json
"mac": {
  "target": ["dmg"],
  "icon": "icon.png"
}
```
scripts에 추가:
```json
"build-mac": "electron-builder --mac dmg",
"publish-mac": "electron-builder --mac dmg --publish always"
```

---

## 4. 주요 파일 설명

### 웹앱 (통합접속/)
| 파일 | 역할 |
|------|------|
| `api/index.py` | FastAPI 백엔드 전체 (인증, CRUD, 헬스체크) |
| `lib/config.py` | Supabase/JWT 설정 |
| `lib/database.py` | Supabase DB 래퍼 |
| `lib/auth.py` | JWT 토큰 생성/검증 |
| `public/js/app.js` | 메인 앱 로직 (북마크, 동적탭, 비밀번호 관리) |
| `public/js/auth.js` | 로그인/로그아웃/자동로그인/잠금 |
| `public/js/calendar.js` | 캘린더 + 반복일정 |
| `public/js/memos.js` | 메모 기능 |
| `public/js/ui.js` | UI 유틸, 서비스 타입 상수 |
| `public/css/style.css` | 전체 스타일 |
| `public/index.html` | SPA HTML |
| `vercel.json` | Vercel 라우팅/헤더 설정 |

### Electron 앱 (unified-access-app/)
| 파일 | 역할 |
|------|------|
| `main.js` | Electron 메인 프로세스 (윈도우, 트레이, 비밀번호 저장소, 쿠키 영속, 자동업데이트) |
| `preload.js` | contextBridge - 웹앱↔메인 IPC 브릿지 |
| `preload-webview.js` | webview용 - 비밀번호 감지/자동입력 |
| `package.json` | 빌드 설정, electron-updater, GitHub publish 설정 |
| `icon.png` / `icon.ico` | 앱 아이콘 |

---

## 5. 구현된 기능 목록

### 웹앱
- [x] 로그인/로그아웃 + 자동 로그인 (device_token)
- [x] 관리자 계정 생성 + 사용자 관리
- [x] 북마크 CRUD (카테고리, 유형별 그룹, 드래그 정렬)
- [x] 서비스 유형: 웹사이트, 구글시트, 서버, 앱스크립트, API, 개발/자동화, 기타
- [x] 웹사이트 유형만 파비콘 사용
- [x] 공용 북마크 (관리자용)
- [x] 서비스 상태 모니터링 (헬스체크)
- [x] 캘린더 (일정 + 반복일정 + 업무 체크)
- [x] 이번 주 업무 사이드바 (요일별 색상)
- [x] 메모 (CRUD, 핀, 배경색)
- [x] 화면 잠금 (PIN 1~4자리, 타임아웃 설정)
- [x] PWA (앱 아이콘, 데스크톱 추가)
- [x] 검색 기능

### Electron 앱
- [x] 웹앱 래핑 (bookmark-one-lemon.vercel.app 로드)
- [x] 동적 탭 (메모 옆에 + 버튼으로 추가, 구글 기본)
- [x] webview 기반 탭 (iframe 대신, 모든 사이트 호환)
- [x] 탭 분리 (새 창으로 분리 버튼)
- [x] 탭 내 네비게이션 (뒤로/앞으로/새로고침/URL바)
- [x] 개발자 도구 (F12, Ctrl+Shift+I)
- [x] F5/Ctrl+R → 활성 탭만 새로고침 (앱 전체 X)
- [x] 반응형 줌 (창 크기) + Ctrl+휠 수동 줌
- [x] 시스템 트레이 (닫기 시 트레이로)
- [x] 비밀번호 저장/자동입력 (safeStorage 암호화)
- [x] 계정별 + PC별 비밀번호 격리
- [x] 쿠키/캐시 영속 (세션쿠키 → 30일 영구쿠키 변환)
- [x] NSIS 설치 파일 (.exe)
- [x] 인앱 자동 업데이트 (electron-updater + GitHub Releases)

---

## 6. 배포 프로세스

### 웹앱 배포 (Vercel)
```bash
cd linkflow-web
git add -A
git commit -m "설명"
git push
# Vercel이 자동 배포
```

### Electron 앱 배포 (GitHub Releases)
```bash
cd linkflow-electron

# 1. package.json version 올리기
# 2. 코드 수정
git add -A
git commit -m "v1.3.0"
git push

# 3. GH_TOKEN 환경변수 필요
export GH_TOKEN="your-github-pat"
npm run publish
# → GitHub Releases에 자동 게시
# → 기존 사용자 앱에서 자동 업데이트 감지
```

---

## 7. 데이터베이스 (Supabase)

### 테이블 구조
- `users` - 사용자 (id, username, password_hash, display_name, is_admin, lock_enabled, lock_timeout, pin_code)
- `trusted_devices` - 자동 로그인 기기 (device_token, user_id, device_name)
- `categories` - 카테고리 (id, user_id, name, icon, is_shared)
- `bookmarks` - 북마크 (id, user_id, title, url, description, category_id, service_type, health_check_url, icon_url, is_shared, open_mode, sort_order)
- `calendar_events` - 캘린더 일정 (id, user_id, title, date, end_date, time, description, color, is_task, is_done, remind_minutes, recurrence, recurrence_end)
- `memos` - 메모 (id, user_id, title, content, color, is_pinned, created_at, updated_at)

> RLS(Row Level Security) 비활성화 상태 - 앱 레벨에서 권한 관리

---

## 8. 유틸리티 스크립트 (바탕화면)

| 파일 | 용도 |
|------|------|
| `_deploy.py` | 웹앱 git push + Electron dir 빌드 + 폴더 복사 |
| `_deploy2.py` | 웹앱 push + NSIS 설치 파일 빌드 |
| `_deploy3.py` | 웹앱 push + NSIS 빌드 + 바탕화면 복사 |
| `_publish.py` | git credential에서 GH_TOKEN 추출 + `npm run publish` |
| `_create_repo.py` | GitHub API로 linkflow 저장소 생성 |
| `_gen_icon.py` | PWA 아이콘 생성 (192x192, 512x512) |
| `_gen_electron_icon.py` | Electron 아이콘 생성 (icon.png, icon.ico) |
| `_copy_app.py` | Electron 빌드 결과물 복사 |

---

## 9. 알려진 이슈 / 참고사항

- Git 한글 경로 문제: PowerShell에서 직접 `cd 통합접속` 불가 → Python subprocess 사용
- macOS에서 Electron 빌드 시 `icon.icns` 형식 필요 (icon.png에서 변환)
- `electron-builder`로 Mac DMG 빌드하려면 macOS에서 실행해야 함
- GitHub PAT(Personal Access Token)이 `publish` 시 필요 (GH_TOKEN 환경변수)
- Vercel 환경변수는 Vercel 대시보드에서 확인/설정

---

## 10. 앱 이름 및 디자인

- **앱 이름**: LinkFlow
- **색상**: 하늘색(#4DA8DA) + 흰색 기반
- **폰트**: Pretendard (로컬 번들)
- **아이콘**: 파란 둥근 사각형 + 흰색 허브 심볼
