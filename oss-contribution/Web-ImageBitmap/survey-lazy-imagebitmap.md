# survey: createImageBitmap の遅延化

## 目的
`createImageBitmap` の画像処理を可能な限り遅延させ、仕様互換性・破壊的変更回避・性能向上を両立する。

## 参照資料
- plan-lazy-imagebitmap.md
- PR: https://github.com/denoland/deno/pull/28105

## 現状把握（main: ext/image）
### 実装概要
- `createImageBitmap` は JS 側で引数検証（`sw/sh == 0`、`resizeWidth/resizeHeight == 0` など）を即時 reject。
- `Blob` の場合は MIME sniff 後、全バイトを取得し Rust 側へ。
- Rust 側 `op_create_image_bitmap` は即時に以下を実行し `DynamicImage` を保持:
  - デコード
  - クロップ
  - リサイズ
  - 方向補正（Exif + imageOrientation）
  - 色空間変換
  - premultiply/unpremultiply
- `ImageBitmap` は `DynamicImage` を保持し、`width/height` はそこから取得。

### getData の位置づけ
- `Deno[Deno.internal].getBitmapData` から `SymbolFor("Deno_bitmapData")` を通じて呼び出される。
- テスト（`tests/unit/image_bitmap_test.ts`）でのみ利用される前提。
- これは遅延デコードのトリガーにできる余地がある。

### structuredClone / transfer の現状
- `structuredClone(ImageBitmap)` は `{}` になる（`img-clone.js` の実行結果）。
- `postMessage` の transferables に渡すと `DataCloneError` になる（`img-transfer.js` の実行結果）。
- 現時点では `ImageBitmap` は host object としての serialize/transfer 未対応と判断できる。

## PR #28105（copyExternalImageToTexture）の示唆
- `ImageBitmap` が Rust 側 `cppgc` オブジェクトとして実装され、`DynamicImage` を保持。
- `GPUQueue.copyExternalImageToTexture` は `ImageBitmap` を消費し、Queue timeline に沿って以下を実行:
  - `source.origin` と `copySize` の境界検証（幅/高さ/`depthOrArrayLayers`）。
  - `source.source` の detached 判定（`ImageSourceAleadyDetached`）。
  - `destination.texture.format` のブロック次元検証（2D かつ 1x1 前提）。
  - crop を先に適用（`deno_canvas::crop`）。
  - `flipY` の適用（`Orientation::FlipVertical`）。
  - `premultipliedAlpha` に応じた premultiply（ただし「既に premultiply 済みかどうか」を判定できないため内部推測に依存）。
  - `colorSpace` 変換（`transform_rgb_color_space`）。コメントとして「ImageBitmap は即時変換せず、オンザフライが必要」と明記。
  - `bytes_per_row` / `rows_per_image` を設定し `queue_write_texture` で転送。
  - RGB 形式は RGBA に変換してから転送（`GPUCopyExternalImageSource` 側の制約に合わせる）。
- つまり PR 側の `copyExternalImageToTexture` は「ImageBitmap の保持情報を使って、描画/転送時に変換を適用する」方向の設計を含んでいる。

## 遅延化の設計余地
### 遅延可能（候補）
- クロップ
- リサイズ
- 方向補正
- 色空間変換
- premultiply/unpremultiply
- 実ピクセルデコード

### 即時に必要
- 引数チェック（`sw/sh == 0`、`resizeWidth/resizeHeight == 0`）
- 非対応 MIME などの即時エラー
- `width/height` の確定（ユーザーに観測されるため）

### 互換性・エラータイミングの論点
- 現行は decode に失敗した場合、`createImageBitmap` の Promise が reject される前提。
- ヘッダ解析のみで `width/height` を確定できても、実デコードでしか検出できない破損がある。
- 遅延化により「不正画像の reject が遅れる」挙動変更が起きないように要検討。
- 仕様互換を重視するなら、少なくとも「不正画像の検知」は `createImageBitmap` 内で完結させる必要がある。
- 妥協案:
  - 画像デコード自体は即時に行い、後段の処理（crop/resize/色変換/premultiply）だけ遅延する。
  - ヘッダ解析のみで `width/height` を確定し、実デコードは遅延する（ただし reject タイミングが遅れる可能性がある）。

## 画像デコーダAPI（image crate）で確認したこと
- `ImageDecoder` には `dimensions()` と `color_type()` があり、ピクセルの `read_image()` 前にメタ情報を取得できる。
- `icc_profile()` と `orientation()` はメタデータ取得用の API として提供されている。
- `read_image()` は全ピクセルデコードを行うため、遅延化の境界として扱える。
- ただし decoder 構築やメタ取得の段階でもエラーが起きる可能性があり、完全な破損検出は `read_image()` まで残る。

