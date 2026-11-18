# Home Simulator

원본 치수 평면도와 3D 참고 이미지 3장으로 재구성한 주택 **3D CAD 모델 및 웹 뷰어**입니다.

**웹 뷰어 (GitHub Pages):** https://hanana-kick.github.io/Home-Simulator/

## 기능

- 전체 높이, 1,080mm 단면, 평면 보기를 전환
- 3D 회전·확대·이동, 평면 보기에서 수직 시점 유지
- 공간 선택, 면적·치수 표시 및 가구·창호·마당·레이블 표시 전환
- 참고 이미지 4장 확대·비교
- WebGL이 없으면 CPU 소프트웨어 렌더러로 전환
- 브라우저에서 STEP, DXF, GLB, SCAD 다운로드

## CAD 파일

| 경로 | 형식 | 단위 |
|---|---|---|
| [cad/floorplan_3d.step](cad/floorplan_3d.step) | STEP AP214, 250개 faceted BREP 솔리드 | mm |
| [cad/floorplan_3d.dxf](cad/floorplan_3d.dxf) | DXF, 레이어 10개, 6,821개 3DFACE | mm |
| [cad/floorplan_3d.glb](cad/floorplan_3d.glb) | glTF 2.0, 재질 포함, 349개 객체 | m |
| [cad/floorplan_3d.scad](cad/floorplan_3d.scad) | OpenSCAD 편집용 기하 | mm |
| [cad/model.json](cad/model.json) | 공간·객체·재질·가정값 모델 데이터 | m |

메인 뷰어는 단일 HTML에 CAD 다운로드 데이터까지 포함합니다. GitHub 업로드 크기 제약을 피하기 위해 원본 HTML(7,650,163 bytes)을 **[source/viewer](source/viewer)** 아래 순서가 있는 16개 조각으로 보관하고, GitHub Actions에서 복원합니다. 복원 후 SHA-256 해시를 검사해 원본과 일치함을 검증합니다.

## 면적 및 가정

| 공간 | 평면도 표기 |
|---|---:|
| 큰 방 | 14㎡ |
| 거실·주방 | 17㎡ |
| 작업실 | 6㎡ |
| 욕실 | 3㎡ |
| 현관 공간 | 1㎡ |
| 좌측 발코니 | 4㎡ |
| 우측 다용도실 | 5㎡ |
| 마당 | 29㎡ |

벽 높이 **2,700mm**, 벽 두께 **200mm**, 실내 문 높이 **2,100mm**, 마당 담장 높이 **500mm** 등은 원본 평면도에 표시되지 않은 가정값입니다. 실제 시공·구조 검토에는 현장 실측값이 필요합니다. 원본 치수·참고 이미지를 기반으로 만든 시각적 복원 모델입니다.

## 자동 배포

`main`에 커밋하면 [.github/workflows/pages.yml](.github/workflows/pages.yml)이 정적 뷰어를 조립하고 `_site`를 GitHub Pages로 배포합니다.

- **처음 사용한다면** 저장소의 **Settings → Pages → Build and deployment → Source: GitHub Actions**를 선택해야 합니다.
- 개인 GitHub Free에서는 Pages가 **공개 저장소**에서만 지원됩니다. 개인 Pro 이상에서는 비공개 저장소에서 제공할 수 있지만 Pages 사이트는 일반적으로 공개 접근 가능합니다.
- 배포 상태는 저장소 **Actions**의 `Publish Home Simulator to GitHub Pages`에서 확인합니다.

## 참고 이미지

`references/source_plan.jpg`는 원본 치수 평면도, `references/reference_*.jpg`는 이미지 기반 기하와 개구부·재질을 검토하기 위한 입체 참고 이미지입니다.

## 검증 범위

STEP는 FreeCAD import, OpenSCAD CSG 컴파일, GLB/DXF 기하 정합성 및 소프트웨어 렌더링 테스트를 통과한 Revision 3 모델입니다. 브라우저의 실제 WebGL 경로는 아직 별도 테스트가 필요합니다.
