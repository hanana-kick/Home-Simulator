# Home Simulator

치수 평면도와 세 장의 3D 참고 이미지를 바탕으로 복원한 3D 주택 모델·CAD 뷰어입니다.

## 온라인 뷰어

- GitHub Pages: https://hanana-kick.github.io/Home-Simulator/
- 정적 사이트 소스: [site/index.html](site/index.html)
- 배포 워크플로: [.github/workflows/pages.yml](.github/workflows/pages.yml)

`site/index.html`은 WebGL 및 소프트웨어 렌더러를 포함한 독립 실행형 HTML입니다. 빌드·CDN·외부 JS 의존성 없이 브라우저에서 실행되며, STEP/DXF/GLB/SCAD 다운로드 데이터와 원본 참조 이미지도 HTML에 포함되어 있습니다.

## 기능

- 전체 높이 / 단면(1,080mm) / 평면 보기, 3D 회전·이동·확대
- 실내 7개 공간 및 L자 마당을 선택해 치수·면적 확인
- 창호·가구·마당·레이블 표시 전환
- 평면도와 3장의 3D 참고 이미지 비교
- STEP(250개 솔리드), DXF, GLB, SCAD 다운로드
- 웹GL을 사용할 수 없는 브라우저에서 소프트웨어 렌더러로 전환

## 설계 데이터

원본 도면에서 직접 확인되지 않는 높이 및 가구 치수는 **가정값**입니다. 벽 높이 2,700mm, 벽 두께 200mm, 일반 문 개구 높이 2,100mm, 담장 높이 500mm를 적용했습니다. 시공용 확정 도면이 아닌 시각적 복원 모델입니다.

## GitHub Pages

`main` 브랜치에 푸시하면 GitHub Actions가 `site/`를 Pages에 배포하도록 설정합니다. 최초 사용 시 **Settings → Pages → Build and deployment → Source → GitHub Actions** 설정이 필요할 수 있습니다. 개인 계정의 GitHub Free 플랜은 공개 저장소에서만 Pages를 사용할 수 있습니다.