## 遅延パイプライン案（たたき台）
- Blob:
  - MIME sniff は即時。
  - デコーダ生成後に `dimensions()` / `orientation()` / `icc_profile()` を取得して `width/height` と必要なメタを確定。
  - ピクセルは保持せず、エンコード済みバイトとオプションを `Lazy` に保存。
- ImageData:
  - 既に RGBA バッファなので decode は不要。
  - `LazyRaw` としてバイト列と幅・高さ・オプションを保持し、materialize 時に処理のみ実行。
- ImageBitmap:
  - 既に `Decoded` なら参照 or clone で `Lazy` を作らず即時利用。
  - `Lazy` 由来なら、元の `Lazy` を共有するか、materialize した上で処理を再適用するか検討。

- materialize（共通）:
  - 仕様順序に合わせて処理: crop -> resize -> orientation -> color space -> premultiply/unpremultiply。
  - `getData()`（テスト）と `copyExternalImageToTexture` が主なトリガー。

## 推奨アプローチ（段階的）
- 段階1（互換性重視）:
  - decode 自体は `createImageBitmap` 内で実行し、reject タイミングを維持。
  - crop/resize/方向補正/色変換/premultiply を遅延し、materialize 時に実行。
- 段階2（遅延強化・要判断）:
  - ヘッダ解析のみで `width/height` を確定し、実デコードは遅延。
  - reject タイミングが変わる可能性があるため、互換性への影響評価が必須。
- 段階3（消費側最適化）:
  - `copyExternalImageToTexture` などの消費経路で materialize を統一し、GPU側最適化の余地を残す。

## 現時点の結論
- 仕様互換と破壊的変更回避を最優先にするなら、decode の即時実行は維持すべき。
- ただし後段の処理は遅延可能であり、ここを遅延化するのが現実的な第一歩。
- decode の遅延は性能面で魅力があるが、reject タイミングの変更が最大の論点。
- 調査完了時点では段階1（互換性重視）を推奨。

## 残タスク（採用判断に依存）
- ヘッダ解析のみで `width/height` を確定する場合の互換性評価。
- 不正画像の reject タイミング変更を許容できるかの判断。
- `Lazy` の保持メタ情報を最小化する設計詳細。
- `copyExternalImageToTexture` での materialize 実装計画の具体化。

---

# 残タスク 深掘り

## 1. ヘッダ解析のみで `width/height` を確定する場合の互換性評価
### 何が問題になるか
- 画像ファイルはヘッダだけ正しくても、データ部が破損しているケースがある。
- 現行挙動では `createImageBitmap` の Promise が reject されるが、ヘッダ解析のみだと成功してしまう。

### 互換性に影響する代表ケース
- **破損した画像**: 
  - 現行: `createImageBitmap` が reject。
  - 遅延: `ImageBitmap` が返るが、後で `getData()` / GPU upload で reject。
- **巨大画像の拒否**:
  - `width/height` だけで拒否可能ならヘッダ解析で十分。
  - メモリ制限や decoder `Limits` を厳密に適用する場合は、decoder 構築段階で制限判定が必要。

### 実務的な評価軸
- 互換性の優先度が高いなら、**ヘッダ解析だけの遅延は避ける**べき。
- パフォーマンス優先なら、**ヘッダ解析 + decode 遅延**に進むが、仕様差分の文書化が必要。

### 推奨の落としどころ
- 段階1の通り「decode 即時、後段処理遅延」が最も安全。
- ヘッダ解析のみの完全遅延は、**別モード（実験的機能や内部フラグ）**として切り替えられる形が望ましい。

---

## 2. 不正画像の reject タイミング変更を許容できるか
### 仕様/互換性観点
- Web互換の観点では、`createImageBitmap` の Promise reject で不正画像を検知する利用があり得る。
- reject タイミングが遅れると、既存コードで `createImageBitmap` をバリデーション目的に使っている場合の挙動が変わる。

### 判断材料
- 既存テスト（`tests/unit/image_bitmap_test.ts`）に「不正画像の即時 reject」を確認するケースがあるか。
- 互換性の期待値が高い API（Web標準）であること。

### 可能な折衷策
- decode は即時に行い reject を維持する。
- ただし **ピクセル変換（crop/resize/etc）を遅延**することでパフォーマンス改善は得られる。

---

## 3. `Lazy` が保持するメタ情報の最小セット
### 保持が必要なもの
- `width/height`: APIとして必須
- `imageOrientation`: `from-image` の場合に必要
- `colorSpaceConversion`: `default/none` を保持
- `premultiplyAlpha`: `default/none/premultiply`
- `resizeQuality`/`resizeWidth`/`resizeHeight`
- crop 情報（`sx/sy/sw/sh`）

### 保持が任意で判断が必要なもの
- ICC profile そのもの:
  - 色変換を遅延するなら必要。
  - `colorSpaceConversion: none` の場合は不要。

### 最小セットの方針
- **Lazy状態に必要なのは「後段で再現可能な情報」だけ**
  - デコード済み `DynamicImage` に依存しないため、オプションとバイト列が中核。
- メタ情報の取得コストが高い場合、取得を遅延する選択肢もあるが、`width/height` は即時確定が必須。

---

## 4. `copyExternalImageToTexture` での materialize 実装計画
### 望ましい構成
- `ImageBitmap` 側に `materialize()` を集約し、消費側が統一的に利用可能にする。
- `copyExternalImageToTexture` では:
  1. `ImageBitmap::materialize()` で `DynamicImage` を確保
  2. 現行処理（crop/flip/premultiply/色変換）を適用
  3. GPU 書き込み用のバッファ構築

### 実装上の注意
- materialize 後の `DynamicImage` をキャッシュするか、毎回生成するかを決める必要がある。
- 複数回の `copyExternalImageToTexture` 呼び出しがある場合は、キャッシュが有効。

### キャッシュ戦略
- **Lazy -> Decoded へ昇格する一方向のキャッシュ**が最も単純。
- `close()` 呼び出し時にキャッシュを破棄する。

---

## 5. 既存ブラウザ実装の確認（Firefox）
参照: https://hg.mozilla.org/mozilla-central/raw-file/tip/dom/canvas/ImageBitmap.cpp

### 観察できたポイント
- **Blob**:
  - MIME sniff を行い、`imgTools->DecodeImageAsync` でデコード。
  - `GetFrame(FRAME_FIRST)` を取得し、`premultiplyAlpha: none` / `colorSpaceConversion: none` に応じたデコードフラグを付与。
  - crop / flipY / resize を **Promise 解決前** に適用して `ImageBitmap` を生成。
- **ImageData**:
  - `CreateSurfaceFromRawData` で crop / flipY / premultiply / resize を実行して `ImageBitmap` を生成。
- **HTMLImageElement / HTMLCanvasElement 等**:
  - `GetSurfaceFromElement` で `SFE_WANT_FIRST_FRAME_IF_IMAGE` と `SFE_ORIENTATION_FROM_IMAGE` を指定。
  - premultiply / colorspace のオプションは surface 取得時に考慮。

### 解釈
- Firefox 実装は **createImageBitmap 内でデコードと変換処理を完了**させ、Promise 解決時に確定済みの `ImageBitmap` を返している。
- 遅延化を進める場合、既存ブラウザと reject タイミングがずれる可能性がある点に注意が必要。

## 6. 既存ブラウザ実装の確認（Chromium）
参照:
- https://chromium.googlesource.com/chromium/src/+/refs/heads/main/third_party/blink/renderer/modules/canvas/imagebitmap/image_bitmap_factories.cc
- https://chromium.googlesource.com/chromium/src/+/refs/heads/main/third_party/blink/renderer/core/imagebitmap/image_bitmap.cc
- https://chromium.googlesource.com/chromium/src/+/refs/heads/main/third_party/blink/renderer/modules/canvas/imagebitmap/image_bitmap_source_util.cc
- https://github.com/google/dawn/blob/620a520f5029e14b57a0b58096c022e339b1857b/src/dawn/native/CopyTextureForBrowserHelper.cpp

### 観察できたポイント
- **Blob**:
  - `ImageBitmapFactories::ImageBitmapLoader` が `FileReaderLoader` で Blob を読み、別スレッドで `ImageDecoder::Create` を実行。
  - `ResolvePromiseOnOriginalThread` で `SkImage` を生成し、`MakeGarbageCollected<ImageBitmap>(image, crop_rect, options)` に渡して Promise を解決。
  - `ImageDecoder` に `AlphaOption` / `ColorBehavior` を渡し、premultiply と color space の設定を **デコード時に反映**。
- **ImageData / CanvasImageSource**:
  - `image_bitmap_source_util.cc` で `SkBitmap` を作成する段階でピクセルを確定。
  - `GetSwSkImage()` / `asLegacyBitmap()` による **同期的なピクセル取得**が行われる。
- **ImageBitmap 生成時の変換**:
  - `ImageBitmap` の各コンストラクタで `ApplyTransformsFromOptions` を呼び出し、
    crop / flipY / resize / premultiply / color space 変換を適用する設計。
  - `ImageBitmap::ImageBitmap(ImageElementBase*)` では `ImageDecoder` を使って **デコード済みの SkImage** を作成してから変換。

### 解釈
- 実装コード上は `createImageBitmap` 内で `SkImage` を生成し `ApplyTransformsFromOptions` を通すため、変換処理が即時に見える。
- 一方、whatwg/html#11029 のコメント（ccameron-chromium、https://github.com/whatwg/html/issues/11029#issuecomment-2670999161）では以下を明言している:
  - ピクセル値を得るためのデコードは行う
  - ICC などのメタ情報は保持
  - 色変換・premultiply は描画時にオンザフライ（GPU ではほぼ無償、CPU ではキャッシュ/事前変換が必要）
- 具体的な実装として `static_bitmap_image_transform.cc` では、`StaticBitmapImageTransform::Apply` が変換の必要性（crop/resize/flip/色空間変換/premultiply）を判定し、必要なら以下の経路で実行する:
  - GPU 経路: `ApplyWithBlit` → `CanvasNon2DResourceProviderSharedImage` を用いた blit（premultiply 必須）
  - CPU 経路: `ApplyUsingPixmap` → `readPixels` + `scalePixels` + `FlipSkPixmapInPlace` + `reinterpretColorSpace`（CPU パスはここで確定）
- `GPUQueue.copyExternalImageToTexture` の下層（Dawn `CopyTextureForBrowserHelper.cpp`）では、WGSL で copy+変換を 1 パス化する設計が確認できる:
  - `copyExternalTexture` / `copyTexture` の fragment entry point を切り替えつつ、共通の `transform()` で処理。
  - `steps_mask` により以下の処理を必要時のみ有効化（不要ならスキップ）:
    - unpremultiply
    - decode to linear
    - gamut conversion（3x3 行列）
    - encode to gamma
    - premultiply
    - srgb 宛先向け decode
    - alpha=1 固定化（opaque 入力）
  - `flipY` は頂点側の `scale/offset` で吸収し、追加パスなしで座標変換。
- Dawn 側の性能上の工夫:
  - destination format ごとの render pipeline をキャッシュ（`copyTextureForBrowserPipelines` / `copyExternalTextureForBrowserPipelines`）。
  - shader module（`copyForBrowser`）を再利用し、都度生成を回避。
  - copySize が 0 の場合は no-op で早期 return。
  - 変換係数（transfer function / conversion matrix）を uniform にまとめ、GPU 側でまとめて適用。
- 補足:
  - Dawn ソースには「互換 format 間の direct copy fast path は将来最適化候補」という TODO がある（現状は主に render pass 経由の統一パス）。
- つまり Chromium は「decode 即時・メタ保持」を前提に、実際の copy/描画時に GPU 変換パスへ寄せ、**必要な変換だけを実行**することで性能と互換性を両立している。

## 7. 既存ブラウザ実装の確認（WebKit）
参照:
- https://raw.githubusercontent.com/WebKit/WebKit/main/Source/WebCore/html/ImageBitmap.cpp

### 観察できたポイント
- **Blob**:
  - `PendingImageBitmap` が `FileReaderLoader` で Blob を読み、`createFromBuffer` で `BitmapImage::create` + `setData` によりデコード。
  - `drawImage` を使って crop/resize/flip/方向補正を **Promise 解決前** に適用して `ImageBitmap` を生成。
- **ImageData**:
  - 変換不要なら `putPixelBuffer` で直接書き込み。
  - 変換が必要な場合は `ImageBuffer` にコピーして `drawImageBuffer` で crop/resize/flip を適用。
- **HTMLImageElement / Canvas / Video / ImageBitmap**:
  - いずれも `croppedSourceRectangleWithFormatting` と `outputSizeForSourceRectangle` でサイズ計算し、
    `ImageBuffer` に `drawImage` して確定した `ImageBitmap` を返す。
- **premultiplyAlpha / colorSpace**:
  - `alphaPremultiplicationForPremultiplyAlpha` を用いて premultiply の方針を決定し、描画時に反映。
  - `createImageBuffer` では `DestinationColorSpace` を選択して描画（色空間変換を含む）。

### 解釈
- WebKit も **createImageBitmap 内でデコードと変換処理を完了**させる設計。
- Promise 解決時には処理済みの `ImageBitmap` が返るため、遅延化は互換性差分になり得る。

## 深掘りまとめ（結論）
- 互換性重視のまま遅延を進めるなら「decode即時、後段遅延」が現実的。
- `Lazy` 保持メタ情報は「再現可能性」を軸に最小化する。
- `materialize()` を `ImageBitmap` に集約し、消費側の処理を統一するのが設計上安全。
- ヘッダ解析のみの完全遅延は、reject タイミングの変更が最大リスク。

## 定期まとめ（進捗メモ）
- 初期整理完了: main 実装・PR #28105 の読み取り・getData のテスト用途確認
- 追加整理: image crate のデコーダAPI（dimensions/orientation/icc）を確認
- たたき台: 遅延パイプライン案の作成
- 結論整理完了: 互換性重視は decode 即時・後段遅延、遅延強化は reject タイミング要評価
- 調査完了: 残タスクの深掘りと推奨方針を追記
